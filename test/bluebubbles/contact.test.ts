import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { contactAddressKey, parseVCardContacts } from "../../src/bluebubbles/contact.js";
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
