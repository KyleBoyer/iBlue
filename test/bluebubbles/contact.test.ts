import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  buildVCardContact,
  contactAddressKey,
  parseVCardContactCards,
  parseVCardContacts,
} from "../../src/bluebubbles/contact.js";
import {
  sharedLocationFromBalloon,
  sharedLocationFromMessageText,
} from "../../src/bluebubbles/location.js";

test("profile VCF parsing unfolds cards, normalizes addresses, and decodes photos", () => {
  const contacts = parseVCardContacts([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Example;Jane;;;",
    "FN:Jane\\, Example",
    "NICKNAME:Janie",
    "TEL;TYPE=CELL:tel:+1 (555) 555-0100",
    "EMAIL;TYPE=INTERNET:Jane@Example.com",
    "PHOTO;ENCODING=b;TYPE=PNG:AQ",
    " ID",
    "END:VCARD",
  ].join("\r\n"));

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.displayName, "Jane, Example");
  assert.equal(contacts[0]?.firstName, "Jane");
  assert.equal(contacts[0]?.lastName, "Example");
  assert.equal(contacts[0]?.nickname, "Janie");
  assert.deepEqual(contacts[0]?.addresses, ["+1 (555) 555-0100", "Jane@Example.com"]);
  assert.deepEqual(contacts[0]?.avatar, Buffer.from([1, 2, 3]));
  assert.equal(contactAddressKey("tel:+1 (555) 555-0100"), "+15555550100");
  assert.equal(contactAddressKey("(555) 555-0100"), "+15555550100");
  assert.equal(contactAddressKey("MAILTO:Jane@Example.com"), "jane@example.com");
});

test("shared vCards preserve structured fields, Apple labels, and portrait metadata", () => {
  const portrait = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100, 7),
  ]);
  const vcf = buildVCardContact({
    displayName: "Dr. Mara Voss",
    firstName: "Mara",
    lastName: "Voss",
    prefix: "Dr.",
    organization: "Orbital Garden Lab",
    department: "Greenhouse Systems",
    title: "Lead Botanist",
    phones: [{ label: "cell", value: "+1 202-555-0147", preferred: true }],
    emails: [{ label: "work", value: "mara.voss@example.com" }],
    urls: [{ label: "portfolio", value: "https://example.com/mara-voss" }],
    addresses: [{ label: "work", street: "1 Tranquility Way", city: "Lunar City" }],
    socialProfiles: [{ service: "mastodon", userId: "@mara", value: "https://example.social/@mara" }],
    note: "iBlue round-trip test, line one\nline two",
  }, { data: portrait, mimeType: "image/png" });
  assert.match(vcf, /PHOTO;ENCODING=b;TYPE=PNG:/);
  assert.match(vcf, /\r\n /, "long vCard lines are folded");

  const [card] = parseVCardContactCards(vcf);
  assert.equal(card?.displayName, "Dr. Mara Voss");
  assert.equal(card?.organization, "Orbital Garden Lab");
  assert.equal(card?.department, "Greenhouse Systems");
  assert.deepEqual(card?.phones?.[0], {
    value: "+1 202-555-0147",
    label: "cell",
    types: ["cell", "pref"],
    preferred: true,
  });
  assert.equal(card?.addresses?.[0]?.city, "Lunar City");
  assert.equal(card?.socialProfiles?.[0]?.service, "mastodon");
  assert.equal(card?.note, "iBlue round-trip test, line one\nline two");
  assert.deepEqual(card?.photoData, portrait);
  assert.deepEqual(card?.photo, { mimeType: "image/png", totalBytes: portrait.length });
});

test("shared vCards resolve grouped Apple custom labels", () => {
  const [card] = parseVCardContactCards([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Label Example",
    "item1.EMAIL:label@example.com",
    "item1.X-ABLabel:_$!<Work>!$_",
    "END:VCARD",
  ].join("\r\n"));
  assert.equal(card?.emails?.[0]?.label, "work");
});

test("Maps balloons normalize coordinates and useful display metadata", () => {
  assert.deepEqual(sharedLocationFromBalloon({
    bundleId: "com.apple.Maps.MessagesExtension",
    appName: "Maps",
    url: "https://maps.apple.com/?ll=37.3349,-122.009&name=Apple%20Park",
    sessionId: "location-session",
    isLive: false,
    imageTitle: "Apple Park",
    subcaption: "One Apple Park Way, Cupertino",
  }), {
    latitude: 37.3349,
    longitude: -122.009,
    label: "Apple Park",
    address: "One Apple Park Way, Cupertino",
    url: "https://maps.apple.com/?ll=37.3349,-122.009&name=Apple%20Park",
    isLive: false,
    sessionId: "location-session",
    bundleId: "com.apple.Maps.MessagesExtension",
  });
  assert.equal(sharedLocationFromBalloon({
    bundleId: "com.example.game",
    url: "game://level/4",
    isLive: false,
  }), undefined);
});

test("Find My balloons decode their raw-deflate initial location", () => {
  const payload = deflateRawSync(Buffer.from(JSON.stringify({
    kind: { share: { duration: { indefinitely: {} } } },
    initialLocation: {
      latitude: 44.123456,
      longitude: -92.654321,
      horizontalAccuracy: 3,
    },
  }))).toString("base64");
  const url = `?FindMyMessagePayloadVersionKey=v0&FindMyMessagePayloadZippedDataKey=${
    payload.replace(/=/g, "%3D")
  }`;

  assert.deepEqual(sharedLocationFromBalloon({
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.findmy.FindMyMessagesApp",
    appName: "Find My",
    url,
    isLive: true,
    ldText: "Started Sharing Location",
  }), {
    latitude: 44.123456,
    longitude: -92.654321,
    label: "Started Sharing Location",
    url,
    isLive: true,
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.findmy.FindMyMessagesApp",
  });
});

test("plain Apple Maps pin messages normalize as static locations", () => {
  const url = "https://maps.apple.com/place?coordinate=37.334900,-122.009000&name=Dropped%20Pin&span=0.01,0.02";
  assert.deepEqual(sharedLocationFromMessageText(url), {
    latitude: 37.3349,
    longitude: -122.009,
    label: "Dropped Pin",
    url,
    isLive: false,
  });
});
