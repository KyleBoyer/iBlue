use std::fmt;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::{rngs::OsRng, RngCore};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE, SET_COOKIE};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use srp::client::SrpClient;
use srp::groups::G_2048;
use uuid::Uuid;

const HOME_ENDPOINT: &str = "https://www.icloud.com";
const AUTH_ENDPOINT: &str = "https://idmsa.apple.com/appleauth/auth";
const AUTH_ORIGIN: &str = "https://idmsa.apple.com";
const SETUP_ENDPOINT: &str = "https://setup.icloud.com/setup/ws/1";
const AUTH_CLIENT_ID: &str = "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15";
const CLIENT_BUILD: &str = "2628Build18";
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ICloudWebSession {
    #[serde(default)]
    session_token: String,
    #[serde(default)]
    scnt: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    account_country: String,
    #[serde(default)]
    trust_token: String,
    #[serde(default = "default_auth_client_id")]
    auth_client_id: String,
    #[serde(default)]
    auth_attributes: String,
    #[serde(default = "new_uuid")]
    frame_id: String,
    #[serde(default = "new_uuid")]
    service_client_id: String,
    #[serde(default)]
    cookies: Vec<WebCookie>,
    #[serde(default)]
    account_info: Value,
    #[serde(default)]
    needs_2fa: bool,
    #[serde(default)]
    authenticated_at_ms: Option<u64>,
}

impl fmt::Debug for ICloudWebSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ICloudWebSession")
            .field("configured", &self.is_ready())
            .field("needs_2fa", &self.needs_2fa)
            .field("cookie_count", &self.cookies.len())
            .field("authenticated_at_ms", &self.authenticated_at_ms)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    host_only: bool,
    secure: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginStatus {
    pub ready: bool,
    pub needs_2fa: bool,
    pub reused_session: bool,
    pub photos_available: bool,
    pub pcs_required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPhoneOption {
    pub id: i64,
    pub last_two_digits: String,
    pub mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshPhotoShare {
    pub url: String,
    pub share_id: String,
    pub asset_guid: String,
    pub item_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShareMediaKind {
    Photo,
    Video,
}

const VIDEO_PREVIEW_JPEG_BASE64: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";
const CMM_PREVIEW_MAX_PIXELS: u64 = 607_500;
const CMM_PREVIEW_MAX_BYTES: usize = 508 * 1024;

fn validate_share_media(bytes: &[u8], mime_type: &str) -> Result<ShareMediaKind, String> {
    let photo = match mime_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/heic" | "image/heif" => {
            bytes.get(4..8) == Some(b"ftyp")
                && bytes.get(8..12).is_some_and(|brand| {
                    ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]
                        .iter()
                        .any(|candidate| brand == candidate.as_bytes())
                })
        }
        _ => false,
    };
    if photo {
        return Ok(ShareMediaKind::Photo);
    }
    let video =
        matches!(mime_type, "video/quicktime" | "video/mp4") && bytes.get(4..8) == Some(b"ftyp");
    if video {
        return Ok(ShareMediaKind::Video);
    }
    Err("fresh iCloud Photos shares require JPEG, PNG, HEIC/HEIF, MOV, or MP4 media whose bytes match its MIME type; animated GIF remains supported by the ordinary iMessage attachment API".to_string())
}

fn fallback_share_preview() -> Result<Vec<u8>, String> {
    BASE64
        .decode(VIDEO_PREVIEW_JPEG_BASE64)
        .map_err(|_| "built-in share preview is invalid".to_string())
}

fn jpeg_share_preview(bytes: &[u8], mime_type: &str) -> Result<Vec<u8>, String> {
    let format = match mime_type {
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/png" => image::ImageFormat::Png,
        _ => return fallback_share_preview(),
    };
    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("failed to decode photo for its share preview: {error}"))?;
    let width = u64::from(decoded.width());
    let height = u64::from(decoded.height());
    let preview = if width.saturating_mul(height) > CMM_PREVIEW_MAX_PIXELS {
        let scale = (CMM_PREVIEW_MAX_PIXELS as f64 / (width * height) as f64).sqrt();
        decoded.resize(
            ((width as f64 * scale).round() as u32).max(1),
            ((height as f64 * scale).round() as u32).max(1),
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };

    for quality in [70, 60, 50, 40] {
        let mut encoded = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality)
            .encode_image(&preview)
            .map_err(|error| format!("failed to encode the share JPEG preview: {error}"))?;
        if encoded.len() <= CMM_PREVIEW_MAX_BYTES {
            return Ok(encoded);
        }
    }

    let smaller = preview.thumbnail(480, 480);
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 40)
        .encode_image(&smaller)
        .map_err(|error| format!("failed to encode the bounded share JPEG preview: {error}"))?;
    if encoded.len() > CMM_PREVIEW_MAX_BYTES {
        return Err("generated iCloud Photos share preview exceeds 508 KiB".to_string());
    }
    Ok(encoded)
}

#[cfg(target_os = "macos")]
fn heic_share_preview(path: &Path) -> Result<Vec<u8>, String> {
    use std::process::Command;

    let output = tempfile::Builder::new()
        .suffix(".jpg")
        .tempfile()
        .map_err(|error| format!("failed to prepare the HEIC share preview: {error}"))?;
    let conversion = Command::new("/usr/bin/sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "70",
            "-Z",
            "780",
        ])
        .arg(path)
        .arg("--out")
        .arg(output.path())
        .output()
        .map_err(|error| format!("failed to start the macOS HEIC preview converter: {error}"))?;
    if !conversion.status.success() {
        let detail = String::from_utf8_lossy(&conversion.stderr)
            .trim()
            .to_string();
        return Err(if detail.is_empty() {
            "macOS could not convert the HEIC share preview".to_string()
        } else {
            format!("macOS could not convert the HEIC share preview: {detail}")
        });
    }
    let bytes = std::fs::read(output.path())
        .map_err(|error| format!("failed to read the converted HEIC share preview: {error}"))?;
    jpeg_share_preview(&bytes, "image/jpeg")
}

#[cfg(not(target_os = "macos"))]
fn heic_share_preview(_path: &Path) -> Result<Vec<u8>, String> {
    fallback_share_preview()
}

#[cfg(target_os = "macos")]
fn video_share_preview(path: &Path) -> Result<Vec<u8>, String> {
    use std::process::Command;

    let directory = tempfile::tempdir()
        .map_err(|error| format!("failed to prepare the video share preview: {error}"))?;
    let extraction = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", "780", "-o"])
        .arg(directory.path())
        .arg(path)
        .output()
        .map_err(|error| format!("failed to start the macOS video preview extractor: {error}"))?;
    if !extraction.status.success() {
        let detail = String::from_utf8_lossy(&extraction.stderr)
            .trim()
            .to_string();
        return Err(if detail.is_empty() {
            "macOS could not extract the video share preview".to_string()
        } else {
            format!("macOS could not extract the video share preview: {detail}")
        });
    }
    let preview_path = std::fs::read_dir(directory.path())
        .map_err(|error| format!("failed to inspect the extracted video preview: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("png"))
        })
        .ok_or_else(|| "macOS did not produce a video share preview".to_string())?;
    let bytes = std::fs::read(preview_path)
        .map_err(|error| format!("failed to read the extracted video share preview: {error}"))?;
    jpeg_share_preview(&bytes, "image/png")
}

#[cfg(not(target_os = "macos"))]
fn video_share_preview(_path: &Path) -> Result<Vec<u8>, String> {
    fallback_share_preview()
}

fn share_preview(
    path: &Path,
    bytes: &[u8],
    mime_type: &str,
    media_kind: ShareMediaKind,
) -> Result<(Vec<u8>, &'static str), String> {
    let preview = match media_kind {
        ShareMediaKind::Photo if matches!(mime_type, "image/heic" | "image/heif") => {
            heic_share_preview(path)?
        }
        ShareMediaKind::Photo => jpeg_share_preview(bytes, mime_type)?,
        ShareMediaKind::Video => video_share_preview(path)?,
    };
    Ok((preview, "image/jpeg"))
}

#[derive(Deserialize)]
struct SrpInitResponse {
    iteration: u32,
    salt: String,
    protocol: String,
    b: String,
    c: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStateResponse {
    #[serde(default)]
    trusted_phone_numbers: Vec<TrustedPhoneNumber>,
    trusted_phone_number: Option<TrustedPhoneNumber>,
    phone_number_verification: Option<Box<AuthStateResponse>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedPhoneNumber {
    id: i64,
    #[serde(default)]
    number_with_dial_code: String,
    #[serde(default)]
    obfuscated_number: String,
    #[serde(default)]
    push_mode: String,
}

impl Default for ICloudWebSession {
    fn default() -> Self {
        Self {
            session_token: String::new(),
            scnt: String::new(),
            session_id: String::new(),
            account_country: String::new(),
            trust_token: String::new(),
            auth_client_id: default_auth_client_id(),
            auth_attributes: String::new(),
            frame_id: new_uuid(),
            service_client_id: new_uuid(),
            cookies: Vec::new(),
            account_info: Value::Null,
            needs_2fa: false,
            authenticated_at_ms: None,
        }
    }
}

impl ICloudWebSession {
    pub fn is_ready(&self) -> bool {
        !self.needs_2fa
            && self.authenticated_at_ms.is_some()
            && self.service_url("ckdatabasews").is_ok()
            && self.service_url("photosupload").is_ok()
    }

    pub fn status(&self, reused_session: bool) -> WebLoginStatus {
        WebLoginStatus {
            ready: self.is_ready(),
            needs_2fa: self.needs_2fa,
            reused_session,
            photos_available: self.service_url("ckdatabasews").is_ok()
                && self.service_url("photosupload").is_ok(),
            pcs_required: self.photos_pcs_required(),
        }
    }

    pub async fn begin_login(
        &mut self,
        username: &str,
        hashed_password_hex: &str,
    ) -> Result<WebLoginStatus, String> {
        let client = http_client()?;
        if self.is_ready() && self.validate(&client).await.is_ok() {
            return Ok(self.status(true));
        }

        self.clear_for_fresh_login();
        self.auth_start(&client).await?;
        self.auth_federate(&client, username).await?;
        self.auth_srp(&client, username, hashed_password_hex)
            .await?;
        if self.needs_2fa {
            // Current Apple web auth does not always send the trusted-device
            // push after the 409 response. This idempotent PUT asks for it.
            let _ = self.request_push_notification(&client).await;
            return Ok(self.status(false));
        }
        self.account_login(&client).await?;
        Ok(self.status(false))
    }

    pub async fn phone_options(&mut self) -> Result<Vec<WebPhoneOption>, String> {
        if !self.needs_2fa {
            return Err("the iCloud web session is not waiting for verification".to_string());
        }
        let client = http_client()?;
        let mut state: AuthStateResponse = self
            .auth_json(&client, Method::GET, AUTH_ENDPOINT, None, &[StatusCode::OK])
            .await?;
        if state.trusted_phone_numbers.is_empty() {
            if let Some(nested) = state.phone_number_verification.take() {
                state = *nested;
            }
        }
        if state.trusted_phone_numbers.is_empty() {
            if let Some(phone) = state.trusted_phone_number.take() {
                state.trusted_phone_numbers.push(phone);
            }
        }
        Ok(state
            .trusted_phone_numbers
            .into_iter()
            .map(|phone| WebPhoneOption {
                id: phone.id,
                last_two_digits: last_two_digits(&phone),
                mode: if phone.push_mode.is_empty() {
                    "sms".to_string()
                } else {
                    phone.push_mode
                },
            })
            .collect())
    }

    pub async fn request_sms(&mut self, phone_id: i64, mode: &str) -> Result<(), String> {
        if !self.needs_2fa {
            return Err("the iCloud web session is not waiting for verification".to_string());
        }
        let client = http_client()?;
        let body = json!({
            "phoneNumber": { "id": phone_id },
            "mode": if mode.is_empty() { "sms" } else { mode },
        });
        self.auth_empty(
            &client,
            Method::PUT,
            &format!("{AUTH_ENDPOINT}/verify/phone"),
            Some(body),
            &[StatusCode::OK, StatusCode::NO_CONTENT],
        )
        .await
    }

    pub async fn submit_2fa(
        &mut self,
        code: &str,
        sms: Option<(i64, String)>,
    ) -> Result<WebLoginStatus, String> {
        if !self.needs_2fa {
            return Err("the iCloud web session is not waiting for verification".to_string());
        }
        if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("Apple verification code must contain six digits".to_string());
        }
        let client = http_client()?;
        let (url, body) = if let Some((phone_id, mode)) = sms {
            (
                format!("{AUTH_ENDPOINT}/verify/phone/securitycode"),
                json!({
                    "securityCode": { "code": code },
                    "phoneNumber": { "id": phone_id },
                    "mode": if mode.is_empty() { "sms" } else { &mode },
                }),
            )
        } else {
            (
                format!("{AUTH_ENDPOINT}/verify/trusteddevice/securitycode"),
                json!({ "securityCode": { "code": code } }),
            )
        };
        let status = self
            .auth_empty_allow_conflict_token(&client, Method::POST, &url, Some(body))
            .await?;
        if !status {
            return Err("Apple did not accept the verification code".to_string());
        }
        self.auth_empty(
            &client,
            Method::GET,
            &format!("{AUTH_ENDPOINT}/2sv/trust"),
            None,
            &[StatusCode::OK, StatusCode::NO_CONTENT],
        )
        .await?;
        self.needs_2fa = false;
        self.account_login(&client).await?;
        Ok(self.status(false))
    }

    pub async fn prepare_photos(&mut self) -> Result<WebLoginStatus, String> {
        if !self.is_ready() {
            return Err(
                "iCloud Photos web access is not enrolled; run icloud-web-setup first".to_string(),
            );
        }
        let client = http_client()?;
        self.ensure_photos_pcs(&client).await?;
        Ok(self.status(false))
    }

    pub async fn create_photo_share(
        &mut self,
        dsid: &str,
        path: &Path,
        filename: &str,
        mime_type: &str,
        title: &str,
    ) -> Result<FreshPhotoShare, String> {
        if !self.is_ready() {
            return Err(
                "iCloud Photos web access is not enrolled; run icloud-web-setup first".to_string(),
            );
        }
        let metadata = tokio::fs::metadata(path)
            .await
            .map_err(|error| format!("failed to read photo metadata: {error}"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("photo is empty or is not a regular file".to_string());
        }
        if metadata.len() > 1024 * 1024 * 1024 {
            return Err("media exceeds the 1 GiB fresh-share limit".to_string());
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| format!("failed to read photo: {error}"))?;
        let media_kind = validate_share_media(&bytes, mime_type)?;
        let modified_ms = metadata
            .modified()
            .unwrap_or_else(|_| SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let client = http_client()?;
        self.ensure_photos_pcs(&client).await?;

        let asset_guid = self
            .upload_asset(&client, dsid, &bytes, filename, mime_type, modified_ms)
            .await?;
        // Photos always publishes a bounded JPEG thumbnail as CMMRoot.previewData,
        // even when the underlying asset is PNG, HEIC, or video.
        let (preview, preview_mime) = share_preview(path, &bytes, mime_type, media_kind)?;
        self.create_cmm_share(
            &client,
            dsid,
            &preview,
            preview_mime,
            &asset_guid,
            modified_ms,
            title,
            media_kind,
        )
        .await
    }

    async fn validate(&mut self, client: &Client) -> Result<(), String> {
        let value: Value = self
            .web_json(
                client,
                Method::POST,
                &format!("{SETUP_ENDPOINT}/validate"),
                None,
                &[StatusCode::OK],
            )
            .await?;
        self.account_info = value;
        self.needs_2fa = false;
        self.authenticated_at_ms = Some(now_ms());
        Ok(())
    }

    fn clear_for_fresh_login(&mut self) {
        self.session_token.clear();
        self.scnt.clear();
        self.session_id.clear();
        self.account_country.clear();
        self.auth_attributes.clear();
        self.cookies.clear();
        self.account_info = Value::Null;
        self.needs_2fa = false;
        self.authenticated_at_ms = None;
        self.frame_id = new_uuid();
    }

    async fn auth_start(&mut self, client: &Client) -> Result<(), String> {
        let frame = format!("auth-{}", self.frame_id);
        let mut url = Url::parse(&format!("{AUTH_ENDPOINT}/authorize/signin"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("frame_id", &frame)
            .append_pair("language", "en_US")
            .append_pair("skVersion", "7")
            .append_pair("iframeId", &frame)
            .append_pair("client_id", &self.auth_client_id)
            .append_pair("redirect_uri", HOME_ENDPOINT)
            .append_pair("response_type", "code")
            .append_pair("response_mode", "web_message")
            .append_pair("state", &frame)
            .append_pair("authVersion", "latest");
        self.request_empty(
            client,
            Method::GET,
            url,
            common_headers(false)?,
            None,
            &[StatusCode::OK],
        )
        .await
    }

    async fn auth_federate(&mut self, client: &Client, username: &str) -> Result<(), String> {
        let mut url =
            Url::parse(&format!("{AUTH_ENDPOINT}/federate")).map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("isRememberMeEnabled", "true");
        self.request_empty(
            client,
            Method::POST,
            url,
            self.auth_headers()?,
            Some(json!({ "accountName": username, "rememberMe": true })),
            &[StatusCode::OK],
        )
        .await
    }

    async fn auth_srp(
        &mut self,
        client: &Client,
        username: &str,
        hashed_password_hex: &str,
    ) -> Result<(), String> {
        let hashed_password = hex::decode(hashed_password_hex)
            .map_err(|_| "stored Apple Account password hash is invalid".to_string())?;
        if hashed_password.len() != 32 {
            return Err("stored Apple Account password hash has an invalid length".to_string());
        }

        let srp_client = SrpClient::<Sha256>::new(&G_2048);
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let public = srp_client.compute_public_ephemeral(&secret);

        let init: SrpInitResponse = self
            .auth_json(
                client,
                Method::POST,
                &format!("{AUTH_ENDPOINT}/signin/init"),
                Some(json!({
                    "a": BASE64.encode(&public),
                    "accountName": username,
                    "protocols": ["s2k", "s2k_fo"],
                })),
                &[StatusCode::OK],
            )
            .await?;
        let salt = BASE64
            .decode(init.salt)
            .map_err(|_| "Apple returned an invalid SRP salt".to_string())?;
        let server_public = BASE64
            .decode(init.b)
            .map_err(|_| "Apple returned an invalid SRP public value".to_string())?;
        let password_input = match init.protocol.as_str() {
            "s2k" => hashed_password,
            "s2k_fo" => hex::encode(hashed_password).into_bytes(),
            value => return Err(format!("Apple selected unsupported SRP protocol {value}")),
        };
        let mut derived = [0u8; 32];
        pbkdf2::<Hmac<Sha256>>(&password_input, &salt, init.iteration, &mut derived);
        let verifier = srp_client
            .process_reply(
                &secret,
                username.to_lowercase().as_bytes(),
                &derived,
                &salt,
                &server_public,
                true,
            )
            .map_err(|error| format!("failed to calculate Apple SRP proof: {error}"))?;
        let proof = verifier.proof();
        let server_proof = Sha256::new()
            .chain_update(&public)
            .chain_update(proof)
            .chain_update(verifier.key())
            .finalize();
        let mut trust_tokens = Vec::new();
        if !self.trust_token.is_empty() {
            trust_tokens.push(self.trust_token.clone());
        }
        let mut url = Url::parse(&format!("{AUTH_ENDPOINT}/signin/complete"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("isRememberMeEnabled", "true");
        let response = self
            .request(
                client,
                Method::POST,
                url,
                self.auth_headers()?,
                Some(json!({
                    "accountName": username,
                    "m1": BASE64.encode(proof),
                    "m2": BASE64.encode(server_proof),
                    "c": init.c,
                    "rememberMe": true,
                    "trustTokens": trust_tokens,
                })),
            )
            .await?;
        match response.status {
            StatusCode::OK => {
                self.needs_2fa = false;
                Ok(())
            }
            StatusCode::CONFLICT => {
                self.needs_2fa = true;
                Ok(())
            }
            StatusCode::FORBIDDEN => {
                Err("Apple rejected the stored account credential; run login again".to_string())
            }
            status => Err(format!("Apple web sign-in returned HTTP {status}")),
        }
    }

    async fn request_push_notification(&mut self, client: &Client) -> Result<(), String> {
        self.auth_empty(
            client,
            Method::PUT,
            &format!("{AUTH_ENDPOINT}/verify/trusteddevice/securitycode"),
            None,
            &[StatusCode::OK, StatusCode::NO_CONTENT],
        )
        .await
    }

    async fn account_login(&mut self, client: &Client) -> Result<(), String> {
        if self.session_token.is_empty() {
            return Err("Apple web sign-in did not issue a session token".to_string());
        }
        let value: Value = self
            .web_json(
                client,
                Method::POST,
                &format!("{SETUP_ENDPOINT}/accountLogin"),
                Some(json!({
                    "accountCountryCode": self.account_country,
                    "dsWebAuthToken": self.session_token,
                    "extended_login": true,
                    "trustToken": self.trust_token,
                })),
                &[StatusCode::OK],
            )
            .await?;
        self.account_info = value;
        self.authenticated_at_ms = Some(now_ms());
        Ok(())
    }

    async fn ensure_photos_pcs(&mut self, client: &Client) -> Result<(), String> {
        if !self.photos_pcs_required() {
            return Ok(());
        }
        const REQUIRED: [&str; 2] = ["X-APPLE-WEBAUTH-PCS-Photos", "X-APPLE-WEBAUTH-PCS-Sharing"];
        if REQUIRED.iter().all(|name| self.has_cookie(name)) {
            return Ok(());
        }
        for _ in 0..30 {
            let value: Value = self
                .web_json(
                    client,
                    Method::POST,
                    &format!("{SETUP_ENDPOINT}/requestPCS"),
                    Some(json!({ "appName": "photos", "derivedFromUserAction": true })),
                    &[StatusCode::OK],
                )
                .await?;
            if value.get("status").and_then(Value::as_str) == Some("success") {
                if REQUIRED.iter().all(|name| self.has_cookie(name)) {
                    return Ok(());
                }
                return Err(
                    "Apple approved Photos web access but omitted required PCS cookies".to_string(),
                );
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        Err("timed out waiting for trusted-device approval of iCloud Photos web access".to_string())
    }

    async fn upload_asset(
        &mut self,
        client: &Client,
        dsid: &str,
        bytes: &[u8],
        filename: &str,
        mime_type: &str,
        modified_ms: u64,
    ) -> Result<String, String> {
        let upload_base = self.service_url("photosupload")?;
        let upload_id = new_uuid();
        let create: Value = self
            .service_json(
                client,
                upload_base.clone(),
                "/photosupload/createUploadUrl",
                dsid,
                false,
                json!({ "zoneName": "PrimarySync", "assets": { upload_id.clone(): bytes.len() } }),
            )
            .await?;
        let signed_url = create
            .get("uploadUrls")
            .and_then(Value::as_object)
            .and_then(|urls| urls.get(&upload_id))
            .and_then(Value::as_str)
            .ok_or_else(|| "Apple did not return a Photos upload URL".to_string())?;
        let upload_receipt = self
            .upload_bytes(client, signed_url, bytes, mime_type)
            .await?;
        let put: Value = self
            .service_json(
                client,
                upload_base.clone(),
                "/photosupload/putAsset",
                dsid,
                false,
                json!({
                    "zoneName": "PrimarySync",
                    "files": [{
                        "fileName": filename,
                        "lastModDate": modified_ms,
                        "timeZoneOffset": 0,
                        "singleFileUploadRequest": upload_receipt,
                    }],
                    "localTimeZoneId": "Etc/UTC",
                    "importGroup": new_uuid(),
                }),
            )
            .await?;
        let row = put
            .as_array()
            .and_then(|rows| rows.first())
            .ok_or_else(|| "Apple returned an empty Photos import response".to_string())?;
        let import = photo_import_result(row)?;
        let Some(job_id) = import.job_id else {
            return Ok(import.asset_guid);
        };
        for _ in 0..90 {
            let status: Value = self
                .service_json(
                    client,
                    upload_base.clone(),
                    "/photosupload/uploadStatus",
                    dsid,
                    false,
                    json!({ "uploadJobIds": [job_id] }),
                )
                .await?;
            let progress = status
                .as_object()
                .and_then(|map| map.values().next())
                .and_then(|row| row.get("progress"))
                .and_then(Value::as_u64)
                .unwrap_or_default();
            if progress >= 100 {
                return Ok(import.asset_guid);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Err("timed out waiting for iCloud Photos to import the uploaded media".to_string())
    }

    async fn create_cmm_share(
        &mut self,
        client: &Client,
        dsid: &str,
        preview: &[u8],
        preview_mime_type: &str,
        asset_guid: &str,
        asset_date_ms: u64,
        title: &str,
        media_kind: ShareMediaKind,
    ) -> Result<FreshPhotoShare, String> {
        let cloudkit = self.service_url("ckdatabasews")?;
        let zone_name = format!("CMM-{}", new_uuid().to_uppercase());
        let zones: Value = self
            .service_json(
                client,
                cloudkit.clone(),
                "/database/1/com.apple.photos.cloud/production/private/zones/modify",
                dsid,
                true,
                json!({
                    "operations": [{
                        "operationType": "create",
                        "zone": { "zoneID": { "zoneName": zone_name } },
                    }],
                }),
            )
            .await?;
        let zone_id = zones
            .pointer("/zones/0/zoneID")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "Apple did not create the iCloud share zone".to_string())?;
        let owner = zone_id
            .get("ownerRecordName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Apple share zone omitted its owner identifier".to_string())?
            .to_string();

        let token_response: Value = self
            .service_json(
                client,
                cloudkit.clone(),
                "/database/1/com.apple.photos.cloud/production/private/assets/upload",
                dsid,
                true,
                json!({
                    "zoneID": Value::Object(zone_id.clone()),
                    "tokens": [{
                        "recordName": "cmm-root",
                        "recordType": "CMMRoot",
                        "fieldName": "previewData",
                    }],
                }),
            )
            .await?;
        let preview_url = token_response
            .pointer("/tokens/0/url")
            .and_then(Value::as_str)
            .ok_or_else(|| "Apple did not return a CMM preview upload URL".to_string())?;
        let preview_receipt = self
            .upload_bytes(client, preview_url, preview, preview_mime_type)
            .await?;
        let created_ms = now_ms();
        let root_response: Value = self
            .service_json(
                client,
                cloudkit.clone(),
                "/database/1/com.apple.photos.cloud/production/private/records/modify",
                dsid,
                true,
                json!({
                    "atomic": true,
                    "zoneID": Value::Object(zone_id.clone()),
                    "operations": [{
                        "operationType": "create",
                        "record": {
                            "recordName": "cmm-root",
                            "recordType": "CMMRoot",
                            "fields": {
                                "createDate": { "value": created_ms },
                                "endDate": { "value": asset_date_ms },
                                "startDate": { "value": asset_date_ms },
                                "assetCount": { "value": 1 },
                                "videosCount": { "value": if media_kind == ShareMediaKind::Video { 1 } else { 0 } },
                                "photosCount": { "value": if media_kind == ShareMediaKind::Photo { 1 } else { 0 } },
                                "previewData": { "value": preview_receipt },
                            },
                            "createShortGUID": true,
                        },
                    }],
                }),
            )
            .await?;
        let root = root_response
            .pointer("/records/0")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| "Apple did not create the CMM root record".to_string())?;
        let share_id = cmm_share_id(&root)?;

        let copy: Value = self
            .service_json(
                client,
                cloudkit.clone(),
                "/database/1/com.apple.photos.cloud/production/private/records/copy/start",
                dsid,
                true,
                json!({
                    "sourceZoneID": {
                        "zoneName": "PrimarySync",
                        "ownerRecordName": owner,
                        "zoneType": "REGULAR_CUSTOM_ZONE",
                    },
                    "targetZoneID": Value::Object(zone_id.clone()),
                    "targetRootName": "cmm-root",
                    "includeRecords": [asset_guid],
                }),
            )
            .await?;
        let job_id = copy
            .get("jobID")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Apple did not start the CMM record copy".to_string())?
            .to_string();

        let for_record = compact_root_record(root, &zone_id, &owner, &zone_name)?;
        self.service_json::<Value>(
            client,
            cloudkit.clone(),
            "/database/1/com.apple.photos.cloud/production/private/records/modify",
            dsid,
            true,
            json!({
                "atomic": true,
                "zoneID": Value::Object(zone_id.clone()),
                "operations": [{
                    "operationType": "create",
                    "record": {
                        "recordName": "cmm-share",
                        "recordType": "cloudkit.share",
                        "fields": {
                            "cloudkit.title": { "value": title },
                            "cloudkit.type": { "value": "cmm" },
                        },
                        "forRecord": for_record,
                        "anonymousPublicAccess": true,
                        "publicPermission": "READ_ONLY",
                    },
                }],
            }),
        )
        .await?;

        for _ in 0..60 {
            let status: Value = self
                .service_json(
                    client,
                    cloudkit.clone(),
                    "/database/1/com.apple.photos.cloud/production/private/records/copy/status",
                    dsid,
                    true,
                    json!({ "jobID": job_id }),
                )
                .await?;
            match status.get("status").and_then(Value::as_str) {
                Some("COMPLETED") => {
                    return Ok(FreshPhotoShare {
                        url: format!("https://share.icloud.com/photos/{share_id}"),
                        share_id,
                        asset_guid: asset_guid.to_string(),
                        item_count: 1,
                    })
                }
                Some("FAILED") | Some("CANCELLED") => {
                    return Err("Apple failed while copying the media into the share".to_string())
                }
                _ => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        }
        Err("timed out waiting for Apple to populate the iCloud photo share".to_string())
    }

    async fn upload_bytes(
        &mut self,
        client: &Client,
        signed_url: &str,
        bytes: &[u8],
        mime_type: &str,
    ) -> Result<Value, String> {
        let url = Url::parse(signed_url)
            .map_err(|_| "Apple returned an invalid signed upload URL".to_string())?;
        if url.scheme() != "https"
            || !url
                .host_str()
                .map(|host| {
                    host.ends_with(".icloud-content.com")
                        || host.ends_with(".icloud-content.com.cn")
                })
                .unwrap_or(false)
        {
            return Err("Apple returned an untrusted signed upload host".to_string());
        }
        let response = client
            .post(url)
            .header("User-Agent", USER_AGENT)
            .header("Origin", HOME_ENDPOINT)
            .header("Referer", format!("{HOME_ENDPOINT}/"))
            .header("Content-Type", mime_type)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|error| format!("Apple content upload failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Apple content upload returned HTTP {}",
                response.status()
            ));
        }
        let body = limited_body(response).await?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| "Apple content upload returned malformed JSON".to_string())?;
        value
            .get("singleFile")
            .cloned()
            .ok_or_else(|| "Apple content upload omitted its receipt".to_string())
    }

    async fn service_json<T: for<'de> Deserialize<'de>>(
        &mut self,
        client: &Client,
        mut base: Url,
        path: &str,
        dsid: &str,
        cloudkit: bool,
        body: Value,
    ) -> Result<T, String> {
        validate_service_host(&base, cloudkit)?;
        base.set_path(path);
        base.set_query(None);
        {
            let mut query = base.query_pairs_mut();
            if cloudkit {
                query.append_pair("remapEnums", "true");
                query.append_pair("getCurrentSyncToken", "true");
            }
            query.append_pair("dsid", dsid);
            query.append_pair("clientBuildNumber", CLIENT_BUILD);
            query.append_pair("clientMasteringNumber", CLIENT_BUILD);
            query.append_pair("clientId", &self.service_client_id);
        }
        for attempt in 0..3 {
            let response = self
                .request(
                    client,
                    Method::POST,
                    base.clone(),
                    common_headers(true)?,
                    Some(body.clone()),
                )
                .await?;
            if response.status.is_success() {
                return serde_json::from_slice(&response.body)
                    .map_err(|_| "Apple iCloud Photos API returned malformed JSON".to_string());
            }
            if attempt < 2
                && response.status == StatusCode::CONFLICT
                && apple_error_retryable(&response.body)
            {
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1) as u64)).await;
                continue;
            }
            let detail = apple_error_summary(&response.body)
                .map(|value| format!(" ({value})"))
                .unwrap_or_default();
            return Err(format!(
                "Apple iCloud Photos API returned HTTP {} for {path}{detail}",
                response.status,
            ));
        }
        unreachable!("bounded iCloud Photos retry loop always returns")
    }

    async fn auth_json<T: for<'de> Deserialize<'de>>(
        &mut self,
        client: &Client,
        method: Method,
        url: &str,
        body: Option<Value>,
        accepted: &[StatusCode],
    ) -> Result<T, String> {
        let response = self
            .request(
                client,
                method,
                Url::parse(url).map_err(|error| error.to_string())?,
                self.auth_headers()?,
                body,
            )
            .await?;
        if !accepted.contains(&response.status) {
            return Err(format!(
                "Apple web authentication returned HTTP {}",
                response.status
            ));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| "Apple web authentication returned malformed JSON".to_string())
    }

    async fn auth_empty(
        &mut self,
        client: &Client,
        method: Method,
        url: &str,
        body: Option<Value>,
        accepted: &[StatusCode],
    ) -> Result<(), String> {
        self.request_empty(
            client,
            method,
            Url::parse(url).map_err(|error| error.to_string())?,
            self.auth_headers()?,
            body,
            accepted,
        )
        .await
    }

    async fn auth_empty_allow_conflict_token(
        &mut self,
        client: &Client,
        method: Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<bool, String> {
        let response = self
            .request(
                client,
                method,
                Url::parse(url).map_err(|error| error.to_string())?,
                self.auth_headers()?,
                body,
            )
            .await?;
        if response.status.is_success() {
            return Ok(true);
        }
        // Apple's accepted 2FA response can be HTTP 409, but it must issue a
        // session token in that response. A token left over from an earlier
        // request must never make an invalid verification code look valid.
        if response.status == StatusCode::CONFLICT && response.issued_session_token {
            return Ok(true);
        }
        Ok(false)
    }

    async fn web_json<T: for<'de> Deserialize<'de>>(
        &mut self,
        client: &Client,
        method: Method,
        url: &str,
        body: Option<Value>,
        accepted: &[StatusCode],
    ) -> Result<T, String> {
        let response = self
            .request(
                client,
                method,
                Url::parse(url).map_err(|error| error.to_string())?,
                common_headers(true)?,
                body,
            )
            .await?;
        if !accepted.contains(&response.status) {
            return Err(format!(
                "Apple iCloud web session returned HTTP {}",
                response.status
            ));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| "Apple iCloud web session returned malformed JSON".to_string())
    }

    async fn request_empty(
        &mut self,
        client: &Client,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Value>,
        accepted: &[StatusCode],
    ) -> Result<(), String> {
        let response = self.request(client, method, url, headers, body).await?;
        if accepted.contains(&response.status) {
            Ok(())
        } else {
            Err(format!(
                "Apple web authentication returned HTTP {}",
                response.status
            ))
        }
    }

    async fn request(
        &mut self,
        client: &Client,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Value>,
    ) -> Result<WebResponse, String> {
        let cookie = self.cookie_header(&url);
        let mut request = client.request(method, url).headers(headers);
        if !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Apple web request failed: {error}"))?;
        let issued_session_token = response.headers().contains_key("X-Apple-Session-Token");
        self.absorb_response(&response)?;
        let status = response.status();
        let body = limited_body(response).await?;
        Ok(WebResponse {
            status,
            body,
            issued_session_token,
        })
    }

    fn auth_headers(&self) -> Result<HeaderMap, String> {
        let frame = format!("auth-{}", self.frame_id);
        let mut headers = common_headers(false)?;
        insert_header(&mut headers, "Origin", AUTH_ORIGIN)?;
        insert_header(&mut headers, "Referer", &format!("{AUTH_ORIGIN}/"))?;
        insert_header(&mut headers, "X-Apple-Widget-Key", &self.auth_client_id)?;
        insert_header(
            &mut headers,
            "X-Apple-OAuth-Client-Id",
            &self.auth_client_id,
        )?;
        insert_header(&mut headers, "X-Apple-OAuth-Client-Type", "firstPartyAuth")?;
        insert_header(&mut headers, "X-Apple-OAuth-Redirect-URI", HOME_ENDPOINT)?;
        insert_header(&mut headers, "X-Apple-OAuth-Require-Grant-Code", "true")?;
        insert_header(&mut headers, "X-Apple-OAuth-Response-Mode", "web_message")?;
        insert_header(&mut headers, "X-Apple-OAuth-Response-Type", "code")?;
        insert_header(&mut headers, "X-Apple-OAuth-State", &frame)?;
        insert_header(&mut headers, "X-Apple-Frame-Id", &frame)?;
        insert_header(&mut headers, "X-Requested-With", "XMLHttpRequest")?;
        insert_header(&mut headers, "X-Apple-Mandate-Security-Upgrade", "0")?;
        insert_header(&mut headers, "X-Apple-I-Require-UE", "true")?;
        insert_header(
            &mut headers,
            "X-Apple-I-FD-Client-Info",
            &format!(r#"{{"U":"{USER_AGENT}","L":"en-US","Z":"GMT-05:00","V":"1.1","F":""}}"#),
        )?;
        if !self.auth_attributes.is_empty() {
            insert_header(
                &mut headers,
                "X-Apple-Auth-Attributes",
                &self.auth_attributes,
            )?;
        }
        if !self.scnt.is_empty() {
            insert_header(&mut headers, "scnt", &self.scnt)?;
        }
        if !self.session_id.is_empty() {
            insert_header(&mut headers, "X-Apple-ID-Session-Id", &self.session_id)?;
        }
        Ok(headers)
    }

    fn absorb_response(&mut self, response: &reqwest::Response) -> Result<(), String> {
        if let Some(value) = header_string(response.headers(), "X-Apple-ID-Account-Country") {
            self.account_country = value;
        }
        if let Some(value) = header_string(response.headers(), "X-Apple-ID-Session-Id") {
            self.session_id = value;
        }
        if let Some(value) = header_string(response.headers(), "X-Apple-Session-Token") {
            self.session_token = value;
        }
        if let Some(value) = header_string(response.headers(), "X-Apple-TwoSV-Trust-Token") {
            self.trust_token = value;
        }
        if let Some(value) = header_string(response.headers(), "scnt") {
            self.scnt = value;
        }
        if let Some(value) = header_string(response.headers(), "X-Apple-Auth-Attributes") {
            self.auth_attributes = value;
        }
        let host = response
            .url()
            .host_str()
            .ok_or_else(|| "Apple response URL had no host".to_string())?;
        for value in response.headers().get_all(SET_COOKIE).iter() {
            if let Ok(value) = value.to_str() {
                self.absorb_cookie(host, value);
            }
        }
        Ok(())
    }

    fn absorb_cookie(&mut self, response_host: &str, header: &str) {
        let mut parts = header.split(';');
        let Some((name, value)) = parts.next().and_then(|part| part.trim().split_once('=')) else {
            return;
        };
        if name.is_empty() {
            return;
        }
        let mut domain = response_host.to_ascii_lowercase();
        let mut path = "/".to_string();
        let mut host_only = true;
        let mut secure = false;
        let mut delete = value.is_empty();
        for attribute in parts {
            let attribute = attribute.trim();
            if attribute.eq_ignore_ascii_case("secure") {
                secure = true;
            } else if let Some((key, raw)) = attribute.split_once('=') {
                if key.eq_ignore_ascii_case("domain") {
                    domain = raw.trim().trim_start_matches('.').to_ascii_lowercase();
                    host_only = false;
                } else if key.eq_ignore_ascii_case("path") {
                    path = raw.trim().to_string();
                } else if key.eq_ignore_ascii_case("max-age") && raw.trim() == "0" {
                    delete = true;
                }
            }
        }
        self.cookies.retain(|cookie| {
            !(cookie.name == name && cookie.domain == domain && cookie.path == path)
        });
        if !delete {
            self.cookies.push(WebCookie {
                name: name.to_string(),
                value: value.to_string(),
                domain,
                path,
                host_only,
                secure,
            });
        }
    }

    fn cookie_header(&self, url: &Url) -> String {
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return String::new();
        };
        self.cookies
            .iter()
            .filter(|cookie| {
                (!cookie.secure || url.scheme() == "https")
                    && url.path().starts_with(&cookie.path)
                    && if cookie.host_only {
                        host == cookie.domain
                    } else {
                        host == cookie.domain || host.ends_with(&format!(".{}", cookie.domain))
                    }
            })
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn has_cookie(&self, name: &str) -> bool {
        self.cookies
            .iter()
            .any(|cookie| cookie.name == name && !cookie.value.is_empty())
    }

    fn photos_pcs_required(&self) -> bool {
        ["ckdatabasews", "photosupload", "photos"]
            .iter()
            .any(|name| {
                self.account_info
                    .pointer(&format!("/webservices/{name}/pcsRequired"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
    }

    fn service_url(&self, name: &str) -> Result<Url, String> {
        let value = self
            .account_info
            .pointer(&format!("/webservices/{name}/url"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Apple account does not expose the {name} web service"))?;
        let url = Url::parse(value)
            .map_err(|_| format!("Apple returned an invalid {name} service URL"))?;
        if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
            return Err(format!("Apple returned an untrusted {name} service URL"));
        }
        Ok(url)
    }
}

struct WebResponse {
    status: StatusCode,
    body: Vec<u8>,
    issued_session_token: bool,
}

struct PhotoImportResult {
    asset_guid: String,
    job_id: Option<String>,
}

fn photo_import_result(row: &Value) -> Result<PhotoImportResult, String> {
    let response_status = row
        .pointer("/response/status")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let asset_guid = match row
        .get("cplAsset")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            let detail = serde_json::to_vec(row)
                .ok()
                .and_then(|body| apple_error_summary(&body))
                .map(|value| format!("; {value}"))
                .unwrap_or_default();
            let fields = row
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>().join(","))
                .unwrap_or_else(|| "non-object".to_string());
            return Err(format!(
                "Apple Photos import omitted the asset identifier (status {response_status}{detail}; fields={fields})"
            ));
        }
    };
    let job_id = row
        .get("uploadJobId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // Photos deduplicates identical bytes already in PrimarySync. In that
    // case putAsset returns 409 with the existing cplAsset and no upload job;
    // the returned asset is ready to copy into a new CMM share.
    if response_status == 409 && job_id.is_none() {
        return Ok(PhotoImportResult {
            asset_guid,
            job_id: None,
        });
    }
    if response_status == 200 {
        return Ok(PhotoImportResult {
            asset_guid,
            job_id: Some(job_id.ok_or_else(|| {
                "Apple Photos import omitted the upload job identifier".to_string()
            })?),
        });
    }

    let detail = serde_json::to_vec(row)
        .ok()
        .and_then(|body| apple_error_summary(&body))
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    let retryable = row
        .pointer("/response/isRetryable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Err(format!(
        "Apple Photos import returned status {response_status}{detail} (cplAsset=true; uploadJobId={}; retryable={retryable})",
        job_id.is_some(),
    ))
}

fn cmm_share_id(root: &Map<String, Value>) -> Result<String, String> {
    root.get("stableUrl")
        .and_then(Value::as_object)
        .ok_or_else(|| "Apple did not return a stable iCloud share URL".to_string())?;
    let share_id = root
        .get("shortGUID")
        .and_then(Value::as_str)
        .ok_or_else(|| "Apple CMM root omitted its short identifier".to_string())?
        .to_string();
    // The Photos bearer URL is the CMM root's shortGUID alone. CloudKit's
    // stableUrl.routingKey selects infrastructure internally; including it in
    // the public URL resolves the root without granting anonymous access.
    if share_id.len() < 16
        || !share_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("Apple returned an invalid iCloud share identifier".to_string());
    }
    Ok(share_id)
}

fn apple_error_summary(body: &[u8]) -> Option<String> {
    fn collect(value: &Value, output: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for key in ["serverErrorCode", "errorCode", "reason", "message"] {
                    let Some(value) = map.get(key) else {
                        continue;
                    };
                    let text = match value {
                        Value::String(value) => value.trim().to_string(),
                        Value::Number(value) => value.to_string(),
                        _ => continue,
                    };
                    if !text.is_empty() && text.len() <= 256 {
                        output.push(format!("{key}={text}"));
                    }
                }
                for value in map.values() {
                    collect(value, output);
                }
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, output);
                }
            }
            _ => {}
        }
    }

    let value: Value = serde_json::from_slice(body).ok()?;
    let mut output = Vec::new();
    collect(&value, &mut output);
    output.sort();
    output.dedup();
    (!output.is_empty()).then(|| output.join(", "))
}

fn apple_error_retryable(body: &[u8]) -> bool {
    fn find(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                map.get("isRetryable").and_then(Value::as_bool) == Some(true)
                    || ["serverErrorCode", "errorCode"]
                        .iter()
                        .filter_map(|key| map.get(*key).and_then(Value::as_str))
                        .any(|code| code == "TRY_AGAIN_LATER")
                    || map.values().any(find)
            }
            Value::Array(values) => values.iter().any(find),
            _ => false,
        }
    }

    serde_json::from_slice::<Value>(body).is_ok_and(|value| find(&value))
}

fn compact_root_record(
    mut root: Map<String, Value>,
    zone_id: &Map<String, Value>,
    owner: &str,
    zone_name: &str,
) -> Result<Value, String> {
    root.remove("displayedHostname");
    root.remove("stableUrl");
    for key in ["fields", "pluginFields"] {
        if let Some(fields) = root.get_mut(key).and_then(Value::as_object_mut) {
            for field in fields.values_mut() {
                if let Some(value) = field.get("value").cloned() {
                    *field = value;
                }
            }
        }
    }
    root.insert("zoneID".to_string(), Value::Object(zone_id.clone()));
    root.insert(
        "zone".to_string(),
        Value::String(format!("{owner}:{zone_name}")),
    );
    root.insert("scope".to_string(), Value::String("PRIVATE".to_string()));
    if root
        .get("recordChangeTag")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err("Apple CMM root omitted its change tag".to_string());
    }
    Ok(Value::Object(root))
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("failed to initialize iCloud web client: {error}"))
}

async fn limited_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response.content_length().unwrap_or_default() > MAX_RESPONSE_BYTES as u64 {
        return Err("Apple returned an unexpectedly large web response".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("failed reading Apple web response: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Apple returned an unexpectedly large web response".to_string());
    }
    Ok(bytes.to_vec())
}

fn common_headers(json_content: bool) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, "Accept", "application/json")?;
    insert_header(&mut headers, "User-Agent", USER_AGENT)?;
    insert_header(&mut headers, "Origin", HOME_ENDPOINT)?;
    insert_header(&mut headers, "Referer", &format!("{HOME_ENDPOINT}/"))?;
    if json_content {
        insert_header(&mut headers, "Content-Type", "text/plain;charset=UTF-8")?;
    } else {
        insert_header(&mut headers, "Content-Type", "application/json")?;
    }
    Ok(headers)
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), String> {
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| format!("invalid Apple header name {name}"))?;
    let value = HeaderValue::from_str(value)
        .map_err(|_| "Apple header value contained invalid bytes".to_string())?;
    headers.insert(name, value);
    Ok(())
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn validate_service_host(url: &Url, cloudkit: bool) -> Result<(), String> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let suffixes: &[&str] = if cloudkit {
        &["-ckdatabasews.icloud.com", "-ckdatabasews.icloud.com.cn"]
    } else {
        &[
            "-photosupload.icloud.com",
            "-photosupload.icloud.com.cn",
            "-uploadphotosws.icloud.com",
            "-uploadphotosws.icloud.com.cn",
        ]
    };
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || !host.starts_with('p')
        || !suffixes.iter().any(|suffix| host.ends_with(suffix))
    {
        return Err("Apple account returned an untrusted iCloud Photos service host".to_string());
    }
    Ok(())
}

fn default_auth_client_id() -> String {
    AUTH_CLIENT_ID.to_string()
}

fn new_uuid() -> String {
    Uuid::new_v4().to_string().to_lowercase()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn last_two_digits(phone: &TrustedPhoneNumber) -> String {
    let value = if phone.obfuscated_number.is_empty() {
        &phone.number_with_dial_code
    } else {
        &phone.obfuscated_number
    };
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    digits
        .chars()
        .rev()
        .take(2)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_scope_and_tombstones_are_honored() {
        let mut session = ICloudWebSession::default();
        session.absorb_cookie("www.icloud.com", "session=secret; Path=/; Secure; HttpOnly");
        session.absorb_cookie("www.icloud.com", "shared=value; Domain=.icloud.com; Path=/");
        let setup = Url::parse("https://setup.icloud.com/setup/ws/1/validate").unwrap();
        let home = Url::parse("https://www.icloud.com/photos/").unwrap();
        assert_eq!(session.cookie_header(&setup), "shared=value");
        assert!(session.cookie_header(&home).contains("session=secret"));
        session.absorb_cookie("www.icloud.com", "session=; Path=/; Max-Age=0");
        assert!(!session.cookie_header(&home).contains("session="));
    }

    #[test]
    fn compact_root_matches_cloudkit_share_shape() {
        let root = serde_json::from_value::<Map<String, Value>>(json!({
            "recordName": "cmm-root",
            "recordType": "CMMRoot",
            "recordChangeTag": "1",
            "fields": { "photosCount": { "value": 1, "type": "INT64" } },
            "pluginFields": { "expiryDate": { "value": 123, "type": "TIMESTAMP" } },
            "stableUrl": { "protectedFullToken": "secret" },
            "displayedHostname": "www.icloud.com"
        }))
        .unwrap();
        let zone = serde_json::from_value::<Map<String, Value>>(json!({
            "zoneName": "CMM-test",
            "ownerRecordName": "_owner",
            "zoneType": "REGULAR_CUSTOM_ZONE"
        }))
        .unwrap();
        let compact = compact_root_record(root, &zone, "_owner", "CMM-test").unwrap();
        assert_eq!(compact.pointer("/fields/photosCount"), Some(&json!(1)));
        assert_eq!(
            compact.pointer("/pluginFields/expiryDate"),
            Some(&json!(123))
        );
        assert_eq!(compact.get("zone"), Some(&json!("_owner:CMM-test")));
        assert!(compact.get("stableUrl").is_none());
    }

    #[test]
    fn duplicate_photo_import_reuses_the_existing_asset() {
        let import = photo_import_result(&json!({
            "cplAsset": "asset-guid",
            "cplMaster": "master-guid",
            "response": { "status": 409, "isRetryable": false }
        }))
        .unwrap();
        assert_eq!(import.asset_guid, "asset-guid");
        assert!(import.job_id.is_none());
    }

    #[test]
    fn successful_photo_import_requires_a_polling_job() {
        let import = photo_import_result(&json!({
            "cplAsset": "asset-guid",
            "uploadJobId": "job-guid",
            "response": { "status": 200, "isRetryable": false }
        }))
        .unwrap();
        assert_eq!(import.asset_guid, "asset-guid");
        assert_eq!(import.job_id.as_deref(), Some("job-guid"));

        let error = photo_import_result(&json!({
            "cplAsset": "asset-guid",
            "response": { "status": 200, "isRetryable": false }
        }))
        .err()
        .unwrap();
        assert!(error.contains("upload job identifier"));
    }

    #[test]
    fn cmm_public_url_uses_only_the_short_guid() {
        let root = serde_json::from_value::<Map<String, Value>>(json!({
            "stableUrl": { "routingKey": "050" },
            "shortGUID": "0A1ExampleCmmShareGuid"
        }))
        .unwrap();
        assert_eq!(cmm_share_id(&root).unwrap(), "0A1ExampleCmmShareGuid");
    }

    #[test]
    fn share_media_validation_accepts_photos_and_videos_by_content() {
        assert_eq!(
            validate_share_media(b"\xff\xd8\xfffixture", "image/jpeg").unwrap(),
            ShareMediaKind::Photo
        );
        assert_eq!(
            validate_share_media(b"\x89PNG\r\n\x1a\nfixture", "image/png").unwrap(),
            ShareMediaKind::Photo
        );
        assert_eq!(
            validate_share_media(b"\0\0\0\x18ftypheicfixture", "image/heic").unwrap(),
            ShareMediaKind::Photo
        );
        assert_eq!(
            validate_share_media(b"\0\0\0\x18ftypqt  fixture", "video/quicktime").unwrap(),
            ShareMediaKind::Video
        );
        assert!(validate_share_media(b"GIF89a fixture", "image/gif").is_err());
        assert!(validate_share_media(b"not a png", "image/png").is_err());
        let preview = BASE64.decode(VIDEO_PREVIEW_JPEG_BASE64).unwrap();
        assert!(preview.starts_with(&[0xff, 0xd8, 0xff]));
    }

    #[test]
    fn png_share_preview_is_a_bounded_jpeg() {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            1200,
            900,
            image::Rgb([0, 210, 255]),
        ));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let (preview, mime_type) = share_preview(
            Path::new("unused.png"),
            png.get_ref(),
            "image/png",
            ShareMediaKind::Photo,
        )
        .unwrap();
        assert_eq!(mime_type, "image/jpeg");
        assert!(preview.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(preview.len() <= CMM_PREVIEW_MAX_BYTES);
    }

    #[test]
    fn explicit_apple_try_again_later_is_retryable() {
        assert!(apple_error_retryable(
            br#"{"response":{"status":409,"isRetryable":true,"serverErrorCode":"TRY_AGAIN_LATER"}}"#,
        ));
        assert!(!apple_error_retryable(
            br#"{"response":{"status":409,"isRetryable":false,"serverErrorCode":"CONFLICT"}}"#,
        ));
    }
}
