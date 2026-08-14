import assert from "node:assert/strict";
import test from "node:test";

import { toTransportAddress } from "../../src/bluebubbles/guid.js";

test("transport addresses canonicalize NANP numbers for Apple IDS", () => {
  assert.equal(toTransportAddress("2025550142"), "tel:+12025550142");
  assert.equal(toTransportAddress("1 (202) 555-0142"), "tel:+12025550142");
  assert.equal(toTransportAddress("tel:+1 (202) 555-0142"), "tel:+12025550142");
});

test("transport addresses preserve international and email identities", () => {
  assert.equal(toTransportAddress("+44 20 7946 0958"), "tel:+442079460958");
  assert.equal(toTransportAddress("mailto:Jade@example.com"), "mailto:Jade@example.com");
  assert.equal(toTransportAddress("Jade@example.com"), "mailto:Jade@example.com");
});
