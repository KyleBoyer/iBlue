import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNativeFaceTimeMediaStatus,
  buildFaceTimeHvc1SampleEntry,
  extractHvc1SampleEntry,
  faceTimeMediaStopDeadline,
  inspectAacEldCaf,
  inspectEvsPcmF32Le,
  type FaceTimeCall,
} from "../../src/bluebubbles/facetime-media.js";

test("FaceTime native video extracts the complete hvc1 image description", () => {
  const entry = Buffer.alloc(96);
  entry.writeUInt32BE(entry.length, 0);
  entry.write("hvc1", 4, 4, "ascii");
  entry.write("hvcC", 86, 4, "ascii");
  const movie = Buffer.concat([Buffer.from("prefix"), entry, Buffer.from("suffix")]);

  assert.deepEqual(extractHvc1SampleEntry(movie), entry);
});

test("FaceTime native video rejects an hvc1 entry without decoder configuration", () => {
  const entry = Buffer.alloc(96);
  entry.writeUInt32BE(entry.length, 0);
  entry.write("hvc1", 4, 4, "ascii");

  assert.throws(() => extractHvc1SampleEntry(entry), /hvcC/);
});

test("FaceTime native video emits Apple's canonical hvc1 ImageDescription with encoded dimensions", () => {
  const parameterSets = new Map([
    [32, Buffer.from([0x40, 0x01, 0x0c])],
    [33, Buffer.from([0x42, 0x01, 0x01, 0x60])],
    [34, Buffer.from([0x44, 0x01, 0xc0])],
  ]);
  const arrays = [...parameterSets].map(([nalType, nal]) => {
    const array = Buffer.alloc(5 + nal.length);
    array[0] = 0x80 | nalType;
    array.writeUInt16BE(1, 1);
    array.writeUInt16BE(nal.length, 3);
    nal.copy(array, 5);
    return array;
  });
  const hvcCPayload = Buffer.concat([Buffer.alloc(22), Buffer.from([3]), ...arrays]);
  const hvcC = Buffer.alloc(8 + hvcCPayload.length);
  hvcC.writeUInt32BE(hvcC.length, 0);
  hvcC.write("hvcC", 4, 4, "ascii");
  hvcCPayload.copy(hvcC, 8);
  const ffmpegEntry = Buffer.alloc(86 + hvcC.length + 26);
  ffmpegEntry.writeUInt32BE(ffmpegEntry.length, 0);
  ffmpegEntry.write("hvc1", 4, 4, "ascii");
  ffmpegEntry.writeUInt16BE(1, 14);
  ffmpegEntry.write("FFMP", 20, 4, "ascii");
  ffmpegEntry.writeUInt16BE(640, 32);
  ffmpegEntry.writeUInt16BE(360, 34);
  hvcC.copy(ffmpegEntry, 86);

  const result = buildFaceTimeHvc1SampleEntry(ffmpegEntry);

  assert.equal(result.readUInt32BE(0), result.length);
  assert.equal(result.toString("ascii", 4, 8), "hvc1");
  assert.equal(result.readUInt16BE(14), 0xffff);
  assert.equal(result.readUInt32BE(24), 512);
  assert.equal(result.readUInt32BE(28), 512);
  assert.equal(result.readUInt16BE(32), 640);
  assert.equal(result.readUInt16BE(34), 360);
  assert.equal(result[50], 4);
  assert.equal(result.toString("ascii", 51, 55), "HEVC");
  assert.equal(result.readUInt16BE(82), 24);
  assert.equal(result.readInt16BE(84), -1);
  assert.equal(result.toString("ascii", 90, 94), "hvcC");
  assert.equal(result[result.length - 1], 0);
  assert.equal(result.includes(Buffer.from("FFMP", "ascii")), false);
  for (const nal of parameterSets.values()) assert.equal(result.includes(nal), true);
});

function cafChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write(tag, 0, 4, "ascii");
  header.writeBigInt64BE(BigInt(payload.length), 4);
  return Buffer.concat([header, payload]);
}

function diagnosticAacEldCaf(dataBytes = 133, sampleRate: 24_000 | 48_000 = 24_000): Buffer {
  const header = Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]);
  const description = Buffer.alloc(32);
  description.writeDoubleBE(sampleRate, 0);
  description.write("aace", 8, 4, "ascii");
  description.writeUInt32BE(480, 20);
  const packetTable = Buffer.alloc(27);
  packetTable.writeBigUInt64BE(2n, 0);
  packetTable.writeBigUInt64BE(960n, 8);
  packetTable.set([3, 0x81, 0x02], 24);
  const data = Buffer.alloc(4 + dataBytes);
  return Buffer.concat([
    header,
    cafChunk("desc", description),
    cafChunk("pakt", packetTable),
    cafChunk("data", data),
  ]);
}

test("FaceTime web media stops before Chromium loops a capture file", () => {
  const captureStartedAt = 1_000_000;
  assert.equal(
    faceTimeMediaStopDeadline(2_000_000, captureStartedAt, 12.5),
    captureStartedAt + 12_500 - 200,
  );
});

test("FaceTime web media never exceeds its safety deadline", () => {
  assert.equal(faceTimeMediaStopDeadline(20_000, 10_000, 30), 20_000);
});

test("FaceTime web media falls back to its safety deadline without timing data", () => {
  assert.equal(faceTimeMediaStopDeadline(20_000), 20_000);
  assert.equal(faceTimeMediaStopDeadline(20_000, 10_000, 0), 20_000);
});

test("FaceTime native AAC-ELD passthrough validates packet framing before ringing", () => {
  assert.deepEqual(inspectAacEldCaf(diagnosticAacEldCaf()), {
    packetCount: 2,
    payloadBytes: 133,
    durationSeconds: 0.04,
    sampleRate: 24_000,
  });
});

test("FaceTime native AAC-ELD passthrough preserves captured 48 kHz packet timing", () => {
  assert.deepEqual(inspectAacEldCaf(diagnosticAacEldCaf(133, 48_000)), {
    packetCount: 2,
    payloadBytes: 133,
    durationSeconds: 0.02,
    sampleRate: 48_000,
  });
});

test("FaceTime native AAC-ELD passthrough rejects a mismatched packet table", () => {
  assert.throws(
    () => inspectAacEldCaf(diagnosticAacEldCaf(132)),
    /packet table does not match/i,
  );
});

test("FaceTime native EVS PCM reports 20 ms packet boundaries", () => {
  assert.deepEqual(inspectEvsPcmF32Le(Buffer.alloc(480 * 4 * 3)), {
    sampleCount: 1_440,
    packetCount: 3,
    durationSeconds: 0.06,
  });
});

test("FaceTime native EVS PCM rejects partial float samples", () => {
  assert.throws(() => inspectEvsPcmF32Le(Buffer.alloc(7)), /float32 PCM/i);
});

test("FaceTime live calls publish the final post-drain native status", () => {
  const call: FaceTimeCall = {
    id: "call-1",
    sessionId: "session-1",
    direction: "outgoing",
    mode: "audio",
    targets: ["tel:+16513196252"],
    displayName: "Jade",
    state: "ending",
    createdAt: 1,
    updatedAt: 2,
    maxDurationSeconds: 60,
    participantCount: 1,
    transport: "iblue-quickrelay",
    mediaSource: "live-stream",
    nativeMediaState: "streaming",
    nativePacketsTotal: 610,
    nativePacketsSent: 558,
    nativeControlLastError: "stale pre-drain detail",
  };

  applyNativeFaceTimeMediaStatus(call, {
    sessionId: "session-1",
    state: "stream-ended",
    packetsTotal: 614,
    payloadBytesTotal: 72_488,
    packetsSent: 614,
    payloadBytesSent: 72_488,
    audioPacketsTotal: 600,
    audioPayloadBytesTotal: 60_000,
    audioPacketsSent: 600,
    audioPayloadBytesSent: 60_000,
    videoFramesTotal: 10,
    videoFramesSent: 10,
    videoSourceBytesTotal: 10_000,
    videoPacketsSent: 14,
    videoPayloadBytesSent: 12_488,
    completedAt: 3,
    controlMessagesReceived: 4,
    controlMessagesAuthenticated: 4,
    controlMessagesSent: 2,
    controlStreamStateSent: true,
    controlStreamStateAcknowledged: true,
    controlReady: true,
    controlParticipantContexts: 1,
    controlPeerUuids: 1,
    controlMediaKeys: 2,
    peerAudioFeedbackUpdates: 7,
    peerAudioFeedbackSequence: 8,
    peerAudioKbReceived: 9,
    peerAudioPacketsReceived: 10,
    peerAudioPayloadType: 20,
    peerAudioRtpExtensionProfile: 0x8d00,
    peerAudioRtpExtensionHex: "01020304",
    peerVideoPacketsReceived: 42,
    peerVideoSsrc: 0x01020304,
    peerVideoRtpExtensionProfile: 0x8001,
    peerVideoRtpExtensionHex: "00010002",
  });

  assert.equal(call.nativeMediaState, "stream-ended");
  assert.equal(call.nativePacketsTotal, 614);
  assert.equal(call.nativePacketsSent, 614);
  assert.equal(call.nativePayloadBytesTotal, 72_488);
  assert.equal(call.nativePayloadBytesSent, 72_488);
  assert.equal(call.nativeAudioPacketsSent, 600);
  assert.equal(call.nativeVideoFramesSent, 10);
  assert.equal(call.nativeVideoPacketsSent, 14);
  assert.equal(call.nativeControlReady, true);
  assert.equal(call.nativeControlStreamStateAcknowledged, true);
  assert.equal(call.nativePeerAudioPayloadType, 20);
  assert.equal(call.nativePeerVideoPacketsReceived, 42);
  assert.equal(call.nativePeerVideoRtpExtensionProfile, 0x8001);
  assert.equal(call.nativeControlLastError, undefined);
});
