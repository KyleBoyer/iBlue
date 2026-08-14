import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

import type {
  FaceTimeIncomingSession,
  FaceTimeNativeMediaStatus,
  FaceTimeSessionCreateParams,
  FaceTimeSessionStart,
} from "../native/engine.js";

const execFileAsync = promisify(execFile);

export type FaceTimeMediaMode = "audio" | "video";
export type FaceTimeCallState =
  | "preparing"
  | "waiting-for-media"
  | "ringing"
  | "active"
  | "ending"
  | "ended"
  | "failed";

export interface FaceTimeCall {
  id: string;
  sessionId?: string;
  direction: "incoming" | "outgoing";
  mode: FaceTimeMediaMode;
  targets: string[];
  displayName: string;
  state: FaceTimeCallState;
  createdAt: number;
  updatedAt: number;
  answeredAt?: number;
  endedAt?: number;
  maxDurationSeconds: number;
  mediaDurationSeconds?: number;
  nativeAudioInput?: "transcoded-aac-eld" | "transcoded-evs" | "passthrough-aac-eld";
  nativeVideoInput?: "transcoded-hevc" | "passthrough-hevc";
  mediaSource?: "uploaded" | "live-stream";
  liveAudioFormat?: {
    encoding: "pcm-f32le";
    sampleRate: 24_000;
    channels: 1;
    frameDurationMs: 20;
    frameBytes: 1_920;
  };
  mediaCaptureStartedAt?: number;
  participantCount: number;
  webParticipantCount?: number;
  activeWebGuestCount?: number;
  mediaConnectionState?: string;
  outboundAudioBytes?: number;
  outboundAudioEnergy?: number;
  inboundAudioBytes?: number;
  outboundVideoBytes?: number;
  outboundVideoFrames?: number;
  inboundVideoBytes?: number;
  inboundVideoFrames?: number;
  nativeMediaState?: FaceTimeNativeMediaStatus["state"];
  nativePacketsTotal?: number;
  nativePacketsSent?: number;
  nativePayloadBytesTotal?: number;
  nativePayloadBytesSent?: number;
  nativeAudioPacketsTotal?: number;
  nativeAudioPayloadBytesTotal?: number;
  nativeAudioPacketsSent?: number;
  nativeAudioPayloadBytesSent?: number;
  nativeVideoFramesTotal?: number;
  nativeVideoFramesSent?: number;
  nativeVideoSourceBytesTotal?: number;
  nativeVideoPacketsSent?: number;
  nativeVideoPayloadBytesSent?: number;
  nativeControlMessagesReceived?: number;
  nativeControlMessagesAuthenticated?: number;
  nativeControlMessagesSent?: number;
  nativeControlStreamStateSent?: boolean;
  nativeControlStreamStateAcknowledged?: boolean;
  nativeControlReady?: boolean;
  nativeControlParticipantContexts?: number;
  nativeControlPeerUuids?: number;
  nativeControlMediaKeys?: number;
  nativeControlLastError?: string;
  nativePeerAudioFeedbackUpdates?: number;
  nativePeerAudioFeedbackSequence?: number;
  nativePeerAudioKbReceived?: number;
  nativePeerAudioPacketsReceived?: number;
  nativePeerAudioPayloadType?: number;
  nativePeerAudioRtpExtensionProfile?: number;
  nativePeerAudioRtpExtensionHex?: string;
  nativePeerVideoPacketsReceived?: number;
  nativePeerVideoSsrc?: number;
  nativePeerVideoRtpExtensionProfile?: number;
  nativePeerVideoRtpExtensionHex?: string;
  error?: string;
  transport: "iblue-quickrelay" | "apple-web-bridge";
}

interface InternalFaceTimeCall extends FaceTimeCall {
  sourcePath: string;
  workDirectory?: string;
  audioPath?: string;
  videoPath?: string;
  videoDescriptionPath?: string;
  browser?: Browser;
  page?: Page;
  session?: FaceTimeSessionStart;
  stopRequested: boolean;
  finishing?: Promise<void>;
}

export interface FaceTimeCallInput {
  mode: FaceTimeMediaMode;
  targets: string[];
  displayName: string;
  sourcePath: string;
  from?: string;
  maxDurationSeconds?: number;
  preRollSeconds?: number;
  nativeAudioPassthrough?: boolean;
  nativeVideoPassthrough?: boolean;
}

export interface FaceTimeLiveAudioCallInput {
  targets: string[];
  displayName: string;
  from?: string;
  maxDurationSeconds?: number;
}

export interface FaceTimeIncomingCallInput {
  sessionId: string;
  displayName: string;
  sourcePath: string;
  maxDurationSeconds?: number;
  nativeAudioPassthrough?: boolean;
  nativeVideoPassthrough?: boolean;
}

export interface FaceTimeMediaSignaling {
  createSession(params: FaceTimeSessionCreateParams): Promise<FaceTimeSessionStart>;
  listSessions(): Promise<unknown>;
  ringSession(sessionId: string, targets: string[]): Promise<unknown>;
  confirmMediaJoined(sessionId: string): Promise<unknown>;
  leaveSession(sessionId: string): Promise<unknown>;
  createNativeMediaSession?(params: {
    targets: string[];
    from?: string;
    audioPath: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
  }): Promise<{ sessionId: string }>;
  startNativeMediaSession?(sessionId: string): Promise<unknown>;
  nativeMediaStatus?(sessionId: string): Promise<FaceTimeNativeMediaStatus>;
  listIncomingSessions?(): Promise<FaceTimeIncomingSession[]>;
  answerIncomingSession?(params: {
    sessionId: string;
    audioPath?: string;
    videoPath?: string;
    videoDescriptionPath?: string;
    videoFrameDurationMs?: number;
  }): Promise<FaceTimeIncomingSession>;
  declineIncomingSession?(sessionId: string): Promise<FaceTimeIncomingSession>;
  createNativeLiveAudioSession?(params: {
    targets: string[];
    from?: string;
    ring?: boolean;
  }): Promise<{
    sessionId: string;
    from: string;
    targets: string[];
    state: "allocated" | "ringing";
    transport: "iblue-quickrelay";
    topology: "one-to-one";
    mediaSource: "live-stream";
    audioFormat: {
      encoding: "pcm-f32le";
      sampleRate: 24_000;
      channels: 1;
      frameDurationMs: 20;
      frameBytes: 1_920;
    };
  }>;
  startNativeLiveAudioStream?(sessionId: string): Promise<unknown>;
  pushNativeLiveAudioFrame?(sessionId: string, frame: Buffer): Promise<unknown>;
  finishNativeLiveAudioStream?(sessionId: string): Promise<unknown>;
}

export interface FaceTimeMediaManagerOptions {
  signaling: FaceTimeMediaSignaling;
  onUpdate?: (call: FaceTimeCall) => void;
  chromePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  afconvertPath?: string;
}

const TERMINAL_STATES = new Set<FaceTimeCallState>(["ended", "failed"]);
const NATIVE_MEDIA_POST_ANSWER_SETTLE_MS = 3_000;
const WINDOWS_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export function extractHvc1SampleEntry(movie: Buffer): Buffer {
  for (let typeOffset = 4; typeOffset + 4 <= movie.length; typeOffset += 1) {
    if (movie.toString("ascii", typeOffset, typeOffset + 4) !== "hvc1") continue;
    const boxOffset = typeOffset - 4;
    const size = movie.readUInt32BE(boxOffset);
    if (size < 86 || size > 64 * 1024 || boxOffset + size > movie.length) continue;
    const entry = movie.subarray(boxOffset, boxOffset + size);
    if (entry.indexOf(Buffer.from("hvcC", "ascii")) < 0) continue;
    return Buffer.from(entry);
  }
  throw new Error("Encoded FaceTime video does not contain an hvc1 sample entry with hvcC");
}

function extractHevcParameterSets(sampleEntry: Buffer): Map<number, Buffer> {
  const hvcCTypeOffset = sampleEntry.indexOf(Buffer.from("hvcC", "ascii"));
  if (hvcCTypeOffset < 4) {
    throw new Error("Encoded FaceTime video does not contain an hvcC decoder configuration");
  }
  const boxOffset = hvcCTypeOffset - 4;
  const boxSize = sampleEntry.readUInt32BE(boxOffset);
  const payloadOffset = hvcCTypeOffset + 4;
  const boxEnd = boxOffset + boxSize;
  if (boxSize < 31 || boxEnd > sampleEntry.length || payloadOffset + 23 > boxEnd) {
    throw new Error("Encoded FaceTime hvcC decoder configuration is truncated");
  }

  const parameterSets = new Map<number, Buffer>();
  const arrayCount = sampleEntry[payloadOffset + 22]!;
  let offset = payloadOffset + 23;
  for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
    if (offset + 3 > boxEnd) {
      throw new Error("Encoded FaceTime hvcC parameter array is truncated");
    }
    const nalType = sampleEntry[offset]! & 0x3f;
    const nalCount = sampleEntry.readUInt16BE(offset + 1);
    offset += 3;
    for (let nalIndex = 0; nalIndex < nalCount; nalIndex += 1) {
      if (offset + 2 > boxEnd) {
        throw new Error("Encoded FaceTime hvcC parameter length is truncated");
      }
      const nalSize = sampleEntry.readUInt16BE(offset);
      offset += 2;
      if (offset + nalSize > boxEnd) {
        throw new Error("Encoded FaceTime hvcC parameter data is truncated");
      }
      if (!parameterSets.has(nalType)) {
        parameterSets.set(nalType, Buffer.from(sampleEntry.subarray(offset, offset + nalSize)));
      }
      offset += nalSize;
    }
  }
  for (const nalType of [32, 33, 34]) {
    if (!parameterSets.has(nalType)) {
      throw new Error(`Encoded FaceTime hvcC is missing HEVC NAL type ${nalType}`);
    }
  }
  return parameterSets;
}

/**
 * Convert FFmpeg's hvc1 sample entry into the exact ImageDescription shape
 * emitted by Apple's AVConference stack. The decoder parameter sets remain
 * those of the encoded source; container-only fields use Apple's canonical
 * values instead of FFmpeg's data reference, vendor, compressor name, and
 * optional fiel/pasp child boxes.
 */
export function buildFaceTimeHvc1SampleEntry(movie: Buffer): Buffer {
  const parameterSets = extractHevcParameterSets(extractHvc1SampleEntry(movie));
  const arrays: Buffer[] = [];
  for (const nalType of [32, 33, 34]) {
    const nal = parameterSets.get(nalType)!;
    if (nal.length > 0xffff) {
      throw new Error(`Encoded FaceTime HEVC NAL type ${nalType} is too large`);
    }
    const array = Buffer.alloc(5 + nal.length);
    array[0] = 0x80 | nalType;
    array.writeUInt16BE(1, 1);
    array.writeUInt16BE(nal.length, 3);
    nal.copy(array, 5);
    arrays.push(array);
  }

  // HEVCDecoderConfigurationRecord values mirror Apple's native
  // ImageDescription::new_hevc implementation. The VPS/SPS/PPS arrays below
  // are source-specific and therefore remain synchronized with the frames.
  const hvcCPayload = Buffer.concat([
    Buffer.from([
      0x01, 0x01,
      0x60, 0x00, 0x00, 0x00,
      0xb0, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x78,
      0xf0, 0x00,
      0xfc, 0xfd, 0xf8, 0xf8,
      0x00, 0x00,
      0x0b,
      0x03,
    ]),
    ...arrays,
  ]);
  const hvcC = Buffer.alloc(8 + hvcCPayload.length);
  hvcC.writeUInt32BE(hvcC.length, 0);
  hvcC.write("hvcC", 4, 4, "ascii");
  hvcCPayload.copy(hvcC, 8);

  const entry = Buffer.alloc(86 + hvcC.length + 4);
  entry.writeUInt32BE(entry.length, 0);
  entry.write("hvc1", 4, 4, "ascii");
  entry.writeUInt16BE(0xffff, 14);
  entry.writeUInt32BE(512, 24);
  entry.writeUInt32BE(512, 28);
  entry.writeUInt16BE(1920, 32);
  entry.writeUInt16BE(1080, 34);
  entry.writeUInt32BE(0x0048_0000, 36);
  entry.writeUInt32BE(0x0048_0000, 40);
  entry.writeUInt16BE(1, 48);
  entry[50] = 4;
  entry.write("HEVC", 51, 4, "ascii");
  entry.writeUInt16BE(24, 82);
  entry.writeInt16BE(-1, 84);
  hvcC.copy(entry, 86);
  return entry;
}

function publicCall(call: InternalFaceTimeCall): FaceTimeCall {
  const {
    sourcePath: _sourcePath,
    workDirectory: _workDirectory,
    audioPath: _audioPath,
    videoPath: _videoPath,
    videoDescriptionPath: _videoDescriptionPath,
    browser: _browser,
    page: _page,
    session: _session,
    stopRequested: _stopRequested,
    finishing: _finishing,
    ...result
  } = call;
  return structuredClone(result);
}

export function applyNativeFaceTimeMediaStatus(
  call: FaceTimeCall,
  native: FaceTimeNativeMediaStatus,
): void {
  call.nativeMediaState = native.state;
  call.nativePacketsTotal = native.packetsTotal;
  call.nativePacketsSent = native.packetsSent;
  call.nativePayloadBytesTotal = native.payloadBytesTotal;
  call.nativePayloadBytesSent = native.payloadBytesSent;
  call.nativeAudioPacketsTotal = native.audioPacketsTotal;
  call.nativeAudioPayloadBytesTotal = native.audioPayloadBytesTotal;
  call.nativeAudioPacketsSent = native.audioPacketsSent;
  call.nativeAudioPayloadBytesSent = native.audioPayloadBytesSent;
  call.nativeVideoFramesTotal = native.videoFramesTotal;
  call.nativeVideoFramesSent = native.videoFramesSent;
  call.nativeVideoSourceBytesTotal = native.videoSourceBytesTotal;
  call.nativeVideoPacketsSent = native.videoPacketsSent;
  call.nativeVideoPayloadBytesSent = native.videoPayloadBytesSent;
  call.nativeControlMessagesReceived = native.controlMessagesReceived;
  call.nativeControlMessagesAuthenticated = native.controlMessagesAuthenticated;
  call.nativeControlMessagesSent = native.controlMessagesSent;
  call.nativeControlStreamStateSent = native.controlStreamStateSent;
  call.nativeControlStreamStateAcknowledged = native.controlStreamStateAcknowledged;
  call.nativeControlReady = native.controlReady;
  call.nativeControlParticipantContexts = native.controlParticipantContexts;
  call.nativeControlPeerUuids = native.controlPeerUuids;
  call.nativeControlMediaKeys = native.controlMediaKeys;
  call.nativePeerAudioFeedbackUpdates = native.peerAudioFeedbackUpdates;
  call.nativePeerAudioFeedbackSequence = native.peerAudioFeedbackSequence;
  call.nativePeerAudioKbReceived = native.peerAudioKbReceived;
  call.nativePeerAudioPacketsReceived = native.peerAudioPacketsReceived;
  if (native.peerAudioPayloadType !== undefined) {
    call.nativePeerAudioPayloadType = native.peerAudioPayloadType;
  }
  if (native.peerAudioRtpExtensionProfile !== undefined) {
    call.nativePeerAudioRtpExtensionProfile = native.peerAudioRtpExtensionProfile;
  }
  if (native.peerAudioRtpExtensionHex !== undefined) {
    call.nativePeerAudioRtpExtensionHex = native.peerAudioRtpExtensionHex;
  }
  call.nativePeerVideoPacketsReceived = native.peerVideoPacketsReceived;
  if (native.peerVideoSsrc !== undefined) {
    call.nativePeerVideoSsrc = native.peerVideoSsrc;
  }
  if (native.peerVideoRtpExtensionProfile !== undefined) {
    call.nativePeerVideoRtpExtensionProfile = native.peerVideoRtpExtensionProfile;
  }
  if (native.peerVideoRtpExtensionHex !== undefined) {
    call.nativePeerVideoRtpExtensionHex = native.peerVideoRtpExtensionHex;
  }
  if (native.controlLastError) call.nativeControlLastError = native.controlLastError;
  else delete call.nativeControlLastError;
  if (native.error) call.error = native.error;
}

function resolveExecutable(explicit: string | undefined, candidates: string[]): string {
  const value = explicit || candidates.find(existsSync);
  if (!value || !existsSync(value)) {
    throw new Error(`Required executable was not found (${candidates.join(", ")})`);
  }
  return value;
}

function activeTargetsInSession(
  snapshot: unknown,
  sessionId: string,
  targets: readonly string[],
): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const sessions = (snapshot as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object") return 0;
  const session = (sessions as Record<string, unknown>)[sessionId];
  if (!session || typeof session !== "object") return 0;
  const participants = (session as { participants?: unknown }).participants;
  if (!participants || typeof participants !== "object") return 0;
  const targetSet = new Set(targets.map((target) => target.toLowerCase()));
  return Object.values(participants).filter((participant) => {
    if (!participant || typeof participant !== "object") return false;
    const value = participant as { active?: unknown; handle?: unknown };
    return typeof value.handle === "string"
      && targetSet.has(value.handle.toLowerCase())
      && value.active != null;
  }).length;
}

function activeWebGuestsInSession(snapshot: unknown, sessionId: string): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const sessions = (snapshot as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object") return 0;
  const session = (sessions as Record<string, unknown>)[sessionId];
  if (!session || typeof session !== "object") return 0;
  const participants = (session as { participants?: unknown }).participants;
  if (!participants || typeof participants !== "object") return 0;
  return Object.values(participants).filter((participant) => {
    if (!participant || typeof participant !== "object") return false;
    const value = participant as { active?: unknown; handle?: unknown };
    return typeof value.handle === "string"
      && value.handle.toLowerCase().startsWith("temp:")
      && value.active != null;
  }).length;
}

interface FaceTimeWebMediaState {
  participants: number;
  ended: boolean;
  connectionState: string;
  outboundAudioBytes: number;
  outboundAudioEnergy: number;
  inboundAudioBytes: number;
  outboundVideoBytes: number;
  outboundVideoFrames: number;
  inboundVideoBytes: number;
  inboundVideoFrames: number;
  captureStartedAt?: number;
  playbackEnded: boolean;
}

async function inspectWebMedia(page: Page): Promise<FaceTimeWebMediaState> {
  return page.evaluate(async () => {
    const text = document.body?.innerText ?? "";
    const people = [...text.matchAll(/\b(\d+)\s+(?:People|Person)\b/gi)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    const peers = (globalThis as unknown as {
      __ibluePeerConnections?: RTCPeerConnection[];
    }).__ibluePeerConnections ?? [];
    let outboundAudioBytes = 0;
    let outboundAudioEnergy = 0;
    let inboundAudioBytes = 0;
    let outboundVideoBytes = 0;
    let outboundVideoFrames = 0;
    let inboundVideoBytes = 0;
    let inboundVideoFrames = 0;
    for (const peer of peers) {
      for (const report of (await peer.getStats()).values()) {
        const mediaKind = report.kind ?? report.mediaType;
        if (report.type === "outbound-rtp" && mediaKind === "audio") {
          outboundAudioBytes += Number(report.bytesSent ?? 0);
        }
        if (report.type === "media-source" && mediaKind === "audio") {
          outboundAudioEnergy += Number(report.totalAudioEnergy ?? 0);
        }
        if (report.type === "inbound-rtp" && mediaKind === "audio") {
          inboundAudioBytes += Number(report.bytesReceived ?? 0);
        }
        if (report.type === "outbound-rtp" && mediaKind === "video") {
          outboundVideoBytes += Number(report.bytesSent ?? 0);
          outboundVideoFrames += Number(report.framesEncoded ?? report.framesSent ?? 0);
        }
        if (report.type === "inbound-rtp" && mediaKind === "video") {
          inboundVideoBytes += Number(report.bytesReceived ?? 0);
          inboundVideoFrames += Number(report.framesDecoded ?? report.framesReceived ?? 0);
        }
      }
    }
    const captureStartedAt = Number((globalThis as unknown as {
      __iblueMediaCaptureStartedAt?: number;
    }).__iblueMediaCaptureStartedAt ?? 0);
    const playbackEnded = Boolean((globalThis as unknown as {
      __iblueAudioPlaybackEnded?: boolean;
    }).__iblueAudioPlaybackEnded);
    return {
      participants: people.length === 0 ? 0 : Math.max(...people),
      ended: /conversation (?:has )?ended|call ended|disconnected/i.test(text),
      connectionState: peers.map((peer) => peer.connectionState).join(",") || "unknown",
      outboundAudioBytes,
      outboundAudioEnergy,
      inboundAudioBytes,
      outboundVideoBytes,
      outboundVideoFrames,
      inboundVideoBytes,
      inboundVideoFrames,
      playbackEnded,
      ...(captureStartedAt > 0 ? { captureStartedAt } : {}),
    };
  });
}

function applyWebMediaState(call: InternalFaceTimeCall, web: FaceTimeWebMediaState): void {
  call.webParticipantCount = web.participants;
  call.mediaConnectionState = web.connectionState;
  call.outboundAudioBytes = web.outboundAudioBytes;
  call.outboundAudioEnergy = web.outboundAudioEnergy;
  call.inboundAudioBytes = web.inboundAudioBytes;
  call.outboundVideoBytes = web.outboundVideoBytes;
  call.outboundVideoFrames = web.outboundVideoFrames;
  call.inboundVideoBytes = web.inboundVideoBytes;
  call.inboundVideoFrames = web.inboundVideoFrames;
  if (web.captureStartedAt) call.mediaCaptureStartedAt = web.captureStartedAt;
}

export function faceTimeMediaStopDeadline(
  safetyDeadline: number,
  captureStartedAt?: number,
  mediaDurationSeconds?: number,
): number {
  if (!captureStartedAt || !mediaDurationSeconds || mediaDurationSeconds <= 0) {
    return safetyDeadline;
  }
  // Chromium loops fake capture files. Leave a small margin so the browser is
  // torn down before it can wrap the source back to its first frame/sample.
  return Math.min(
    safetyDeadline,
    captureStartedAt + mediaDurationSeconds * 1_000 - 200,
  );
}

export interface AacEldCafInfo {
  packetCount: number;
  payloadBytes: number;
  durationSeconds: number;
  sampleRate: 24_000 | 48_000;
}

export interface EvsPcmInfo {
  sampleCount: number;
  packetCount: number;
  durationSeconds: number;
}

/** Validate the float32 PCM boundary consumed by Apple's private EVS shim. */
export function inspectEvsPcmF32Le(pcm: Buffer): EvsPcmInfo {
  if (pcm.length === 0 || pcm.length % 4 !== 0) {
    throw new Error("Native FaceTime EVS input must contain little-endian float32 PCM");
  }
  const sampleCount = pcm.length / 4;
  const packetCount = Math.ceil(sampleCount / 480);
  if (packetCount > 30_000) {
    throw new Error("Native FaceTime EVS input exceeds the supported duration");
  }
  return {
    sampleCount,
    packetCount,
    durationSeconds: sampleCount / 24_000,
  };
}

/**
 * Validate the narrow CAF shape accepted by the native FaceTime sender.
 * The Rust boundary repeats these checks before reading any access unit; this
 * preflight prevents an invalid diagnostic upload from ringing a callee first.
 */
export function inspectAacEldCaf(caf: Buffer): AacEldCafInfo {
  if (caf.length < 8 || caf.subarray(0, 4).toString("ascii") !== "caff") {
    throw new Error("Native audio passthrough requires an Apple CAF file");
  }
  let sampleRate: 24_000 | 48_000 | undefined;
  let packetCount: number | undefined;
  let packetBytes: number | undefined;
  let dataBytes: number | undefined;
  let offset = 8;
  while (offset + 12 <= caf.length) {
    const tag = caf.subarray(offset, offset + 4).toString("ascii");
    const rawSize = caf.readBigInt64BE(offset + 4);
    if (rawSize < 0n || rawSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Native audio CAF contains an unsupported chunk size");
    }
    const size = Number(rawSize);
    const start = offset + 12;
    const end = start + size;
    if (!Number.isSafeInteger(end) || end > caf.length) {
      throw new Error("Native audio CAF contains a truncated chunk");
    }
    if (tag === "desc" && size >= 32) {
      const describedRate = caf.readDoubleBE(start);
      if (
        caf.subarray(start + 8, start + 12).toString("ascii") === "aace"
        && (describedRate === 24_000 || describedRate === 48_000)
        && caf.readUInt32BE(start + 20) === 480
      ) {
        sampleRate = describedRate;
      }
    } else if (tag === "pakt" && size >= 24) {
      const rawPacketCount = caf.readBigUInt64BE(start);
      if (rawPacketCount === 0n || rawPacketCount > 1_000_000n) {
        throw new Error("Native audio CAF has an invalid packet count");
      }
      packetCount = Number(rawPacketCount);
      let cursor = start + 24;
      let total = 0;
      for (let packet = 0; packet < packetCount; packet += 1) {
        let value = 0;
        let byte: number;
        do {
          if (cursor >= end) throw new Error("Native audio CAF packet table is truncated");
          byte = caf[cursor++]!;
          value = value * 128 + (byte & 0x7f);
          if (!Number.isSafeInteger(value)) {
            throw new Error("Native audio CAF packet size overflowed");
          }
        } while ((byte & 0x80) !== 0);
        if (value === 0 || value > 64 * 1024) {
          throw new Error("Native audio CAF contains an invalid AAC-ELD packet size");
        }
        total += value;
      }
      packetBytes = total;
    } else if (tag === "data" && size >= 4) {
      dataBytes = size - 4;
    }
    offset = end;
  }
  if (sampleRate === undefined) {
    throw new Error("Native audio CAF must contain 24 or 48 kHz AAC-ELD with 480 frames per packet");
  }
  if (packetCount === undefined || packetBytes === undefined || dataBytes === undefined) {
    throw new Error("Native audio CAF is missing its packet table or audio data");
  }
  if (packetBytes !== dataBytes) {
    throw new Error("Native audio CAF packet table does not match its audio data");
  }
  return {
    packetCount,
    payloadBytes: packetBytes,
    durationSeconds: packetCount * 480 / sampleRate,
    sampleRate,
  };
}

export class FaceTimeMediaManager {
  readonly #signaling: FaceTimeMediaSignaling;
  readonly #onUpdate: ((call: FaceTimeCall) => void) | undefined;
  readonly #chromePath: string;
  readonly #ffmpegPath: string;
  readonly #ffprobePath: string;
  readonly #afconvertPath: string | undefined;
  readonly #calls = new Map<string, InternalFaceTimeCall>();

  constructor(options: FaceTimeMediaManagerOptions) {
    this.#signaling = options.signaling;
    this.#onUpdate = options.onUpdate;
    this.#chromePath = resolveExecutable(
      options.chromePath ?? process.env.IBLUE_CHROME_PATH,
      process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : process.platform === "win32"
          ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
          : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
    );
    this.#ffmpegPath = resolveExecutable(
      options.ffmpegPath ?? process.env.IBLUE_FFMPEG_PATH,
      process.platform === "win32"
        ? ["ffmpeg.exe"]
        : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"],
    );
    this.#ffprobePath = resolveExecutable(
      options.ffprobePath ?? process.env.IBLUE_FFPROBE_PATH,
      process.platform === "win32"
        ? ["ffprobe.exe"]
        : ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"],
    );
    this.#afconvertPath = process.platform === "darwin"
      ? resolveExecutable(
        options.afconvertPath ?? process.env.IBLUE_AFCONVERT_PATH,
        ["/usr/bin/afconvert"],
      )
      : undefined;
  }

  list(): FaceTimeCall[] {
    return [...this.#calls.values()]
      .map(publicCall)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  get(id: string): FaceTimeCall | undefined {
    const call = this.#calls.get(id);
    return call ? publicCall(call) : undefined;
  }

  async start(input: FaceTimeCallInput): Promise<FaceTimeCall> {
    if ([...this.#calls.values()].some((call) => !TERMINAL_STATES.has(call.state))) {
      throw new Error("Only one FaceTime media call may run at a time");
    }
    const source = await stat(input.sourcePath).catch(() => undefined);
    if (!source?.isFile() || source.size === 0) {
      throw new Error("FaceTime media source is empty or is not a regular file");
    }
    if (input.targets.length === 0 || input.targets.length > 32) {
      throw new Error("FaceTime requires between 1 and 32 targets");
    }

    const now = Date.now();
    const call: InternalFaceTimeCall = {
      id: randomUUID(),
      direction: "outgoing",
      mode: input.mode,
      targets: [...input.targets],
      displayName: input.displayName.trim() || "iBlue",
      sourcePath: input.sourcePath,
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      maxDurationSeconds: Math.min(600, Math.max(15, input.maxDurationSeconds ?? 90)),
      participantCount: 0,
      stopRequested: false,
      transport: "apple-web-bridge",
      mediaSource: "uploaded",
    };
    this.#calls.set(call.id, call);
    this.#emit(call);

    try {
      const useNative = process.platform === "darwin"
        && Boolean(
          this.#signaling.createNativeMediaSession
          && this.#signaling.startNativeMediaSession
          && this.#signaling.nativeMediaStatus
        );
      await this.#prepareMedia(
        call,
        useNative || call.mode === "audio"
          ? 0
          : Math.min(60, Math.max(0, input.preRollSeconds ?? 15)),
        useNative,
        input.nativeAudioPassthrough ?? false,
        input.nativeVideoPassthrough ?? false,
      );
      if (useNative) {
        const session = await this.#signaling.createNativeMediaSession!({
          targets: call.targets,
          ...(input.from ? { from: input.from } : {}),
          audioPath: call.audioPath!,
          ...(call.mode === "video"
            ? {
              videoPath: call.videoPath!,
              videoDescriptionPath: call.videoDescriptionPath!,
              videoFrameDurationMs: 40,
            }
            : {}),
        });
        call.sessionId = session.sessionId;
        call.transport = "iblue-quickrelay";
        this.#setState(call, "ringing");
        void this.#runNative(call).catch((error: unknown) => this.#fail(call, error));
        return publicCall(call);
      }
      call.session = await this.#signaling.createSession({
        targets: call.targets,
        displayName: call.displayName,
        ...(input.from ? { from: input.from } : {}),
        ringTtlSeconds: Math.min(3_600, Math.max(15, call.maxDurationSeconds + 30)),
        ringOnMediaJoin: false,
      });
      call.sessionId = call.session.sessionId;
      this.#setState(call, "waiting-for-media");
      void this.#run(call).catch((error: unknown) => this.#fail(call, error));
      return publicCall(call);
    } catch (error) {
      await this.#fail(call, error);
      throw error;
    }
  }

  async stop(id: string): Promise<FaceTimeCall | undefined> {
    const call = this.#calls.get(id);
    if (!call) return undefined;
    call.stopRequested = true;
    await this.#finish(call, "ended");
    return publicCall(call);
  }

  async answerIncoming(input: FaceTimeIncomingCallInput): Promise<FaceTimeCall> {
    if ([...this.#calls.values()].some((call) => !TERMINAL_STATES.has(call.state))) {
      throw new Error("Only one FaceTime media call may run at a time");
    }
    if (
      !this.#signaling.listIncomingSessions
      || !this.#signaling.answerIncomingSession
      || !this.#signaling.startNativeMediaSession
      || !this.#signaling.nativeMediaStatus
    ) {
      throw new Error("Native incoming FaceTime media is unavailable");
    }
    const source = await stat(input.sourcePath).catch(() => undefined);
    if (!source?.isFile() || source.size === 0) {
      throw new Error("FaceTime media source is empty or is not a regular file");
    }
    const incoming = (await this.#signaling.listIncomingSessions())
      .find((session) => session.sessionId === input.sessionId);
    if (!incoming) throw new Error("Incoming FaceTime session was not found");
    if (incoming.state !== "ringing") {
      throw new Error(`Incoming FaceTime session is not ringing (${incoming.state})`);
    }
    if (incoming.participants.length !== 1) {
      throw new Error("Native incoming FaceTime currently requires exactly one remote participant");
    }

    const now = Date.now();
    const call: InternalFaceTimeCall = {
      id: randomUUID(),
      sessionId: incoming.sessionId,
      direction: "incoming",
      mode: incoming.mode,
      targets: [...incoming.participants],
      displayName: input.displayName.trim() || "iBlue",
      sourcePath: input.sourcePath,
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      maxDurationSeconds: Math.min(600, Math.max(15, input.maxDurationSeconds ?? 90)),
      participantCount: 0,
      stopRequested: false,
      transport: "iblue-quickrelay",
      mediaSource: "uploaded",
    };
    this.#calls.set(call.id, call);
    this.#emit(call);
    try {
      await this.#prepareMedia(
        call,
        0,
        true,
        input.nativeAudioPassthrough ?? false,
        input.nativeVideoPassthrough ?? false,
        // FaceTime negotiates its send and receive directions independently.
        // Keep Jade's outbound leg on AAC-ELD/PT104: the Apple EVS encoder path
        // is accepted by the phone, but currently produces badly degraded audio.
        "aac-eld",
      );
      this.#setState(call, "ringing");
      await this.#signaling.answerIncomingSession({
        sessionId: incoming.sessionId,
        audioPath: call.audioPath!,
        ...(call.mode === "video"
          ? {
            videoPath: call.videoPath!,
            videoDescriptionPath: call.videoDescriptionPath!,
            videoFrameDurationMs: 40,
          }
          : {}),
      });
      void this.#runNative(call).catch((error: unknown) => this.#fail(call, error));
      return publicCall(call);
    } catch (error) {
      await this.#fail(call, error);
      throw error;
    }
  }

  async startLiveAudio(input: FaceTimeLiveAudioCallInput): Promise<FaceTimeCall> {
    if ([...this.#calls.values()].some((call) => !TERMINAL_STATES.has(call.state))) {
      throw new Error("Only one FaceTime media call may run at a time");
    }
    if (
      !this.#signaling.createNativeLiveAudioSession
      || !this.#signaling.startNativeLiveAudioStream
      || !this.#signaling.pushNativeLiveAudioFrame
      || !this.#signaling.finishNativeLiveAudioStream
      || !this.#signaling.nativeMediaStatus
    ) {
      throw new Error("Native FaceTime live audio is unavailable");
    }
    if (input.targets.length !== 1) {
      throw new Error("Native FaceTime live audio requires exactly one target");
    }
    const now = Date.now();
    const call: InternalFaceTimeCall = {
      id: randomUUID(),
      direction: "outgoing",
      mode: "audio",
      targets: [...input.targets],
      displayName: input.displayName.trim() || "iBlue",
      sourcePath: "",
      state: "preparing",
      createdAt: now,
      updatedAt: now,
      maxDurationSeconds: Math.min(600, Math.max(15, input.maxDurationSeconds ?? 300)),
      participantCount: 0,
      stopRequested: false,
      transport: "iblue-quickrelay",
      mediaSource: "live-stream",
    };
    this.#calls.set(call.id, call);
    this.#emit(call);
    try {
      const native = await this.#signaling.createNativeLiveAudioSession({
        targets: call.targets,
        ...(input.from ? { from: input.from } : {}),
        ring: true,
      });
      call.sessionId = native.sessionId;
      call.liveAudioFormat = native.audioFormat;
      this.#setState(call, "ringing");
      void this.#runNativeLiveAudio(call).catch((error: unknown) => this.#fail(call, error));
      return publicCall(call);
    } catch (error) {
      await this.#fail(call, error);
      throw error;
    }
  }

  async pushLiveAudioFrame(id: string, frame: Buffer): Promise<FaceTimeCall> {
    const call = this.#calls.get(id);
    if (!call) throw new Error("FaceTime media call not found");
    if (call.mediaSource !== "live-stream" || !call.sessionId) {
      throw new Error("FaceTime call does not accept live audio");
    }
    if (call.state !== "active") {
      throw new Error("FaceTime live audio is not active");
    }
    if (frame.length !== 1_920) {
      throw new Error("FaceTime live audio frames must be exactly 1920 bytes");
    }
    await this.#signaling.pushNativeLiveAudioFrame!(call.sessionId, frame);
    return publicCall(call);
  }

  async finishLiveAudio(id: string): Promise<FaceTimeCall | undefined> {
    const call = this.#calls.get(id);
    if (!call) return undefined;
    if (call.mediaSource !== "live-stream") {
      throw new Error("FaceTime call does not use live audio");
    }
    call.stopRequested = true;
    await this.#finish(call, "ended");
    return publicCall(call);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#calls.values()]
        .filter((call) => !TERMINAL_STATES.has(call.state))
        .map((call) => this.stop(call.id)),
    );
  }

  async #prepareMedia(
    call: InternalFaceTimeCall,
    preRollSeconds: number,
    nativeAudio = false,
    nativeAudioPassthrough = false,
    nativeVideoPassthrough = false,
    nativeAudioCodec: "aac-eld" | "evs" = "aac-eld",
  ): Promise<void> {
    const root = process.platform === "darwin"
      ? "/private/tmp/vp/inject"
      : tmpdir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, "iblue-facetime-"));
    call.workDirectory = directory;
    if (nativeVideoPassthrough && (!nativeAudio || call.mode !== "video" || preRollSeconds !== 0)) {
      throw new Error("Native video passthrough is available only for native video calls without pre-roll");
    }
    if (nativeAudioPassthrough) {
      if (!nativeAudio || call.mode !== "audio" || preRollSeconds !== 0) {
        throw new Error("Native audio passthrough is available only for native audio calls without pre-roll");
      }
      const aacEldPath = join(directory, "microphone-aac-eld.caf");
      const info = inspectAacEldCaf(await readFile(call.sourcePath));
      await copyFile(call.sourcePath, aacEldPath);
      call.audioPath = aacEldPath;
      call.nativeAudioInput = "passthrough-aac-eld";
      call.mediaDurationSeconds = info.durationSeconds;
    } else if (nativeAudio && nativeAudioCodec === "evs") {
      call.audioPath = join(directory, "microphone-evs.f32le");
      const delayMilliseconds = Math.round(preRollSeconds * 1_000);
      await execFileAsync(this.#ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", call.sourcePath,
        "-map", "0:a:0",
        "-af", `adelay=${delayMilliseconds}:all=1`,
        "-ar", "24000", "-ac", "1", "-c:a", "pcm_f32le",
        "-f", "f32le", call.audioPath,
      ], { maxBuffer: 4 * 1024 * 1024 });
      const info = inspectEvsPcmF32Le(await readFile(call.audioPath));
      call.nativeAudioInput = "transcoded-evs";
      call.mediaDurationSeconds = info.durationSeconds;
    } else if (nativeAudio) {
      if (!this.#afconvertPath) {
        throw new Error("Apple afconvert is required for native FaceTime AAC-ELD audio");
      }
      const pcmPath = join(directory, "microphone-input.wav");
      call.audioPath = join(directory, "microphone-aac-eld.caf");
      const delayMilliseconds = Math.round(preRollSeconds * 1_000);
      await execFileAsync(this.#ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", call.sourcePath,
        "-map", "0:a:0",
        "-af", `adelay=${delayMilliseconds}:all=1`,
        "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
        pcmPath,
      ], { maxBuffer: 4 * 1024 * 1024 });
      // Match the codec actually selected by current iPhone peers: PT104
      // AAC-ELD, 24 kHz mono, one 480-sample (20 ms) access unit per RTP
      // packet. VCPayloadUtils maps PT104 to this exact clock and codec;
      // the 48 kb/s bitrate is Apple's installed U1 audio tier.
      await execFileAsync(this.#afconvertPath, [
        pcmPath, call.audioPath,
        "-f", "caff",
        "-d", "aace@24000#480",
        "-c", "1",
        "-b", "48000",
        "-q", "127",
      ], { maxBuffer: 4 * 1024 * 1024 });
      const info = inspectAacEldCaf(await readFile(call.audioPath));
      call.nativeAudioInput = "transcoded-aac-eld";
      call.mediaDurationSeconds = info.durationSeconds;
    } else {
      call.audioPath = join(directory, "microphone.wav");
      const delayMilliseconds = Math.round(preRollSeconds * 1_000);
      await execFileAsync(this.#ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", call.sourcePath,
        "-map", "0:a:0",
        "-af", `adelay=${delayMilliseconds}:all=1`,
        "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le",
        call.audioPath,
      ], { maxBuffer: 4 * 1024 * 1024 });
    }

    if (call.mode === "video") {
      if (nativeAudio) {
        const moviePath = join(directory, "camera-hvc1.mov");
        call.videoPath = join(directory, "camera-annexb.h265");
        call.videoDescriptionPath = join(directory, "camera-hvc1.qtff");
        if (nativeVideoPassthrough) {
          await copyFile(call.sourcePath, moviePath);
          call.nativeVideoInput = "passthrough-hevc";
        } else {
          await execFileAsync(this.#ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", call.sourcePath,
            "-map", "0:v:0",
            "-vf",
            "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,fps=25,format=nv12",
            "-an", "-c:v", "hevc_videotoolbox", "-tag:v", "hvc1",
            "-b:v", "1200k", "-g", "25", "-bf", "0", "-r", "25",
            moviePath,
          ], { maxBuffer: 4 * 1024 * 1024 });
          call.nativeVideoInput = "transcoded-hevc";
        }
        const videoCopyArguments = [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", moviePath,
          ...(call.mediaDurationSeconds && call.mediaDurationSeconds > 0
            ? ["-t", String(call.mediaDurationSeconds)]
            : []),
          "-map", "0:v:0", "-c:v", "copy",
          "-bsf:v", "hevc_mp4toannexb,hevc_metadata=aud=insert",
          "-f", "hevc", call.videoPath,
        ];
        await execFileAsync(this.#ffmpegPath, videoCopyArguments, {
          maxBuffer: 4 * 1024 * 1024,
        });
        await writeFile(
          call.videoDescriptionPath,
          buildFaceTimeHvc1SampleEntry(await readFile(moviePath)),
          { mode: 0o600 },
        );
      } else {
        call.videoPath = join(directory, "camera.y4m");
        await execFileAsync(this.#ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", call.sourcePath,
          "-map", "0:v:0",
          "-vf",
          `tpad=start_duration=${preRollSeconds}:start_mode=clone,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p`,
          "-f", "yuv4mpegpipe",
          call.videoPath,
        ], { maxBuffer: 4 * 1024 * 1024 });
      }
    }

    if (!nativeAudioPassthrough && !nativeAudio) {
      const { stdout } = await execFileAsync(this.#ffprobePath, [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1",
        call.mode === "video" ? call.videoPath ?? call.audioPath : call.audioPath,
      ]);
      const duration = Number.parseFloat(stdout.trim());
      if (Number.isFinite(duration)) call.mediaDurationSeconds = duration;
    }
    this.#emit(call);
  }

  async #runNative(call: InternalFaceTimeCall): Promise<void> {
    if (!call.sessionId || !this.#signaling.startNativeMediaSession) {
      throw new Error("Native FaceTime media session was not prepared");
    }
    const answerDeadline = Date.now() + Math.min(60, call.maxDurationSeconds) * 1_000;
    while (!call.stopRequested && Date.now() < answerDeadline) {
      const snapshot = await this.#signaling.listSessions();
      const activeTargets = activeTargetsInSession(snapshot, call.sessionId, call.targets);
      call.participantCount = activeTargets;
      this.#emit(call);
      if (activeTargets > 0) {
        call.answeredAt = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!call.answeredAt) {
      if (call.stopRequested) return;
      throw new Error("Native FaceTime call was not answered before the ring timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, NATIVE_MEDIA_POST_ANSWER_SETTLE_MS));
    if (call.stopRequested) return;

    this.#setState(call, "waiting-for-media");
    let lastError: unknown;
    const mediaStartDeadline = Date.now() + 20_000;
    while (!call.stopRequested && Date.now() < mediaStartDeadline) {
      try {
        await this.#signaling.startNativeMediaSession(call.sessionId);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) throw lastError;
    call.mediaCaptureStartedAt = Date.now();
    this.#setState(call, "active");

    const safetyDeadline = Date.now() + call.maxDurationSeconds * 1_000;
    while (!call.stopRequested && Date.now() < safetyDeadline) {
      const native = await this.#signaling.nativeMediaStatus!(call.sessionId);
      applyNativeFaceTimeMediaStatus(call, native);
      const snapshot = await this.#signaling.listSessions();
      const activeTargets = activeTargetsInSession(snapshot, call.sessionId, call.targets);
      call.participantCount = activeTargets;
      this.#emit(call);
      if (native.state === "failed") {
        throw new Error(`Native FaceTime audio sender failed: ${native.error ?? "unknown native error"}`);
      }
      if (native.state === "completed") break;
      if (activeTargets === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.#finish(call, "ended");
  }

  async #runNativeLiveAudio(call: InternalFaceTimeCall): Promise<void> {
    if (!call.sessionId || !this.#signaling.startNativeLiveAudioStream) {
      throw new Error("Native FaceTime live audio session was not prepared");
    }
    const answerDeadline = Date.now() + Math.min(60, call.maxDurationSeconds) * 1_000;
    while (!call.stopRequested && Date.now() < answerDeadline) {
      const snapshot = await this.#signaling.listSessions();
      call.participantCount = activeTargetsInSession(snapshot, call.sessionId, call.targets);
      this.#emit(call);
      if (call.participantCount > 0) {
        call.answeredAt = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!call.answeredAt) {
      if (call.stopRequested) return;
      throw new Error("Native FaceTime live audio call was not answered before the ring timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, NATIVE_MEDIA_POST_ANSWER_SETTLE_MS));
    if (call.stopRequested) return;

    this.#setState(call, "waiting-for-media");
    const startDeadline = Date.now() + 10_000;
    let lastError: unknown;
    while (!call.stopRequested && Date.now() < startDeadline) {
      try {
        await this.#signaling.startNativeLiveAudioStream(call.sessionId);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) throw lastError;
    call.mediaCaptureStartedAt = Date.now();
    this.#setState(call, "active");

    const safetyDeadline = Date.now() + call.maxDurationSeconds * 1_000;
    while (!call.stopRequested && Date.now() < safetyDeadline) {
      const [native, snapshot] = await Promise.all([
        this.#signaling.nativeMediaStatus!(call.sessionId),
        this.#signaling.listSessions(),
      ]);
      applyNativeFaceTimeMediaStatus(call, native);
      call.participantCount = activeTargetsInSession(snapshot, call.sessionId, call.targets);
      this.#emit(call);
      if (native.state === "failed") {
        throw new Error(`Native FaceTime live audio failed: ${native.error ?? "unknown native error"}`);
      }
      if (native.state === "stream-ended" || call.participantCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.#finish(call, "ended");
  }

  async #run(call: InternalFaceTimeCall): Promise<void> {
    if (!call.session || !call.audioPath) throw new Error("FaceTime media was not prepared");
    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--user-agent=${WINDOWS_CHROME_USER_AGENT}`,
    ];
    if (call.videoPath) args.push(`--use-file-for-fake-video-capture=${call.videoPath}`);
    call.browser = await puppeteer.launch({
      executablePath: this.#chromePath,
      headless: true,
      args,
    });
    const context = call.browser.defaultBrowserContext();
    await context.overridePermissions("https://facetime.apple.com", ["microphone", "camera"]);
    call.page = await call.browser.newPage();
    await call.page.evaluateOnNewDocument(() => {
      const mediaDevices = navigator.mediaDevices;
      const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      type IBlueMediaGlobal = typeof globalThis & {
        __iblueAudioContext?: AudioContext;
        __iblueAudioDestination?: MediaStreamAudioDestinationNode;
        __iblueAudioSource?: AudioBufferSourceNode;
        __iblueAudioPlaybackEnded?: boolean;
        __iblueMediaCaptureStartedAt?: number;
        __iblueStartAudioPlayback?: (base64: string) => Promise<number>;
      };
      const mediaGlobal = globalThis as IBlueMediaGlobal;

      const ensureSyntheticMicrophone = (): MediaStreamAudioDestinationNode => {
        if (!mediaGlobal.__iblueAudioContext || !mediaGlobal.__iblueAudioDestination) {
          mediaGlobal.__iblueAudioContext = new AudioContext({ sampleRate: 48_000 });
          mediaGlobal.__iblueAudioDestination =
            mediaGlobal.__iblueAudioContext.createMediaStreamDestination();
        }
        return mediaGlobal.__iblueAudioDestination;
      };

      mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const wantsAudio = constraints?.audio !== false;
        const wantsVideo = Boolean(constraints?.video);
        const stream = wantsVideo
          ? await originalGetUserMedia({ ...constraints, audio: false })
          : new MediaStream();
        if (wantsAudio) {
          for (const track of ensureSyntheticMicrophone().stream.getAudioTracks()) {
            stream.addTrack(track);
          }
        }
        return stream;
      };

      mediaGlobal.__iblueStartAudioPlayback = async (base64: string): Promise<number> => {
        if (mediaGlobal.__iblueAudioSource) {
          throw new Error("iBlue audio playback was already started");
        }
        ensureSyntheticMicrophone();
        const context = mediaGlobal.__iblueAudioContext!;
        await context.resume();
        const binary = atob(base64);
        const encoded = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          encoded[index] = binary.charCodeAt(index);
        }
        const buffer = await context.decodeAudioData(encoded.buffer);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(ensureSyntheticMicrophone());
        mediaGlobal.__iblueAudioSource = source;
        mediaGlobal.__iblueAudioPlaybackEnded = false;
        mediaGlobal.__iblueMediaCaptureStartedAt = Date.now();
        source.addEventListener("ended", () => {
          mediaGlobal.__iblueAudioPlaybackEnded = true;
        }, { once: true });
        source.start();
        return mediaGlobal.__iblueMediaCaptureStartedAt;
      };

      const peerConnections: RTCPeerConnection[] = [];
      const OriginalPeerConnection = globalThis.RTCPeerConnection;
      globalThis.RTCPeerConnection = new Proxy(OriginalPeerConnection, {
        construct(target, argumentsList) {
          const peer = Reflect.construct(target, argumentsList) as RTCPeerConnection;
          peerConnections.push(peer);
          return peer;
        },
      });
      Object.defineProperty(globalThis, "__ibluePeerConnections", {
        configurable: false,
        value: peerConnections,
      });
    });
    await call.page.goto(call.session.link, { waitUntil: "networkidle2", timeout: 90_000 });
    await call.page.waitForSelector("#name-entry", { timeout: 30_000 });
    const input = await call.page.$("#name-entry");
    if (!input) throw new Error("Apple FaceTime join page did not expose its name field");
    await input.click({ count: 3 });
    await input.type(call.displayName);
    await call.page.click("ui-button.continue-button");
    await call.page.waitForSelector("#callcontrols-join-button-session-banner", { timeout: 30_000 });

    if (call.mode === "audio") {
      const video = await call.page.$("#callcontrols-video-button");
      const label = video
        ? await call.page.evaluate((element) => element.getAttribute("aria-label"), video)
        : undefined;
      if (video && label?.includes("camera on")) await video.click();
    }
    // Establish the web media participant before inviting phones. Current iOS
    // can drop an answered one-to-one call while it is being converted for a
    // web guest. Adding the targets after the guest is active makes the first
    // invitation a group call whose active_participants already includes the
    // web media leg.
    await call.page.click("#callcontrols-join-button-session-banner");
    await call.page.waitForFunction(
      () => document.body?.innerText.includes("You have joined the conversation"),
      { timeout: 45_000 },
    );

    // The preview can re-enable video while transitioning into the call.
    if (call.mode === "audio") {
      const video = await call.page.$("#callcontrols-video-button");
      const label = video
        ? await call.page.evaluate((element) => element.getAttribute("aria-label"), video)
        : undefined;
      if (video && label?.includes("camera on")) await video.click();
    }

    await this.#signaling.confirmMediaJoined(call.session.sessionId);
    const guestDeadline = Date.now() + 20_000;
    let webGuestSeen = false;
    while (!call.stopRequested && Date.now() < guestDeadline) {
      const snapshot = await this.#signaling.listSessions();
      const activeWebGuests = activeWebGuestsInSession(snapshot, call.session.sessionId);
      call.activeWebGuestCount = activeWebGuests;
      webGuestSeen ||= activeWebGuests > 0;
      this.#emit(call);
      if (webGuestSeen) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!webGuestSeen) {
      if (call.stopRequested) return;
      throw new Error("FaceTime web guest did not join the allocated media session");
    }

    await this.#signaling.ringSession(call.session.sessionId, call.targets);
    this.#setState(call, "ringing");
    const answerDeadline = Date.now() + Math.min(60, call.maxDurationSeconds) * 1_000;
    while (!call.stopRequested && Date.now() < answerDeadline) {
      const [snapshot, web] = await Promise.all([
        this.#signaling.listSessions(),
        inspectWebMedia(call.page),
      ]);
      const activeTargets = activeTargetsInSession(snapshot, call.session.sessionId, call.targets);
      const activeWebGuests = activeWebGuestsInSession(snapshot, call.session.sessionId);
      call.participantCount = Math.max(activeTargets, web.participants);
      call.activeWebGuestCount = activeWebGuests;
      applyWebMediaState(call, web);
      this.#emit(call);
      if (activeTargets > 0) {
        call.answeredAt = Date.now();
        this.#setState(call, "waiting-for-media");
        break;
      }
      if (web.ended) throw new Error("Apple ended the FaceTime call while ringing");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!call.answeredAt) {
      if (call.stopRequested) return;
      throw new Error("FaceTime call was not answered before the ring timeout");
    }

    const mediaDeadline = Date.now() + 30_000;
    let bridgeStableSince: number | undefined;
    while (!call.stopRequested && Date.now() < mediaDeadline) {
      const [snapshot, web] = await Promise.all([
        this.#signaling.listSessions(),
        inspectWebMedia(call.page),
      ]);
      const activeTargets = activeTargetsInSession(snapshot, call.session.sessionId, call.targets);
      const activeWebGuests = activeWebGuestsInSession(snapshot, call.session.sessionId);
      call.participantCount = Math.max(activeTargets, web.participants);
      call.activeWebGuestCount = activeWebGuests;
      applyWebMediaState(call, web);
      this.#emit(call);

      // A native JoinEvent only proves that the callee answered. The media
      // handoff is complete once the temporary web pseud joined this exact
      // session and Apple's web UI (or RTP stats) sees the remote participant.
      const hasRemoteMedia = web.participants > 0
        || web.outboundAudioBytes > 0
        || web.inboundAudioBytes > 0
        || web.outboundVideoBytes > 0
        || web.inboundVideoBytes > 0;
      if (activeTargets > 0 && activeWebGuests > 0 && hasRemoteMedia) {
        bridgeStableSince ??= Date.now();
        if (Date.now() - bridgeStableSince >= 3_000) break;
      } else {
        bridgeStableSince = undefined;
      }
      if (web.ended) throw new Error("Apple ended the FaceTime call during media handoff");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!bridgeStableSince || Date.now() - bridgeStableSince < 3_000) {
      throw new Error("Answered FaceTime group call did not establish remote web media");
    }
    if (call.mode === "audio") {
      const audioBase64 = (await readFile(call.audioPath)).toString("base64");
      call.mediaCaptureStartedAt = await call.page.evaluate(async (base64) => {
        const start = (globalThis as unknown as {
          __iblueStartAudioPlayback?: (value: string) => Promise<number>;
        }).__iblueStartAudioPlayback;
        if (!start) throw new Error("iBlue synthetic microphone was not initialized");
        return start(base64);
      }, audioBase64);
    }
    this.#setState(call, "active");
    const safetyDeadline = Date.now() + call.maxDurationSeconds * 1_000;
    let disconnectedSamples = 0;
    while (!call.stopRequested && Date.now() < safetyDeadline) {
      if (call.page.isClosed()) throw new Error("Apple FaceTime media page closed unexpectedly");
      const [state, snapshot] = await Promise.all([
        inspectWebMedia(call.page),
        this.#signaling.listSessions(),
      ]);
      const activeTargets = activeTargetsInSession(
        snapshot,
        call.session.sessionId,
        call.targets,
      );
      const activeWebGuests = activeWebGuestsInSession(snapshot, call.session.sessionId);
      const remotePresent = state.participants > 0
        || activeTargets > 0
        || state.inboundAudioBytes > 0;
      disconnectedSamples = remotePresent ? 0 : disconnectedSamples + 1;
      applyWebMediaState(call, state);
      call.activeWebGuestCount = activeWebGuests;
      const participantCount = Math.max(activeTargets, state.participants);
      call.participantCount = participantCount;
      this.#emit(call);
      if (state.ended || disconnectedSamples >= 5) break;
      if (call.mode === "audio" && state.playbackEnded) {
        // Give the final encoded packet a brief chance to drain before the
        // leave signal tears down the relay. The source itself cannot replay.
        await new Promise((resolve) => setTimeout(resolve, 300));
        break;
      }
      // Chromium loops --use-file-for-fake-*-capture indefinitely. Stop just
      // before a fake video file wraps. Audio uses a non-looping Web Audio
      // source and normally exits through playbackEnded above; the deadline
      // remains a safety net if the page misses that event.
      const mediaDeadline = call.mode === "video"
        ? faceTimeMediaStopDeadline(
          safetyDeadline,
          call.mediaCaptureStartedAt,
          call.mediaDurationSeconds,
        )
        : Math.min(
          safetyDeadline,
          (call.mediaCaptureStartedAt ?? Date.now())
            + (call.mediaDurationSeconds ?? call.maxDurationSeconds) * 1_000
            + 2_000,
        );
      if (Date.now() >= mediaDeadline) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.max(25, Math.min(1_000, mediaDeadline - Date.now())),
      ));
    }
    await this.#finish(call, "ended");
  }

  async #fail(call: InternalFaceTimeCall, error: unknown): Promise<void> {
    call.error = error instanceof Error ? error.message : String(error);
    await this.#finish(call, "failed");
  }

  async #finish(call: InternalFaceTimeCall, terminalState: "ended" | "failed"): Promise<void> {
    if (call.finishing) return call.finishing;
    call.finishing = (async () => {
      let finalState = terminalState;
      if (!TERMINAL_STATES.has(call.state)) this.#setState(call, "ending");
      const page = call.page;
      if (page && !page.isClosed()) {
        await page.evaluate(() => {
          const mediaGlobal = globalThis as unknown as {
            __iblueAudioSource?: AudioBufferSourceNode;
            __iblueAudioContext?: AudioContext;
          };
          try {
            mediaGlobal.__iblueAudioSource?.stop();
          } catch {
            // The source already ended naturally.
          }
          void mediaGlobal.__iblueAudioContext?.close();
        }).catch(() => undefined);
        const leave = await page.$(
          "#callcontrols-leave-button-session-banner, #extended-menu-leave-button",
        ).catch(() => null);
        if (leave) await leave.click().catch(() => undefined);
      }
      if (call.sessionId) {
        if (call.mediaSource === "live-stream") {
          await this.#signaling.finishNativeLiveAudioStream?.(call.sessionId).catch(() => undefined);
          const finalNative = await this.#signaling.nativeMediaStatus?.(call.sessionId)
            .catch(() => undefined);
          if (finalNative) applyNativeFaceTimeMediaStatus(call, finalNative);
        }
        let leaveError: unknown;
        let left = false;
        for (let attempt = 0; attempt < 12 && !left; attempt += 1) {
          try {
            await this.#signaling.leaveSession(call.sessionId);
            left = true;
          } catch (error) {
            leaveError = error;
            if (attempt < 11) {
              // The native worker can be reconnecting after a relay timeout.
              // Keep teardown authoritative instead of reporting an ended
              // call while the iPhone remains connected to an orphaned leg.
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }
        if (!left) {
          call.error ??= `FaceTime leave failed: ${
            leaveError instanceof Error ? leaveError.message : String(leaveError ?? "unknown error")
          }`;
          finalState = "failed";
        }
      }
      await call.browser?.close().catch(() => undefined);
      if (call.workDirectory) {
        await rm(call.workDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      delete call.browser;
      delete call.page;
      call.endedAt = Date.now();
      this.#setState(call, finalState);
    })();
    return call.finishing;
  }

  #setState(call: InternalFaceTimeCall, state: FaceTimeCallState): void {
    call.state = state;
    this.#emit(call);
  }

  #emit(call: InternalFaceTimeCall): void {
    call.updatedAt = Date.now();
    this.#onUpdate?.(publicCall(call));
  }
}
