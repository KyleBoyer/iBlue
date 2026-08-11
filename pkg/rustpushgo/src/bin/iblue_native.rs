use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use keystore::keystore;
use rand::{rngs::OsRng, RngCore};
use rustpush::ids::user::IDSUserType;
use rustpushgo::{
    connect, create_config_from_hardware_key, create_config_from_hardware_key_with_device_id,
    create_local_macos_config, create_local_macos_config_with_device_id, deregister_account,
    init_logger, login_start, new_client, refresh_registration_once,
    restore_token_provider_with_pet_expiration, AccountPersistData, Client,
    LoginSession, MessageCallback, UpdateUsersCallback, WrappedAPSConnection, WrappedAPSState, WrappedAttachment,
    WrappedConversation, WrappedIDSNGMIdentity, WrappedIDSUsers, WrappedMessage, WrappedOSConfig,
    WrappedMultipartPart, WrappedTokenProvider,
};
use rustpushgo::util::plist_from_string;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

mod icloud_web;

use icloud_web::ICloudWebSession;

const PROTOCOL_VERSION: &str = "1";
const CREDENTIAL_ACCOUNT: &str = "ids-account";
const CREDENTIAL_FILE_MAGIC: &[u8] = b"IBLUE-CREDENTIAL-V1\0";
const CREDENTIAL_SERVICE_FILE: &str = "credential-service";

fn credential_service_for_state_dir(state_dir: &Path) -> String {
    let digest = Sha256::digest(state_dir.as_os_str().as_encoded_bytes());
    format!("app.iblue.ids.{}", hex::encode(digest))
}

fn valid_credential_service(service: &str) -> bool {
    let Some(digest) = service.strip_prefix("app.iblue.ids.") else {
        return false;
    };
    digest.len() == 64
        && digest
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn read_credential_service(path: &Path) -> Result<String, String> {
    let service = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read credential service identity: {error}"))?;
    let service = service.trim().to_string();
    if !valid_credential_service(&service) {
        return Err("credential service identity is invalid".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to protect credential service identity: {error}"))?;
    }
    Ok(service)
}

fn load_or_create_credential_service(state_dir: &Path) -> Result<String, String> {
    let path = state_dir.join(CREDENTIAL_SERVICE_FILE);
    if path.exists() {
        return read_credential_service(&path);
    }

    // Preserve the legacy path-derived service for an existing profile's first
    // upgraded run, then persist it inside the native state directory. Moving
    // that complete directory to Linux, Windows, or /data in a container now
    // carries the AES-GCM associated-data identity with its ciphertext instead
    // of silently deriving a different service from the destination path.
    let service = credential_service_for_state_dir(state_dir);
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(format!("{service}\n").as_bytes())
                .map_err(|error| format!("failed to write credential service identity: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("failed to sync credential service identity: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))
                    .map_err(|error| format!("failed to protect credential service identity: {error}"))?;
            }
            Ok(service)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_credential_service(&path)
        }
        Err(error) => Err(format!("failed to create credential service identity: {error}")),
    }
}

fn registration_backend() -> (&'static str, bool, Option<String>) {
    #[cfg(all(target_os = "macos", feature = "nac-apple-framework"))]
    {
        return ("apple-aaabsinthe-framework", true, None);
    }
    #[cfg(feature = "cleanroom-registration")]
    {
        let diagnostic = open_absinthe::nac::backend_diagnostic();
        return ("unicorn-imdappleservices-external", diagnostic.is_ok(), diagnostic.err());
    }
    #[allow(unreachable_code)]
    (
        "unavailable-public-source",
        false,
        Some("no NAC registration backend was compiled".into()),
    )
}

enum CredentialBackend {
    Os,
    EncryptedFile { path: PathBuf, key: [u8; 32] },
}

impl CredentialBackend {
    fn from_environment(state_dir: &Path) -> Result<Self, String> {
        let Some(key_path) = std::env::var_os("IBLUE_CREDENTIAL_KEY_FILE") else {
            return Ok(Self::Os);
        };
        Self::from_key_path(state_dir, Path::new(&key_path))
    }

    fn from_key_path(state_dir: &Path, key_path: &Path) -> Result<Self, String> {
        let raw = std::fs::read(&key_path).map_err(|error| {
            format!(
                "failed to read credential key file {}: {error}",
                key_path.display()
            )
        })?;
        let key = decode_credential_key(&raw)?;
        Ok(Self::EncryptedFile {
            path: state_dir.join("credentials.enc"),
            key,
        })
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Os => {
                #[cfg(target_os = "macos")]
                return "macos-keychain";
                #[cfg(target_os = "windows")]
                return "windows-credential-manager";
                #[cfg(all(unix, not(target_os = "macos")))]
                return "secret-service";
                #[allow(unreachable_code)]
                "os-credential-store"
            }
            Self::EncryptedFile { .. } => "encrypted-file",
        }
    }

    fn modified_at_ms(&self) -> Option<u64> {
        let Self::EncryptedFile { path, .. } = self else {
            return None;
        };
        std::fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis() as u64)
    }

    fn load(&self, service: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::Os => {
                let entry = keyring::Entry::new(service, CREDENTIAL_ACCOUNT)
                    .map_err(|error| format!("credential store is unavailable: {error}"))?;
                match entry.get_secret() {
                    Ok(value) => Ok(Some(value)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(error) => Err(format!(
                        "failed to read iBlue account from the credential store: {error}"
                    )),
                }
            }
            Self::EncryptedFile { path, key } => {
                let value = match std::fs::read(path) {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => {
                        return Err(format!(
                            "failed to read encrypted credential file {}: {error}",
                            path.display()
                        ))
                    }
                };
                if value.len() < CREDENTIAL_FILE_MAGIC.len() + 12
                    || !value.starts_with(CREDENTIAL_FILE_MAGIC)
                {
                    return Err("encrypted credential file has an invalid header".to_string());
                }
                let nonce_start = CREDENTIAL_FILE_MAGIC.len();
                let nonce_end = nonce_start + 12;
                let cipher = Aes256Gcm::new_from_slice(key)
                    .map_err(|error| format!("invalid credential key: {error}"))?;
                cipher
                    .decrypt(
                        Nonce::from_slice(&value[nonce_start..nonce_end]),
                        Payload {
                            msg: &value[nonce_end..],
                            aad: service.as_bytes(),
                        },
                    )
                    .map(Some)
                    .map_err(|_| "encrypted credential file could not be authenticated".to_string())
            }
        }
    }

    fn store(&self, service: &str, value: &[u8]) -> Result<(), String> {
        match self {
            Self::Os => {
                let entry = keyring::Entry::new(service, CREDENTIAL_ACCOUNT)
                    .map_err(|error| format!("credential store is unavailable: {error}"))?;
                entry.set_secret(value).map_err(|error| {
                    format!("failed to save iBlue account in the credential store: {error}")
                })
            }
            Self::EncryptedFile { path, key } => {
                let mut nonce = [0u8; 12];
                OsRng.fill_bytes(&mut nonce);
                let cipher = Aes256Gcm::new_from_slice(key)
                    .map_err(|error| format!("invalid credential key: {error}"))?;
                let ciphertext = cipher
                    .encrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: value,
                            aad: service.as_bytes(),
                        },
                    )
                    .map_err(|_| "failed to encrypt credential record".to_string())?;
                let mut output = Vec::with_capacity(
                    CREDENTIAL_FILE_MAGIC.len() + nonce.len() + ciphertext.len(),
                );
                output.extend_from_slice(CREDENTIAL_FILE_MAGIC);
                output.extend_from_slice(&nonce);
                output.extend_from_slice(&ciphertext);
                let parent = path.parent().ok_or_else(|| {
                    format!("encrypted credential path {} has no parent", path.display())
                })?;
                let mut temporary =
                    tempfile::NamedTempFile::new_in(parent).map_err(|error| {
                        format!("failed to create encrypted credential file: {error}")
                    })?;
                temporary.write_all(&output).map_err(|error| {
                    format!("failed to write encrypted credential file: {error}")
                })?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    temporary
                        .as_file()
                        .set_permissions(std::fs::Permissions::from_mode(0o600))
                        .map_err(|error| format!("failed to protect credential file: {error}"))?;
                }
                temporary.as_file().sync_all().map_err(|error| {
                    format!("failed to sync encrypted credential file: {error}")
                })?;
                // NamedTempFile uses rename(2) on Unix and MoveFileExW with
                // MOVEFILE_REPLACE_EXISTING on Windows. A failed replacement
                // therefore leaves the previous credential intact instead of
                // deleting it before a second, fallible rename.
                temporary.persist(path).map_err(|error| {
                    format!("failed to install encrypted credential file: {}", error.error)
                })?;
                Ok(())
            }
        }
    }

    fn delete(&self, service: &str) -> Result<(), String> {
        match self {
            Self::Os => {
                let entry = keyring::Entry::new(service, CREDENTIAL_ACCOUNT)
                    .map_err(|error| format!("credential store is unavailable: {error}"))?;
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(format!(
                        "failed to delete the iBlue account from the credential store: {error}"
                    )),
                }
            }
            Self::EncryptedFile { path, .. } => match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!(
                    "failed to delete encrypted credential file {}: {error}",
                    path.display()
                )),
            },
        }
    }
}

fn decode_credential_key(raw: &[u8]) -> Result<[u8; 32], String> {
    let decoded = if raw.len() == 32 {
        raw.to_vec()
    } else {
        let text = std::str::from_utf8(raw)
            .map_err(|_| "credential key must be 32 raw bytes, 64 hex characters, or base64".to_string())?
            .trim();
        if text.len() == 64 {
            hex::decode(text).map_err(|error| format!("invalid hex credential key: {error}"))?
        } else {
            BASE64
                .decode(text)
                .map_err(|error| format!("invalid base64 credential key: {error}"))?
        }
    };
    decoded.try_into().map_err(|value: Vec<u8>| {
        format!("credential key must decode to exactly 32 bytes, got {}", value.len())
    })
}

#[derive(Clone)]
struct Emitter {
    lock: Arc<Mutex<()>>,
}

impl Emitter {
    fn new() -> Self {
        Self {
            lock: Arc::new(Mutex::new(())),
        }
    }

    fn write(&self, value: &Value) {
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        let mut stdout = std::io::stdout().lock();
        if serde_json::to_writer(&mut stdout, value).is_ok() {
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }

    fn notification(&self, method: &str, params: Value) {
        self.write(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }
}

#[derive(Deserialize)]
struct RpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug)]
struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn invalid_state(message: impl Into<String>) -> Self {
        Self {
            code: -32001,
            message: message.into(),
        }
    }

    fn native(error: impl std::fmt::Display) -> Self {
        Self {
            code: -32000,
            message: error.to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountState {
    username: String,
    hashed_password_hex: String,
    pet: String,
    #[serde(default)]
    pet_expires_at_ms: u64,
    #[serde(default)]
    mme_delegate_json: Option<String>,
    adsid: String,
    dsid: String,
    spd_base64: String,
    #[serde(default)]
    icloud_web_session: Option<ICloudWebSession>,
}

impl From<AccountPersistData> for AccountState {
    fn from(value: AccountPersistData) -> Self {
        Self {
            username: value.username,
            hashed_password_hex: value.hashed_password_hex,
            pet: value.pet,
            pet_expires_at_ms: value.pet_expires_at_ms,
            mme_delegate_json: value.mme_delegate_json,
            adsid: value.adsid,
            dsid: value.dsid,
            spd_base64: value.spd_base64,
            icloud_web_session: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    device_id: Option<String>,
    aps_state: Option<String>,
    users: Option<String>,
    identity: Option<String>,
    account: Option<AccountState>,
    hardware_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStartParams {
    apple_id: String,
    password: String,
}

#[derive(Deserialize)]
struct TwoFactorParams {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactorSmsParams {
    phone_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICloudWebSmsParams {
    phone_id: i64,
    #[serde(default)]
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICloudWebTwoFactorParams {
    code: String,
    phone_id: Option<i64>,
    #[serde(default)]
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ICloudPhotoShareCreateParams {
    path: String,
    filename: String,
    mime_type: String,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeychainJoinParams {
    passcode: String,
    device_index: Option<u32>,
}

#[derive(Deserialize)]
struct LogoutParams {
    deregister: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialMigrationParams {
    key_path: String,
}

#[derive(Deserialize)]
struct RegistrationInspectParams {
    users: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationParams {
    participants: Vec<String>,
    group_name: Option<String>,
    sender_guid: Option<String>,
    #[serde(default)]
    is_sms: bool,
}

impl From<ConversationParams> for WrappedConversation {
    fn from(value: ConversationParams) -> Self {
        Self {
            participants: value.participants,
            group_name: value.group_name,
            sender_guid: value.sender_guid,
            is_sms: value.is_sms,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageParams {
    conversation: ConversationParams,
    text: String,
    from: Option<String>,
    html: Option<String>,
    subject: Option<String>,
    effect_id: Option<String>,
    reply_guid: Option<String>,
    reply_part: Option<String>,
    scheduled_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendReactionParams {
    conversation: ConversationParams,
    target_uuid: String,
    #[serde(default)]
    target_part: u64,
    target_text: Option<String>,
    reaction: String,
    emoji: Option<String>,
    #[serde(default)]
    remove: bool,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendStickerReactionParams {
    conversation: ConversationParams,
    target_uuid: String,
    #[serde(default)]
    target_part: u64,
    target_text: Option<String>,
    path: String,
    mime_type: String,
    uti_type: String,
    filename: Option<String>,
    source: String,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendPollVoteParams {
    conversation: ConversationParams,
    target_uuid: String,
    session_id: String,
    poll_response_json: String,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendAttachmentParams {
    conversation: ConversationParams,
    path: String,
    mime_type: String,
    uti_type: String,
    filename: Option<String>,
    from: Option<String>,
    reply_guid: Option<String>,
    reply_part: Option<String>,
    caption: Option<String>,
    effect_id: Option<String>,
    #[serde(default)]
    is_audio_message: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMultipartPartParams {
    part_index: u64,
    text: Option<String>,
    mention: Option<String>,
    path: Option<String>,
    mime_type: Option<String>,
    uti_type: Option<String>,
    filename: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMultipartMessageParams {
    conversation: ConversationParams,
    parts: Vec<SendMultipartPartParams>,
    from: Option<String>,
    subject: Option<String>,
    effect_id: Option<String>,
    reply_guid: Option<String>,
    reply_part: Option<String>,
    #[serde(default)]
    dd_scan: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupRenameParams {
    conversation: ConversationParams,
    new_name: String,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupParticipantsParams {
    conversation: ConversationParams,
    new_participants: Vec<String>,
    group_version: u64,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupLeaveParams {
    conversation: ConversationParams,
    group_version: u64,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupIconParams {
    conversation: ConversationParams,
    group_version: u64,
    path: Option<String>,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateHandlesParams {
    addresses: Vec<String>,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindMyFollowingParams {
    address: Option<String>,
    #[serde(default)]
    find_my_ids: Vec<String>,
    // Backward compatibility for callers built against the first extension.
    find_my_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendEditParams {
    conversation: ConversationParams,
    target_uuid: String,
    #[serde(default)]
    target_part: u64,
    text: String,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendUnsendParams {
    conversation: ConversationParams,
    target_uuid: String,
    #[serde(default)]
    target_part: u64,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendTypingParams {
    conversation: ConversationParams,
    active: bool,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendReadReceiptParams {
    conversation: ConversationParams,
    for_uuid: String,
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationControlParams {
    conversation: ConversationParams,
    for_uuid: String,
    from: Option<String>,
}

struct NativeMessageCallback {
    emitter: Emitter,
}

impl MessageCallback for NativeMessageCallback {
    fn on_message(&self, message: WrappedMessage) {
        self.emitter
            .notification("message.received", message_to_json(message));
    }
}

struct NativeUsersCallback {
    emitter: Emitter,
    users: Arc<RwLock<Option<Arc<WrappedIDSUsers>>>>,
}

impl UpdateUsersCallback for NativeUsersCallback {
    fn update_users(&self, users: Arc<WrappedIDSUsers>) {
        let serialized = users.to_string();
        let handles = users.get_handles();
        if let Ok(mut current) = self.users.write() {
            *current = Some(users);
        }
        self.emitter.notification(
            "account.stateChanged",
            json!({ "users": serialized, "handles": handles }),
        );
    }
}

fn attachment_to_json(attachment: WrappedAttachment) -> Value {
    json!({
        "mimeType": attachment.mime_type,
        "filename": attachment.filename,
        "utiType": attachment.uti_type,
        "size": attachment.size,
        "isInline": attachment.is_inline,
        "dataBase64": attachment.inline_data.map(|data| BASE64.encode(data)),
        "iris": attachment.iris,
        "isSticker": attachment.is_sticker,
        "audioTranscription": attachment.audio_transcription,
        "mmcsDescriptorJson": attachment.mmcs_descriptor_json,
    })
}

fn message_to_json(message: WrappedMessage) -> Value {
    let attachments = message
        .attachments
        .into_iter()
        .map(attachment_to_json)
        .collect::<Vec<_>>();
    let tapback = message.is_tapback.then(|| {
        json!({
            "type": message.tapback_type,
            "targetUuid": message.tapback_target_uuid,
            "targetPart": message.tapback_target_part,
            "emoji": message.tapback_emoji,
            "remove": message.tapback_remove,
        })
    });
    let edit = message.is_edit.then(|| {
        json!({
            "targetUuid": message.edit_target_uuid,
            "part": message.edit_part,
            "text": message.edit_new_text,
        })
    });
    let unsend = message.is_unsend.then(|| {
        json!({
            "targetUuid": message.unsend_target_uuid,
            "part": message.unsend_edit_part,
        })
    });
    let reply = (message.reply_guid.is_some() || message.reply_part.is_some()).then(|| {
        json!({ "guid": message.reply_guid, "part": message.reply_part })
    });
    let typing = message.is_typing.then(|| {
        json!({
            "active": message.typing_active.unwrap_or(true),
            "appBundleId": message.typing_app_bundle_id,
        })
    });
    let error = message.is_error.then(|| {
        json!({
            "forUuid": message.error_for_uuid,
            "status": message.error_status,
            "message": message.error_status_str,
        })
    });
    let shared_profile = message.is_share_profile.then(|| {
        json!({
            "displayName": message.share_profile_display_name,
            "firstName": message.share_profile_first_name,
            "lastName": message.share_profile_last_name,
            "hasPoster": message.share_profile_has_poster,
            "avatarBase64": message.share_profile_avatar.map(|data| BASE64.encode(data)),
        })
    });
    let app_balloon = (message.app_balloon_bundle_id.is_some()
        || message.app_balloon_url.is_some())
        .then(|| {
            json!({
                "bundleId": message.app_balloon_bundle_id,
                "appName": message.app_balloon_app_name,
                "url": message.app_balloon_url,
                "sessionId": message.app_balloon_session_id,
                "isLive": message.app_balloon_is_live,
                "ldText": message.app_balloon_ld_text,
                "imageTitle": message.app_balloon_image_title,
                "imageSubtitle": message.app_balloon_image_subtitle,
                "caption": message.app_balloon_caption,
                "subcaption": message.app_balloon_subcaption,
                "secondarySubcaption": message.app_balloon_secondary_subcaption,
                "tertiarySubcaption": message.app_balloon_tertiary_subcaption,
            })
        });

    json!({
        "uuid": message.uuid,
        "sender": message.sender,
        "text": message.text,
        "subject": message.subject,
        "participants": message.participants,
        "groupName": message.group_name,
        "senderGuid": message.sender_guid,
        "timestampMs": message.timestamp_ms,
        "isSms": message.is_sms,
        "isStoredMessage": message.is_stored_message,
        "verificationFailed": message.verification_failed,
        "attachments": attachments,
        "tapback": tapback,
        "edit": edit,
        "unsend": unsend,
        "reply": reply,
        "typing": typing,
        "readReceipt": message.is_read_receipt.then_some(true),
        "delivered": message.is_delivered.then_some(true),
        "error": error,
        "groupRename": message.is_rename.then(|| json!({ "name": message.new_chat_name })),
        "participantChange": message.is_participant_change.then(|| json!({
            "participants": message.new_participants,
            "groupVersion": message.participant_group_version,
        })),
        "groupIconChange": message.is_icon_change.then(|| json!({
            "cleared": message.group_photo_cleared,
            "dataBase64": message.icon_change_photo_data.map(|data| BASE64.encode(data)),
            "mimeType": "image/jpeg",
            "groupVersion": message.group_icon_version,
        })),
        "markUnread": message.is_mark_unread.then_some(true),
        "notifyAnyway": message.is_notify_anyways.then_some(true),
        "effect": message.effect,
        "html": message.html,
        "isVoice": message.is_voice,
        "sharedProfile": shared_profile,
        "appBalloon": app_balloon,
    })
}

const REQUIRED_REGISTRATION_SERVICES: [&str; 4] = [
    "com.apple.madrid",
    "com.apple.private.alloy.multiplex1",
    "com.apple.private.alloy.facetime.multi",
    "com.apple.ess",
];

fn key_material_available(alias: &str) -> bool {
    keystore().get_key_type(alias).ok().flatten().is_some()
}

/// Inspect the persisted IDS registration without initializing APS or loading
/// the Apple Account credential. The serialized registration contains private
/// key aliases, but this response deliberately exposes only presence booleans
/// and public-certificate/state fingerprints.
fn inspect_registration(serialized: &str) -> Result<Value, RpcError> {
    if serialized.trim().is_empty() {
        return Err(RpcError::invalid_params("users must contain a saved IDS registration"));
    }
    let users: Vec<rustpush::IDSUser> = plist_from_string(serialized)
        .map_err(|error| RpcError::invalid_params(format!("saved IDS registration is invalid: {error}")))?;
    let mut sending_handles = std::collections::BTreeSet::new();
    let mut warnings = Vec::new();
    let mut all_key_material_available = !users.is_empty();
    let mut complete_service_bundle = !users.is_empty();
    let mut locally_usable_for_madrid = false;
    let mut user_rows = Vec::with_capacity(users.len());

    if users.is_empty() {
        warnings.push("saved registration contains no IDS users".to_string());
    }

    for (user_index, user) in users.iter().enumerate() {
        let auth_key_available = key_material_available(&user.auth_keypair.private.0);
        all_key_material_available &= auth_key_available;
        if !auth_key_available {
            warnings.push(format!("user {} is missing its local IDS authentication private key", user_index + 1));
        }

        let missing_services = REQUIRED_REGISTRATION_SERVICES
            .iter()
            .filter(|service| !user.registration.contains_key(**service))
            .map(|service| (*service).to_string())
            .collect::<Vec<_>>();
        if !missing_services.is_empty() {
            complete_service_bundle = false;
            warnings.push(format!(
                "user {} is missing required IDS services: {}",
                user_index + 1,
                missing_services.join(", ")
            ));
        }

        let mut registrations = user.registration.iter().collect::<Vec<_>>();
        registrations.sort_by(|(left, _), (right, _)| left.cmp(right));
        let mut service_rows = Vec::with_capacity(registrations.len());
        for (service, registration) in registrations {
            let service_key_available = key_material_available(&registration.id_keypair.private.0);
            all_key_material_available &= service_key_available;
            if !service_key_available {
                warnings.push(format!(
                    "user {} service {} is missing its local IDS signing private key",
                    user_index + 1,
                    service
                ));
            }
            let seconds_until_reregister = registration.calculate_rereg_time_s().ok();
            if seconds_until_reregister.is_none() {
                warnings.push(format!(
                    "user {} service {} has an unreadable certificate expiration",
                    user_index + 1,
                    service
                ));
            } else if seconds_until_reregister.is_some_and(|seconds| seconds <= 0) {
                warnings.push(format!(
                    "user {} service {} is due for re-registration",
                    user_index + 1,
                    service
                ));
            }
            if service == "com.apple.madrid" {
                sending_handles.extend(registration.handles.iter().cloned());
                locally_usable_for_madrid |= auth_key_available
                    && service_key_available
                    && !registration.handles.is_empty()
                    && seconds_until_reregister.is_some_and(|seconds| seconds > 0);
            }
            service_rows.push(json!({
                "service": service,
                "handles": registration.handles,
                "registeredAtEpochSeconds": (registration.registered_at_s > 0)
                    .then_some(registration.registered_at_s),
                "heartbeatIntervalSeconds": registration.heartbeat_interval_s,
                "secondsUntilReregister": seconds_until_reregister,
                "renewalState": match seconds_until_reregister {
                    Some(seconds) if seconds > 0 => "active",
                    Some(_) => "due",
                    None => "unknown",
                },
                "certificateSha256": hex::encode(Sha256::digest(&registration.id_keypair.cert)),
                "dataHashHex": format!("{:016x}", registration.data_hash),
                "keyMaterialAvailable": service_key_available,
            }));
        }

        if !user.registration.contains_key("com.apple.madrid") {
            warnings.push(format!("user {} has no iMessage (com.apple.madrid) registration", user_index + 1));
        }
        user_rows.push(json!({
            "userIndex": user_index + 1,
            "userType": match &user.user_type {
                IDSUserType::Apple => "apple",
                IDSUserType::Phone => "phone",
            },
            "protocolVersion": user.protocol_version,
            "authKeyMaterialAvailable": auth_key_available,
            "missingRequiredServices": missing_services,
            "services": service_rows,
        }));
    }

    if sending_handles.is_empty() {
        warnings.push("saved registration has no iMessage sending handles".to_string());
    }

    Ok(json!({
        "mode": "offline",
        "appleNetworkAccessed": false,
        "accountCredentialAccessed": false,
        "softwareKeystoreRead": true,
        "savedStateSha256": hex::encode(Sha256::digest(serialized.as_bytes())),
        "userCount": users.len(),
        "sendingHandles": sending_handles.into_iter().collect::<Vec<_>>(),
        "requiredServices": REQUIRED_REGISTRATION_SERVICES,
        "completeServiceBundle": complete_service_bundle,
        "allKeyMaterialAvailable": all_key_material_available,
        "locallyUsableForMadrid": locally_usable_for_madrid,
        "users": user_rows,
        "warnings": warnings,
    }))
}

struct Engine {
    emitter: Emitter,
    config: Option<Arc<WrappedOSConfig>>,
    connection: Option<Arc<WrappedAPSConnection>>,
    users: Arc<RwLock<Option<Arc<WrappedIDSUsers>>>>,
    identity: Option<Arc<WrappedIDSNGMIdentity>>,
    token_provider: Option<Arc<WrappedTokenProvider>>,
    account: Option<AccountState>,
    login_session: Option<Arc<LoginSession>>,
    client: Option<Arc<Client>>,
    state_dir: PathBuf,
    credential_service: String,
    credential_backend: CredentialBackend,
}

impl Engine {
    fn new(emitter: Emitter, state_dir: &Path) -> Result<Self, RpcError> {
        let credential_service =
            load_or_create_credential_service(state_dir).map_err(RpcError::native)?;
        let credential_backend = CredentialBackend::from_environment(state_dir).map_err(RpcError::native)?;
        Ok(Self {
            emitter,
            config: None,
            connection: None,
            users: Arc::new(RwLock::new(None)),
            identity: None,
            token_provider: None,
            account: None,
            login_session: None,
            client: None,
            state_dir: state_dir.to_path_buf(),
            credential_service,
            credential_backend,
        })
    }

    fn load_account_secret(&self) -> Result<Option<AccountState>, RpcError> {
        let Some(value) = self.credential_backend
            .load(&self.credential_service)
            .map_err(RpcError::native)? else {
                return Ok(None);
            };
        let mut account: AccountState = serde_json::from_slice(&value)
            .map_err(|error| RpcError::native(format!("invalid iBlue credential entry: {error}")))?;

        // Version-0 encrypted records did not persist the PET expiry. If such
        // a record was just written by a successful interactive login, migrate
        // it once using the credential file's trusted local mtime. Older files
        // remain expired and follow the existing password-refresh path.
        if account.pet_expires_at_ms == 0 {
            const RECENT_LOGIN_WINDOW_MS: u64 = 30 * 60 * 1000;
            const MIGRATED_PET_LIFETIME_MS: u64 = 20 * 60 * 60 * 1000;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if let Some(modified_at_ms) = self.credential_backend.modified_at_ms()
                .filter(|modified_at_ms| now_ms.saturating_sub(*modified_at_ms) <= RECENT_LOGIN_WINDOW_MS)
            {
                account.pet_expires_at_ms = modified_at_ms + MIGRATED_PET_LIFETIME_MS;
                self.store_account_secret(&account)?;
            }
        }

        Ok(Some(account))
    }

    fn store_account_secret(&self, account: &AccountState) -> Result<(), RpcError> {
        let value = serde_json::to_vec(account).map_err(RpcError::native)?;
        self.credential_backend
            .store(&self.credential_service, &value)
            .map_err(RpcError::native)
    }

    fn config(&self) -> Result<Arc<WrappedOSConfig>, RpcError> {
        self.config
            .clone()
            .ok_or_else(|| RpcError::invalid_state("engine is not initialized"))
    }

    fn connection(&self) -> Result<Arc<WrappedAPSConnection>, RpcError> {
        self.connection
            .clone()
            .ok_or_else(|| RpcError::invalid_state("engine is not initialized"))
    }

    fn users(&self) -> Result<Arc<WrappedIDSUsers>, RpcError> {
        self.users
            .read()
            .map_err(|_| RpcError::invalid_state("users state lock is poisoned"))?
            .clone()
            .ok_or_else(|| RpcError::invalid_state("profile is not logged in"))
    }

    fn client(&self) -> Result<Arc<Client>, RpcError> {
        self.client
            .clone()
            .ok_or_else(|| RpcError::invalid_state("client is not started"))
    }

    fn sender(&self, requested: Option<String>) -> Result<String, RpcError> {
        if let Some(sender) = requested.filter(|value| !value.is_empty()) {
            return Ok(sender);
        }
        self.users()?
            .get_handles()
            .into_iter()
            .next()
            .ok_or_else(|| RpcError::invalid_state("the account has no registered sending handle"))
    }

    async fn snapshot(&self) -> Result<Value, RpcError> {
        let config = self.config()?;
        let connection = self.connection()?;
        let aps_state = connection.state().await.to_string();
        let users = self
            .users
            .read()
            .map_err(|_| RpcError::invalid_state("users state lock is poisoned"))?
            .clone();
        let handles = users
            .as_ref()
            .map(|value| value.get_handles())
            .unwrap_or_default();
        Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "deviceId": config.get_device_id(),
            "apsState": aps_state,
            "users": users.as_ref().map(|value| value.to_string()),
            "identity": self.identity.as_ref().map(|value| value.to_string()),
            "accountUsername": self.account.as_ref().map(|value| value.username.clone()),
            "credentialBackend": self.credential_backend.name(),
            "idsMode": if std::env::var_os("IBLUE_IDS_PASSIVE").is_some() { "passive" } else { "normal" },
            "handles": handles,
            "clientStarted": self.client.is_some(),
            "secondsSinceLastInbound": connection.seconds_since_last_inbound(),
        }))
    }

    async fn handle(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if std::env::var_os("IBLUE_OFFLINE_ONLY").is_some()
            && !matches!(
                method,
                "system.version" | "account.registration.inspect" | "system.shutdown"
            )
        {
            return Err(RpcError::invalid_state(format!(
                "offline-only native mode refuses method {method}"
            )));
        }
        match method {
            "system.version" => {
                // Resolve this once: the portable diagnostic reads and hashes
                // the external binary, so repeated tuple access is not free.
                let (registration_backend, registration_available, registration_detail) =
                    registration_backend();
                Ok(json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "engine": "rustpush",
                    "platform": std::env::consts::OS,
                    "architecture": std::env::consts::ARCH,
                    "registrationBackend": registration_backend,
                    "registrationAvailable": registration_available,
                    "registrationDetail": registration_detail,
                    "hardwareKeyRequired": !cfg!(target_os = "macos"),
                }))
            }
            "account.registration.inspect" => {
                let params: RegistrationInspectParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                inspect_registration(&params.users)
            }
            "system.initialize" => {
                if self.connection.is_some() {
                    return Err(RpcError::invalid_state("engine is already initialized"));
                }
                let params: InitializeParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let device_id = params.device_id.filter(|value| !value.is_empty());
                let config = match (params.hardware_key, device_id) {
                    (Some(hardware_key), Some(device_id)) => {
                        create_config_from_hardware_key_with_device_id(hardware_key, device_id)
                    }
                    (Some(hardware_key), None) => create_config_from_hardware_key(hardware_key),
                    (None, Some(device_id)) => create_local_macos_config_with_device_id(device_id),
                    (None, None) => create_local_macos_config(),
                }
                .map_err(RpcError::native)?;
                let aps_state = WrappedAPSState::new(params.aps_state);
                let connection = connect(&config, &aps_state).await;

                let users = params.users.map(|value| WrappedIDSUsers::new(Some(value)));
                let identity = params
                    .identity
                    .map(|value| WrappedIDSNGMIdentity::new(Some(value)));
                let account = match params.account {
                    Some(account) => {
                        self.store_account_secret(&account)?;
                        Some(account)
                    }
                    None => self.load_account_secret()?,
                };
                let token_provider = if let Some(account) = account.as_ref() {
                    Some(
                        restore_token_provider_with_pet_expiration(
                            &config,
                            &connection,
                            account.username.clone(),
                            account.hashed_password_hex.clone(),
                            account.pet.clone(),
                            account.spd_base64.clone(),
                            account.pet_expires_at_ms,
                            account.mme_delegate_json.clone(),
                        )
                        .await
                        .map_err(RpcError::native)?,
                    )
                } else {
                    None
                };

                if let Ok(mut current) = self.users.write() {
                    *current = users;
                }
                self.config = Some(config);
                self.connection = Some(connection);
                self.identity = identity;
                self.token_provider = token_provider;
                self.account = account;
                self.snapshot().await
            }
            "system.snapshot" => self.snapshot().await,
            "system.health" => {
                let connection = self.connection()?;
                Ok(json!({
                    "clientStarted": self.client.is_some(),
                    "secondsSinceLastInbound": connection.seconds_since_last_inbound(),
                }))
            }
            "icloud.web.status" => {
                let account = self.account.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("profile is not logged in")
                })?;
                let status = account
                    .icloud_web_session
                    .as_ref()
                    .map(|session| session.status(false))
                    .unwrap_or_else(|| ICloudWebSession::default().status(false));
                serde_json::to_value(status).map_err(RpcError::native)
            }
            "icloud.web.login.start" => {
                let account = self.account.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("profile is not logged in")
                })?;
                let username = account.username.clone();
                let hashed_password_hex = account.hashed_password_hex.clone();
                let mut web = account.icloud_web_session.clone().unwrap_or_default();
                let status = web
                    .begin_login(&username, &hashed_password_hex)
                    .await
                    .map_err(RpcError::native)?;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                serde_json::to_value(status).map_err(RpcError::native)
            }
            "icloud.web.login.2fa.options" => {
                let mut web = self
                    .account
                    .as_ref()
                    .and_then(|account| account.icloud_web_session.clone())
                    .ok_or_else(|| {
                        RpcError::invalid_state("there is no pending iCloud web login")
                    })?;
                let phones = web.phone_options().await.map_err(RpcError::native)?;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                Ok(json!({ "phones": phones }))
            }
            "icloud.web.login.2fa.requestSms" => {
                let params: ICloudWebSmsParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let mut web = self
                    .account
                    .as_ref()
                    .and_then(|account| account.icloud_web_session.clone())
                    .ok_or_else(|| {
                        RpcError::invalid_state("there is no pending iCloud web login")
                    })?;
                web.request_sms(params.phone_id, &params.mode)
                    .await
                    .map_err(RpcError::native)?;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                Ok(json!({ "sent": true }))
            }
            "icloud.web.login.submit2fa" => {
                let params: ICloudWebTwoFactorParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let mut web = self
                    .account
                    .as_ref()
                    .and_then(|account| account.icloud_web_session.clone())
                    .ok_or_else(|| {
                        RpcError::invalid_state("there is no pending iCloud web login")
                    })?;
                let sms = params.phone_id.map(|phone_id| (phone_id, params.mode));
                let status = web
                    .submit_2fa(&params.code, sms)
                    .await
                    .map_err(RpcError::native)?;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                serde_json::to_value(status).map_err(RpcError::native)
            }
            "icloud.web.photos.prepare" => {
                let mut web = self
                    .account
                    .as_ref()
                    .and_then(|account| account.icloud_web_session.clone())
                    .ok_or_else(|| {
                        RpcError::invalid_state(
                            "iCloud Photos web access is not enrolled; run icloud-web-setup first",
                        )
                    })?;
                let result = web.prepare_photos().await;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                let status = result.map_err(RpcError::native)?;
                serde_json::to_value(status).map_err(RpcError::native)
            }
            "icloud.photos.share.create" => {
                let params: ICloudPhotoShareCreateParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let account = self.account.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("profile is not logged in")
                })?;
                let dsid = account.dsid.clone();
                let mut web = account.icloud_web_session.clone().ok_or_else(|| {
                    RpcError::invalid_state(
                        "iCloud Photos web access is not enrolled; run icloud-web-setup first",
                    )
                })?;
                let share = web
                    .create_photo_share(
                        &dsid,
                        Path::new(&params.path),
                        &params.filename,
                        &params.mime_type,
                        &params.title,
                    )
                    .await
                    .map_err(RpcError::native)?;
                let persisted = {
                    let account = self.account.as_mut().ok_or_else(|| {
                        RpcError::invalid_state("profile is not logged in")
                    })?;
                    account.icloud_web_session = Some(web);
                    account.clone()
                };
                self.store_account_secret(&persisted)?;
                serde_json::to_value(share).map_err(RpcError::native)
            }
            "account.keychain.devices" => {
                let token_provider = self.token_provider.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("there is no loaded Apple account")
                })?;
                let devices = token_provider
                    .get_escrow_devices()
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({
                    "devices": devices.into_iter().map(|device| json!({
                        "index": device.index,
                        "name": device.device_name,
                        "model": device.device_model,
                    })).collect::<Vec<_>>()
                }))
            }
            "account.keychain.join" => {
                let params: KeychainJoinParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                if params.passcode.is_empty() {
                    return Err(RpcError::invalid_params("passcode must not be empty"));
                }
                let token_provider = self.token_provider.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("there is no loaded Apple account")
                })?;
                let result = match params.device_index {
                    Some(device_index) => token_provider
                        .join_keychain_clique_for_device(params.passcode, device_index)
                        .await,
                    None => token_provider.join_keychain_clique(params.passcode).await,
                }
                .map_err(RpcError::native)?;
                Ok(json!({ "joined": true, "detail": result }))
            }
            "account.login.start" => {
                let params: LoginStartParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let session = login_start(
                    params.apple_id,
                    params.password,
                    self.config()?.as_ref(),
                    self.connection()?.as_ref(),
                )
                .await
                .map_err(RpcError::native)?;
                let needs_2fa = session.needs_2fa();
                let challenge = if needs_2fa {
                    Some(session.two_factor_kind())
                } else {
                    None
                };
                self.login_session = Some(session);
                Ok(json!({ "needs2fa": needs_2fa, "challenge": challenge }))
            }
            "account.login.2fa.options" => {
                let session = self.login_session.clone().ok_or_else(|| {
                    RpcError::invalid_state("there is no active login session")
                })?;
                let options = session
                    .two_factor_phone_options()
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({
                    "phones": options.into_iter().map(|phone| json!({
                        "id": phone.id,
                        "lastTwoDigits": phone.last_two_digits,
                    })).collect::<Vec<_>>()
                }))
            }
            "account.login.2fa.requestSms" => {
                let params: TwoFactorSmsParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let session = self.login_session.clone().ok_or_else(|| {
                    RpcError::invalid_state("there is no active login session")
                })?;
                let sent = session
                    .request_sms_2fa(params.phone_id)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "sent": sent }))
            }
            "account.login.submit2fa" => {
                let params: TwoFactorParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let session = self.login_session.clone().ok_or_else(|| {
                    RpcError::invalid_state("there is no active login session")
                })?;
                let accepted = session
                    .submit_2fa(params.code)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "accepted": accepted }))
            }
            "account.login.finish" => {
                let session = self.login_session.clone().ok_or_else(|| {
                    RpcError::invalid_state("there is no active login session")
                })?;
                // Generate the IDS identity once and keep it in Engine even if
                // Apple returns a retryable registration error. Recreating it
                // on every account.login.finish retry looks like another device
                // and leaves orphaned keys in the profile keystore.
                if self.identity.is_none() {
                    self.identity = Some(WrappedIDSNGMIdentity::new(None));
                }
                let existing_users = self
                    .users
                    .read()
                    .map_err(|_| RpcError::invalid_state("users state lock is poisoned"))?
                    .clone();
                let result = session
                    .finish(
                        self.config()?.as_ref(),
                        self.connection()?.as_ref(),
                        self.identity.clone(),
                        existing_users,
                    )
                    .await
                    .map_err(RpcError::native)?;
                if let Ok(mut current) = self.users.write() {
                    *current = Some(result.users.clone());
                }
                self.identity = Some(result.identity);
                self.token_provider = result.token_provider;
                let existing_web_session = self.account.as_ref().and_then(|account| {
                    account.icloud_web_session.clone().map(|web| {
                        (account.username.clone(), account.dsid.clone(), web)
                    })
                });
                self.account = result.account_persist.map(AccountState::from);
                if let (Some(account), Some((username, dsid, web))) =
                    (self.account.as_mut(), existing_web_session)
                {
                    if account.username.eq_ignore_ascii_case(&username) && account.dsid == dsid {
                        account.icloud_web_session = Some(web);
                    }
                }
                if let Some(account) = self.account.as_ref() {
                    self.store_account_secret(account)?;
                }
                self.login_session = None;
                self.snapshot().await
            }
            "account.logout" => {
                let params: LogoutParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;

                // Stop message processing before changing the Apple registration.
                // If deregistration fails, all persisted identity and credential
                // state remains intact so a later invocation can retry safely.
                if let Some(client) = self.client.take() {
                    client.stop().await;
                }
                if params.deregister {
                    deregister_account(
                        self.config()?.as_ref(),
                        self.connection()?.as_ref(),
                        self.users()?.as_ref(),
                    )
                    .await
                    .map_err(RpcError::native)?;
                }

                // Only erase credentials and in-memory account state after the
                // requested remote operation has succeeded.
                self.credential_backend
                    .delete(&self.credential_service)
                    .map_err(RpcError::native)?;
                self.account = None;
                self.login_session = None;
                self.token_provider = None;
                self.identity = None;
                if let Ok(mut current) = self.users.write() {
                    *current = None;
                }
                Ok(json!({
                    "deregistered": params.deregister,
                    "credentialDeleted": true,
                }))
            }
            "account.credentials.migrateToFile" => {
                let params: CredentialMigrationParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let account = self.account.as_ref().ok_or_else(|| {
                    RpcError::invalid_state("there is no loaded Apple account credential to migrate")
                })?;
                let target = CredentialBackend::from_key_path(
                    &self.state_dir,
                    Path::new(&params.key_path),
                )
                .map_err(RpcError::native)?;
                let value = serde_json::to_vec(account).map_err(RpcError::native)?;
                target
                    .store(&self.credential_service, &value)
                    .map_err(RpcError::native)?;
                Ok(json!({
                    "migrated": true,
                    "credentialBackend": target.name(),
                }))
            }
            "client.start" => {
                if self.client.is_some() {
                    return self.snapshot().await;
                }
                let users = self.users()?;
                let identity = self.identity.clone().ok_or_else(|| {
                    RpcError::invalid_state("profile identity is missing; log in first")
                })?;
                let client = new_client(
                    self.connection()?.as_ref(),
                    &users,
                    &identity,
                    self.config()?.as_ref(),
                    self.token_provider.clone(),
                    Box::new(NativeMessageCallback {
                        emitter: self.emitter.clone(),
                    }),
                    Box::new(NativeUsersCallback {
                        emitter: self.emitter.clone(),
                        users: self.users.clone(),
                    }),
                )
                .await
                .map_err(RpcError::native)?;
                self.client = Some(client);
                self.snapshot().await
            }
            "account.registration.refresh" => {
                if self.client.is_some() {
                    return Err(RpcError::invalid_state(
                        "registration refresh requires the message client to remain stopped",
                    ));
                }
                let users = refresh_registration_once(
                    self.config()?.as_ref(),
                    self.connection()?.as_ref(),
                    self.users()?.as_ref(),
                    self.identity
                        .as_ref()
                        .ok_or_else(|| {
                            RpcError::invalid_state("profile identity is missing; log in first")
                        })?
                        .as_ref(),
                )
                .await
                .map_err(RpcError::native)?;
                let registered_services = users
                    .inner
                    .first()
                    .map(|user| user.registration.len() as u32)
                    .unwrap_or(0);
                // Copy the refreshed registrations into Engine synchronously
                // so the short-lived CLI persists them before it exits.
                if let Ok(mut current) = self.users.write() {
                    *current = Some(users);
                }
                Ok(json!({
                    "registeredServices": registered_services,
                    "snapshot": self.snapshot().await?,
                }))
            }
            "message.send" => {
                let params: SendMessageParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_message(
                        params.conversation.into(),
                        params.text,
                        params.html,
                        params.subject,
                        params.effect_id,
                        sender,
                        params.reply_guid,
                        params.reply_part,
                        params.scheduled_ms,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "message.multipart.send" => {
                let params: SendMultipartMessageParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let mut parts = Vec::with_capacity(params.parts.len());
                for part in params.parts {
                    let data = match part.path {
                        Some(path) => Some(tokio::fs::read(path).await.map_err(RpcError::native)?),
                        None => None,
                    };
                    parts.push(WrappedMultipartPart {
                        part_index: part.part_index,
                        text: part.text,
                        mention: part.mention,
                        data,
                        mime_type: part.mime_type,
                        uti_type: part.uti_type,
                        filename: part.filename,
                    });
                }
                // ddScan is a Messages.framework data-detector toggle. Direct
                // IDS/rustpush sends do not invoke that local framework scan.
                let _ = params.dd_scan;
                let guid = self
                    .client()?
                    .send_multipart_message(
                        params.conversation.into(),
                        parts,
                        sender,
                        params.subject,
                        params.effect_id,
                        params.reply_guid,
                        params.reply_part,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "chat.rename" => {
                let params: GroupRenameParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_rename_group(params.conversation.into(), params.new_name, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "chat.participants.change" => {
                let params: GroupParticipantsParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_change_participants(
                        params.conversation.into(),
                        params.new_participants,
                        params.group_version,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "chat.leave" => {
                let params: GroupLeaveParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_leave_group(params.conversation.into(), params.group_version, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "chat.icon.set" => {
                let params: GroupIconParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let client = self.client()?;
                let guid = match params.path {
                    Some(path) => {
                        let data = tokio::fs::read(path).await.map_err(RpcError::native)?;
                        client
                            .send_icon_change(
                                params.conversation.into(),
                                data,
                                params.group_version,
                                sender,
                            )
                            .await
                    }
                    None => client
                        .send_icon_clear(
                            params.conversation.into(),
                            params.group_version,
                            sender,
                        )
                        .await,
                }
                .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "reaction.send" => {
                let params: SendReactionParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let reaction = match params.reaction.as_str() {
                    "heart" | "love" => 0,
                    "like" => 1,
                    "dislike" => 2,
                    "laugh" => 3,
                    "emphasize" => 4,
                    "question" => 5,
                    "emoji" => 6,
                    value => {
                        return Err(RpcError::invalid_params(format!(
                            "unsupported reaction: {value}"
                        )))
                    }
                };
                let guid = self
                    .client()?
                    .send_tapback(
                        params.conversation.into(),
                        params.target_uuid,
                        params.target_part,
                        params.target_text.unwrap_or_default(),
                        reaction,
                        params.emoji,
                        params.remove,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "reaction.sticker.send" => {
                let params: SendStickerReactionParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let data = tokio::fs::read(&params.path).await.map_err(RpcError::native)?;
                let filename = params.filename.unwrap_or_else(|| {
                    std::path::Path::new(&params.path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("sticker")
                        .to_string()
                });
                let guid = self
                    .client()?
                    .send_sticker_tapback(
                        params.conversation.into(),
                        params.target_uuid,
                        params.target_part,
                        params.target_text.unwrap_or_default(),
                        data,
                        params.mime_type,
                        params.uti_type,
                        filename,
                        params.source,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "poll.vote" => {
                let params: SendPollVoteParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_poll_vote(
                        params.conversation.into(),
                        params.target_uuid,
                        params.session_id,
                        params.poll_response_json,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "attachment.send" => {
                let params: SendAttachmentParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let path = PathBuf::from(&params.path);
                let data = tokio::fs::read(&path).await.map_err(RpcError::native)?;
                let filename = params.filename.or_else(|| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .map(ToOwned::to_owned)
                });
                let filename = filename.ok_or_else(|| {
                    RpcError::invalid_params("attachment filename could not be determined")
                })?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_attachment(
                        params.conversation.into(),
                        data,
                        params.mime_type,
                        params.uti_type,
                        filename,
                        sender,
                        params.reply_guid,
                        params.reply_part,
                        params.caption,
                        params.effect_id,
                        params.is_audio_message,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "handle.validate" => {
                let params: ValidateHandlesParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let available = self
                    .client()?
                    .validate_targets(params.addresses, sender)
                    .await;
                Ok(json!({ "available": available }))
            }
            "handle.lookup" => {
                let params: ValidateHandlesParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                if params.addresses.is_empty() || params.addresses.len() > 18 {
                    return Err(RpcError::invalid_params(
                        "handle.lookup requires between 1 and 18 addresses",
                    ));
                }
                let sender = self.sender(params.from)?;
                let report = self
                    .client()?
                    .lookup_targets_once(params.addresses, sender)
                    .await;
                let successful = report.error.is_none() && !report.panicked && !report.timed_out;
                let available = report
                    .targets
                    .iter()
                    .filter(|target| {
                        successful
                            && target.response_entry_returned
                            && target.cache_entry_fresh
                            && target.identity_count > 0
                    })
                    .map(|target| target.address.clone())
                    .collect::<Vec<_>>();
                let targets = report
                    .targets
                    .iter()
                    .map(|target| json!({
                        "address": target.address,
                        "cacheEntryFresh": target.cache_entry_fresh,
                        "responseEntryReturned": target.response_entry_returned,
                        "identityCount": target.identity_count,
                        "correlationIdentifierPresent": target.correlation_identifier_present,
                    }))
                    .collect::<Vec<_>>();
                Ok(json!({
                    "available": available,
                    "targets": targets,
                    "error": report.error,
                    "panicked": report.panicked,
                    "timedOut": report.timed_out,
                    "attempts": report.attempts,
                }))
            }
            "handle.validateHttp" => {
                let params: ValidateHandlesParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let available = self
                    .client()?
                    .validate_targets_http(params.addresses, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "available": available }))
            }
            "findmy.following" => {
                let params: FindMyFollowingParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let client = self.client()?;
                let mut find_my_ids = params.find_my_ids;
                if find_my_ids.is_empty() {
                    find_my_ids.extend(params.find_my_id);
                }
                let mut following = Vec::new();
                if find_my_ids.is_empty() {
                    following = client
                        .refresh_findmy_following(params.address, None)
                        .await
                        .map_err(RpcError::native)?;
                } else {
                    for find_my_id in find_my_ids {
                        following = client
                            .refresh_findmy_following(params.address.clone(), Some(find_my_id))
                            .await
                            .map_err(RpcError::native)?;
                    }
                }
                serde_json::to_value(following).map_err(RpcError::native)
            }
            "message.edit" => {
                let params: SendEditParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_edit(
                        params.conversation.into(),
                        params.target_uuid,
                        params.target_part,
                        params.text,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "message.unsend" => {
                let params: SendUnsendParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_unsend(
                        params.conversation.into(),
                        params.target_uuid,
                        params.target_part,
                        sender,
                    )
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "chat.typing" => {
                let params: SendTypingParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                self.client()?
                    .send_typing(params.conversation.into(), params.active, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "sent": true }))
            }
            "chat.read" => {
                let params: SendReadReceiptParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                self.client()?
                    .send_read_receipt(params.conversation.into(), sender, params.for_uuid)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "sent": true }))
            }
            "chat.unread" => {
                let params: ConversationControlParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                self.client()?
                    .send_mark_unread(params.conversation.into(), params.for_uuid, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "sent": true }))
            }
            "message.notify" => {
                let params: ConversationControlParams = serde_json::from_value(params)
                    .map_err(|error| RpcError::invalid_params(error.to_string()))?;
                let sender = self.sender(params.from)?;
                let guid = self
                    .client()?
                    .send_notify_anyways(params.conversation.into(), params.for_uuid, sender)
                    .await
                    .map_err(RpcError::native)?;
                Ok(json!({ "guid": guid }))
            }
            "system.shutdown" => {
                if let Some(client) = self.client.take() {
                    client.stop().await;
                }
                if let Some(connection) = self.connection.take() {
                    connection.close();
                }
                Ok(json!({ "stopped": true }))
            }
            _ => Err(RpcError {
                code: -32601,
                message: format!("method not found: {method}"),
            }),
        }
    }
}

fn parse_state_dir() -> Result<PathBuf, String> {
    let mut args = std::env::args_os().skip(1);
    let mut state_dir = None;
    while let Some(arg) = args.next() {
        if arg == "--state-dir" {
            state_dir = args.next().map(PathBuf::from);
        } else if arg == "--help" || arg == "-h" {
            return Err("usage: iblue-native --state-dir <profile-directory>".to_string());
        } else {
            return Err(format!("unknown argument: {}", arg.to_string_lossy()));
        }
    }
    state_dir.ok_or_else(|| "--state-dir is required".to_string())
}

fn prepare_state_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("failed to create state directory: {error}"))?;
    std::env::set_current_dir(path)
        .map_err(|error| format!("failed to enter state directory: {error}"))?;
    std::env::set_var("IBLUE_DATA_DIR", path);
    Ok(())
}

#[tokio::main]
async fn main() {
    let state_dir = match parse_state_dir().and_then(|path| {
        let absolute = path
            .canonicalize()
            .or_else(|_| {
                std::fs::create_dir_all(&path)?;
                path.canonicalize()
            })
            .map_err(|error| format!("failed to resolve state directory: {error}"))?;
        prepare_state_dir(&absolute)?;
        Ok(absolute)
    }) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };

    init_logger();
    let emitter = Emitter::new();
    emitter.notification(
        "engine.ready",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "stateDir": state_dir,
        }),
    );
    let mut engine = match Engine::new(emitter.clone(), &state_dir) {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("failed to initialize credential backend: {}", error.message);
            std::process::exit(2);
        }
    };
    let stdin = std::io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(error) => {
                eprintln!("failed to read RPC request: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(value) => value,
            Err(error) => {
                emitter.write(&json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": error.to_string() },
                }));
                continue;
            }
        };
        let id = request.id.clone();
        match engine.handle(&request.method, request.params).await {
            Ok(result) => emitter.write(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            })),
            Err(error) => emitter.write(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": error.code, "message": error.message },
            })),
        }
        if request.method == "system.shutdown" {
            break;
        }
    }

    if let Some(client) = engine.client.take() {
        client.stop().await;
    }
    if let Some(connection) = engine.connection.take() {
        connection.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_service_is_stable_opaque_and_profile_scoped() {
        let first = credential_service_for_state_dir(Path::new("/profiles/first/native"));
        let first_again = credential_service_for_state_dir(Path::new("/profiles/first/native"));
        let second = credential_service_for_state_dir(Path::new("/profiles/second/native"));
        assert_eq!(first, first_again);
        assert_ne!(first, second);
        assert!(first.starts_with("app.iblue.ids."));
        assert_eq!(first.len(), "app.iblue.ids.".len() + 64);
        assert!(!first.contains("profiles"));
        assert!(!first.contains("first"));
        assert_ne!(first, "com.apple.account.AppleIDAuthentication.token");
    }

    #[test]
    fn credential_service_identity_survives_a_profile_move() {
        let root = std::env::temp_dir().join(format!(
            "iblue-credential-service-test-{}",
            uuid::Uuid::new_v4()
        ));
        let original = root.join("original-native");
        let moved = root.join("moved-native");
        let key_path = root.join("credential.key");
        std::fs::create_dir_all(&original).expect("create original native directory");
        std::fs::write(&key_path, [11u8; 32]).expect("write portable credential key");

        let original_service =
            load_or_create_credential_service(&original).expect("create credential service");
        assert_eq!(original_service, credential_service_for_state_dir(&original));
        let service_path = original.join(CREDENTIAL_SERVICE_FILE);
        assert_eq!(
            std::fs::read_to_string(&service_path)
                .expect("read credential service")
                .trim(),
            original_service
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&service_path)
                    .expect("read credential service metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let original_backend = CredentialBackend::from_key_path(&original, &key_path)
            .expect("create original encrypted credential backend");
        original_backend
            .store(&original_service, b"portable-profile-secret")
            .expect("store portable profile secret");

        std::fs::rename(&original, &moved).expect("move native directory");
        let moved_service =
            load_or_create_credential_service(&moved).expect("load moved credential service");
        assert_eq!(moved_service, original_service);
        assert_ne!(moved_service, credential_service_for_state_dir(&moved));
        let moved_backend = CredentialBackend::from_key_path(&moved, &key_path)
            .expect("create moved encrypted credential backend");
        assert_eq!(
            moved_backend
                .load(&moved_service)
                .expect("load moved portable profile secret"),
            Some(b"portable-profile-secret".to_vec())
        );

        std::fs::write(moved.join(CREDENTIAL_SERVICE_FILE), "invalid\n")
            .expect("write invalid credential service");
        assert!(load_or_create_credential_service(&moved).is_err());
        std::fs::remove_dir_all(root).expect("remove credential service fixture");
    }

    #[test]
    fn encrypted_credential_backend_round_trips_and_authenticates() {
        let root = std::env::temp_dir().join(format!(
            "iblue-credential-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("credentials.enc");
        let key_path = root.join("credential.key");
        std::fs::write(&key_path, [7u8; 32]).expect("write credential key");
        let backend = CredentialBackend::from_key_path(&root, &key_path)
            .expect("create encrypted credential backend");
        assert_eq!(backend.name(), "encrypted-file");
        let secret = br#"{"username":"secondary@example.com","pet":"not-plaintext-on-disk"}"#;

        backend.store("app.iblue.test", secret).expect("store secret");
        let encrypted = std::fs::read(&path).expect("read encrypted file");
        assert!(!encrypted
            .windows(secret.len())
            .any(|window| window == secret));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("read encrypted-file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            backend.load("app.iblue.test").expect("load secret"),
            Some(secret.to_vec())
        );
        assert!(backend.load("app.iblue.other-profile").is_err());

        let wrong_key = CredentialBackend::EncryptedFile {
            path: path.clone(),
            key: [8u8; 32],
        };
        assert!(wrong_key.load("app.iblue.test").is_err());

        let mut tampered = encrypted.clone();
        *tampered.last_mut().expect("ciphertext byte") ^= 1;
        std::fs::write(&path, tampered).expect("write tampered credential file");
        assert!(backend.load("app.iblue.test").is_err());

        let replacement = br#"{"username":"secondary@example.com","generation":2}"#;
        backend
            .store("app.iblue.test", replacement)
            .expect("replace secret");
        let replaced = std::fs::read(&path).expect("read replacement ciphertext");
        assert_ne!(replaced, encrypted, "replacement must use a fresh nonce");
        assert_eq!(
            backend.load("app.iblue.test").expect("load replacement"),
            Some(replacement.to_vec())
        );

        backend.delete("app.iblue.test").expect("delete secret");
        assert_eq!(
            backend
                .load("app.iblue.test")
                .expect("load deleted secret"),
            None
        );
        backend.delete("app.iblue.test").expect("delete missing secret");
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn credential_key_decoder_accepts_portable_encodings_and_rejects_bad_lengths() {
        let expected: [u8; 32] = std::array::from_fn(|index| index as u8);
        assert_eq!(decode_credential_key(&expected).expect("raw key"), expected);
        assert_eq!(
            decode_credential_key(format!("{}\n", hex::encode(expected)).as_bytes())
                .expect("hex key"),
            expected
        );
        assert_eq!(
            decode_credential_key(format!("  {}\n", BASE64.encode(expected)).as_bytes())
                .expect("base64 key"),
            expected
        );

        let short = decode_credential_key(BASE64.encode([1u8; 31]).as_bytes())
            .expect_err("short key must fail");
        assert!(short.contains("exactly 32 bytes"));
        let malformed_hex = decode_credential_key("z".repeat(64).as_bytes())
            .expect_err("malformed hex key must fail");
        assert!(malformed_hex.contains("invalid hex credential key"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_manager_round_trips_an_isolated_test_record() {
        let backend = CredentialBackend::Os;
        assert_eq!(backend.name(), "windows-credential-manager");
        let service = format!("app.iblue.test.{}", uuid::Uuid::new_v4());
        let secret = br#"{"synthetic":true,"account":"not-an-apple-account"}"#;

        struct Cleanup<'a> {
            backend: &'a CredentialBackend,
            service: &'a str,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.backend.delete(self.service);
            }
        }
        let _cleanup = Cleanup {
            backend: &backend,
            service: &service,
        };

        // The UUID-scoped service cannot collide with the profile-derived
        // production item. Always remove it before returning so a persistent
        // self-hosted runner does not accumulate test credentials.
        backend
            .store(&service, secret)
            .expect("store test credential");
        assert_eq!(
            backend.load(&service).expect("load test credential"),
            Some(secret.to_vec())
        );
        backend.delete(&service).expect("delete test credential");
        assert_eq!(
            backend
                .load(&service)
                .expect("load deleted test credential"),
            None
        );
    }

    #[test]
    fn native_message_json_preserves_sender_verification_failure() {
        let mut message = WrappedMessage::default();
        message.uuid = "verification-test".to_string();
        message.verification_failed = true;
        message.attachments.push(WrappedAttachment {
            mime_type: "image/png".to_string(),
            filename: "sticker.png".to_string(),
            uti_type: "public.png".to_string(),
            size: 3,
            is_inline: true,
            inline_data: Some(vec![1, 2, 3]),
            iris: false,
            is_sticker: true,
            audio_transcription: None,
            mmcs_descriptor_json: None,
        });
        let encoded = message_to_json(message);
        assert_eq!(encoded["verificationFailed"], Value::Bool(true));
        assert_eq!(encoded["attachments"][0]["isSticker"], Value::Bool(true));
    }

    #[test]
    fn native_attachment_json_exposes_apple_audio_transcription() {
        let attachment = WrappedAttachment {
            mime_type: "application/octet-stream".to_string(),
            filename: "Audio Message.caf".to_string(),
            uti_type: "com.apple.coreaudio-format".to_string(),
            size: 3,
            is_inline: true,
            inline_data: Some(vec![1, 2, 3]),
            iris: false,
            is_sticker: false,
            audio_transcription: Some("Sender-provided words".to_string()),
            mmcs_descriptor_json: None,
        };
        let encoded = attachment_to_json(attachment);
        assert_eq!(
            encoded["audioTranscription"],
            Value::String("Sender-provided words".to_string())
        );
    }

    #[test]
    fn native_message_json_exposes_safe_profile_and_balloon_metadata() {
        let mut message = WrappedMessage::default();
        message.uuid = "metadata-test".to_string();
        message.is_share_profile = true;
        message.share_profile_display_name = Some("Jane Example".to_string());
        message.share_profile_avatar = Some(vec![1, 2, 3]);
        message.app_balloon_bundle_id = Some("com.apple.Maps.MessagesExtension".to_string());
        message.app_balloon_url = Some("https://maps.apple.com/?ll=37.3349,-122.009".to_string());
        message.app_balloon_is_live = true;

        let encoded = message_to_json(message);
        assert_eq!(encoded["sharedProfile"]["displayName"], "Jane Example");
        assert_eq!(encoded["sharedProfile"]["avatarBase64"], "AQID");
        assert_eq!(encoded["appBalloon"]["isLive"], true);
        assert_eq!(encoded["appBalloon"]["bundleId"], "com.apple.Maps.MessagesExtension");
        assert!(encoded["sharedProfile"].get("recordKey").is_none());
    }

    #[test]
    fn registration_inspection_rejects_invalid_state_without_initialization() {
        let error = inspect_registration("not a plist").expect_err("invalid state should fail");
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("saved IDS registration is invalid"));
    }

    #[test]
    fn registration_inspection_reports_an_empty_saved_state_offline() {
        let serialized = rustpushgo::util::plist_to_string(&Vec::<rustpush::IDSUser>::new())
            .expect("serialize empty users");
        let inspection = inspect_registration(&serialized).expect("inspect empty users");
        assert_eq!(inspection["mode"], "offline");
        assert_eq!(inspection["appleNetworkAccessed"], false);
        assert_eq!(inspection["accountCredentialAccessed"], false);
        assert_eq!(inspection["userCount"], 0);
        assert_eq!(inspection["locallyUsableForMadrid"], false);
    }
}
