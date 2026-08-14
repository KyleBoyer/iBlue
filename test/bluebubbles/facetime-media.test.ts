import assert from "node:assert/strict";
import test from "node:test";

import {
  faceTimeMediaStopDeadline,
  inspectAacEldCaf,
  inspectEvsPcmF32Le,
} from "../../src/bluebubbles/facetime-media.js";

function cafChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write(tag, 0, 4, "ascii");
  header.writeBigInt64BE(BigInt(payload.length), 4);
  return Buffer.concat([header, payload]);
}

function diagnosticAacEldCaf(dataBytes = 133): Buffer {
  const header = Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]);
  const description = Buffer.alloc(32);
  description.writeDoubleBE(24_000, 0);
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
