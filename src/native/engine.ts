import { EventEmitter } from "node:events";

import type {
  EngineNotificationMap,
  EngineSnapshot,
  EngineVersion,
  IdsLookupResult,
  IdsRegistrationInspection,
  InitializeParams,
  NativeFindMyFollow,
  SendAttachmentParams,
  SendEditParams,
  SendGroupIconParams,
  SendGroupLeaveParams,
  SendGroupParticipantsParams,
  SendGroupRenameParams,
  SendMessageParams,
  SendMarkUnreadParams,
  SendMultipartMessageParams,
  SendNotifyParams,
  SendReadReceiptParams,
  SendReactionParams,
  SendPollVoteParams,
  SendTypingParams,
  SendUnsendParams,
  ValidateHandlesParams,
} from "../types.js";
import { NativeRpcClient, type NativeRpcClientOptions } from "./rpc-client.js";

export interface LoginStartResult {
  needs2fa: boolean;
  challenge?: "trusted-device" | "sms";
}

export interface TwoFactorPhoneOption {
  id: number;
  lastTwoDigits: string;
}

export interface IMessageEngine {
  initialize(params: InitializeParams): Promise<EngineSnapshot>;
  loginStart(appleId: string, password: string): Promise<LoginStartResult>;
  login2faOptions(): Promise<{ phones: TwoFactorPhoneOption[] }>;
  loginRequestSms(phoneId: number): Promise<{ sent: boolean }>;
  loginSubmit2fa(code: string): Promise<{ accepted: boolean }>;
  loginFinish(): Promise<EngineSnapshot>;
  migrateCredentialToFile(keyPath: string): Promise<{ migrated: boolean; credentialBackend: string }>;
  startClient(): Promise<EngineSnapshot>;
  snapshot(): Promise<EngineSnapshot>;
  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }>;
  refreshFindMyFollowing?(address?: string, findMyIds?: string[]): Promise<NativeFindMyFollow[]>;
  sendMessage(params: SendMessageParams): Promise<{ guid: string }>;
  sendReaction(params: SendReactionParams): Promise<{ guid: string }>;
  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }>;
  sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }>;
  sendMultipartMessage(params: SendMultipartMessageParams): Promise<{ guid: string }>;
  renameGroup(params: SendGroupRenameParams): Promise<{ guid: string }>;
  changeGroupParticipants(params: SendGroupParticipantsParams): Promise<{ guid: string }>;
  leaveGroup(params: SendGroupLeaveParams): Promise<{ guid: string }>;
  setGroupIcon(params: SendGroupIconParams): Promise<{ guid: string }>;
  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }>;
  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult>;
  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }>;
  sendEdit(params: SendEditParams): Promise<{ guid: string }>;
  sendUnsend(params: SendUnsendParams): Promise<{ guid: string }>;
  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }>;
  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }>;
  sendMarkUnread(params: SendMarkUnreadParams): Promise<{ sent: boolean }>;
  sendNotify(params: SendNotifyParams): Promise<{ guid: string }>;
  close(): Promise<void>;
  on<K extends keyof EngineNotificationMap>(
    event: K,
    listener: (payload: EngineNotificationMap[K]) => void,
  ): this;
}

export class NativeEngine extends EventEmitter implements IMessageEngine {
  readonly rpc: NativeRpcClient;

  constructor(options: NativeRpcClientOptions) {
    super();
    this.rpc = new NativeRpcClient(options);
    this.rpc.on("notification", ({ method, params }: { method: string; params: unknown }) => {
      this.emit(method, params);
    });
    this.rpc.on("engine.log", (entry) => this.emit("engine.log", entry));
  }

  version(): Promise<EngineVersion> {
    return this.rpc.request("system.version");
  }

  initialize(params: InitializeParams): Promise<EngineSnapshot> {
    return this.rpc.request("system.initialize", params);
  }

  loginStart(appleId: string, password: string): Promise<LoginStartResult> {
    return this.rpc.request("account.login.start", { appleId, password });
  }

  login2faOptions(): Promise<{ phones: TwoFactorPhoneOption[] }> {
    return this.rpc.request("account.login.2fa.options");
  }

  loginRequestSms(phoneId: number): Promise<{ sent: boolean }> {
    return this.rpc.request("account.login.2fa.requestSms", { phoneId });
  }

  loginSubmit2fa(code: string): Promise<{ accepted: boolean }> {
    return this.rpc.request("account.login.submit2fa", { code });
  }

  loginFinish(): Promise<EngineSnapshot> {
    return this.rpc.request("account.login.finish");
  }

  migrateCredentialToFile(keyPath: string): Promise<{ migrated: boolean; credentialBackend: string }> {
    return this.rpc.request("account.credentials.migrateToFile", { keyPath });
  }

  logout(deregister = true): Promise<{ deregistered: boolean; credentialDeleted: boolean }> {
    return this.rpc.request("account.logout", { deregister });
  }

  inspectSavedRegistration(users: string): Promise<IdsRegistrationInspection> {
    return this.rpc.request("account.registration.inspect", { users });
  }

  startClient(): Promise<EngineSnapshot> {
    return this.rpc.request("client.start");
  }

  refreshRegistration(): Promise<{ registeredServices: number; snapshot: EngineSnapshot }> {
    return this.rpc.request("account.registration.refresh");
  }

  snapshot(): Promise<EngineSnapshot> {
    return this.rpc.request("system.snapshot");
  }

  health(): Promise<{ clientStarted: boolean; secondsSinceLastInbound: number }> {
    return this.rpc.request("system.health");
  }

  refreshFindMyFollowing(address?: string, findMyIds?: string[]): Promise<NativeFindMyFollow[]> {
    return this.rpc.request("findmy.following", { address, findMyIds });
  }

  sendMessage(params: SendMessageParams): Promise<{ guid: string }> {
    return this.rpc.request("message.send", params);
  }

  sendReaction(params: SendReactionParams): Promise<{ guid: string }> {
    return this.rpc.request("reaction.send", params);
  }

  sendPollVote(params: SendPollVoteParams): Promise<{ guid: string }> {
    return this.rpc.request("poll.vote", params);
  }

  sendAttachment(params: SendAttachmentParams): Promise<{ guid: string }> {
    return this.rpc.request("attachment.send", params);
  }

  sendMultipartMessage(params: SendMultipartMessageParams): Promise<{ guid: string }> {
    return this.rpc.request("message.multipart.send", params);
  }

  renameGroup(params: SendGroupRenameParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.rename", params);
  }

  changeGroupParticipants(params: SendGroupParticipantsParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.participants.change", params);
  }

  leaveGroup(params: SendGroupLeaveParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.leave", params);
  }

  setGroupIcon(params: SendGroupIconParams): Promise<{ guid: string }> {
    return this.rpc.request("chat.icon.set", params);
  }

  validateHandles(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    return this.rpc.request("handle.validate", params);
  }

  lookupHandles(params: ValidateHandlesParams): Promise<IdsLookupResult> {
    return this.rpc.request("handle.lookup", params);
  }

  validateHandlesHttp(params: ValidateHandlesParams): Promise<{ available: string[] }> {
    return this.rpc.request("handle.validateHttp", params);
  }

  sendEdit(params: SendEditParams): Promise<{ guid: string }> {
    return this.rpc.request("message.edit", params);
  }

  sendUnsend(params: SendUnsendParams): Promise<{ guid: string }> {
    return this.rpc.request("message.unsend", params);
  }

  sendTyping(params: SendTypingParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.typing", params);
  }

  sendReadReceipt(params: SendReadReceiptParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.read", params);
  }

  sendMarkUnread(params: SendMarkUnreadParams): Promise<{ sent: boolean }> {
    return this.rpc.request("chat.unread", params);
  }

  sendNotify(params: SendNotifyParams): Promise<{ guid: string }> {
    return this.rpc.request("message.notify", params);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
