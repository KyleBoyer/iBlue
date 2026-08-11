import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSingleEmoji,
  attributedBodyFromText,
  htmlFromTextRuns,
  parseAttributedText,
  parseOutboundTextRuns,
} from "../../src/bluebubbles/attributed-text.js";

const liveFixture = `<strong>Bold</strong><em>italics</em><u>underline</u><del>strike</del><span data-mx-imessage-effect="big">

Big</span><span data-mx-imessage-effect="small">
Small</span><span data-mx-imessage-effect="shake">
Shake</span><span data-mx-imessage-effect="nod">
Nod</span><span data-mx-imessage-effect="explode">
Explode</span><span data-mx-imessage-effect="ripple">
Ripple</span><span data-mx-imessage-effect="bloom">
Bloom</span><span data-mx-imessage-effect="jitter">
Jitter</span>`;

test("parses Apple's live modern formatting fixture into UTF-16 ranges", () => {
  const parsed = parseAttributedText(liveFixture);
  assert.equal(parsed.text, "Bolditalicsunderlinestrike\n\nBig\nSmall\nShake\nNod\nExplode\nRipple\nBloom\nJitter");
  assert.deepEqual(parsed.runs.slice(0, 4).map(({ text, styles }) => ({ text, styles })), [
    { text: "Bold", styles: ["bold"] },
    { text: "italics", styles: ["italic"] },
    { text: "underline", styles: ["underline"] },
    { text: "strike", styles: ["strikethrough"] },
  ]);
  assert.deepEqual(parsed.runs.slice(4).map(({ effect }) => effect), [
    "big", "small", "shake", "nod", "explode", "ripple", "bloom", "jitter",
  ]);
  assert.equal(parsed.rangeEncoding, "utf-16");

  const attributedBody = attributedBodyFromText(parsed)[0]!;
  assert.equal(attributedBody.string, parsed.text);
  assert.equal(attributedBody.runs[0]?.attributes.__kIMTextBoldAttributeName, true);
  assert.equal(attributedBody.runs[4]?.attributes.__kIMTextEffectAttributeName, 5);
});

test("builds safe outbound HTML from validated text runs", () => {
  const text = "Bold 😀 Big";
  const runs = parseOutboundTextRuns([
    { range: [0, 4], styles: ["bold", "underline"] },
    { range: [8, 3], effect: "big" },
  ], text);
  assert.equal(
    htmlFromTextRuns(text, runs),
    "<u><strong>Bold</strong></u> 😀 <span data-mx-imessage-effect=\"big\">Big</span>",
  );
  assert.throws(
    () => parseOutboundTextRuns([{ range: [6, 1], styles: ["bold"] }], text),
    /surrogate pair/,
  );
  assert.throws(
    () => parseOutboundTextRuns([{ range: [0, 4], styles: ["bold"], effect: "big" }], text),
    /cannot combine/,
  );
});

test("emoji Tapbacks accept one complete emoji grapheme", () => {
  for (const emoji of ["🚙", "❤️", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣"]) assert.doesNotThrow(() => assertSingleEmoji(emoji));
  for (const value of ["car", "🚙🚗", ""]) assert.throws(() => assertSingleEmoji(value));
});
