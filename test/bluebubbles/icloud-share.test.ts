import assert from "node:assert/strict";
import test from "node:test";

import {
  ICLOUD_PHOTOS_BUNDLE_ID,
  ICloudShareResolver,
  encodeICloudShareTransport,
  iCloudShareFromBalloon,
  iCloudSharePresentation,
  parseICloudPhotosShareUrl,
  publicICloudShare,
} from "../../src/bluebubbles/icloud-share.js";

const SHARE_ID = "05dFixtureShareToken_1234567890";
const SHARE_URL = `https://share.icloud.com/photos/${SHARE_ID}`;

test("normalizes iCloud Photos share URLs and app balloons", () => {
  assert.deepEqual(parseICloudPhotosShareUrl(SHARE_URL), { shareId: SHARE_ID, url: SHARE_URL });
  assert.deepEqual(parseICloudPhotosShareUrl(`https://www.icloud.com/photos/#${SHARE_ID}`), {
    shareId: SHARE_ID,
    url: SHARE_URL,
  });
  assert.equal(parseICloudPhotosShareUrl(`https://share.icloud.com.evil.example/photos/${SHARE_ID}`), undefined);
  assert.equal(parseICloudPhotosShareUrl("http://share.icloud.com/photos/not-secure"), undefined);
  assert.equal(parseICloudPhotosShareUrl(`https://share.icloud.com:444/photos/${SHARE_ID}`), undefined);
  assert.equal(parseICloudPhotosShareUrl(`https://user@share.icloud.com/photos/${SHARE_ID}`), undefined);

  assert.deepEqual(iCloudShareFromBalloon({
    appName: "None",
    bundleId: ICLOUD_PHOTOS_BUNDLE_ID,
    url: SHARE_URL,
    isLive: true,
    caption: "Wednesday\u2009–\u2009Friday",
    subcaption: "4 Photos, 1 Video",
    ldText: "Wednesday - Friday - 4 Photos, 1 Video",
  }), {
    provider: "icloud-photos",
    shareId: SHARE_ID,
    url: SHARE_URL,
    isLive: true,
    caption: "Wednesday\u2009–\u2009Friday",
    itemCount: 5,
    photoCount: 4,
    videoCount: 1,
    bundleId: ICLOUD_PHOTOS_BUNDLE_ID,
  });
});

test("bounds chunked iCloud metadata responses before buffering them", async () => {
  const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
  const resolver = new ICloudShareResolver(async () => new Response(oversized));
  await assert.rejects(
    resolver.resolve(SHARE_URL),
    /unexpectedly large iCloud Photos response/,
  );
});

test("encodes native Photos Messages app balloon transport", () => {
  const encoded = encodeICloudShareTransport({
    url: `https://www.icloud.com/photos/#${SHARE_ID}`,
    caption: "Wednesday\u2009–\u2009Friday",
    subcaption: "4 Photos",
  });
  assert.ok(encoded.transportText.startsWith("\x00ICL\x01"));
  assert.ok(encoded.transportText.endsWith("\x00\ufffd\ufffc"));
  assert.equal(encoded.balloon.bundleId, ICLOUD_PHOTOS_BUNDLE_ID);
  assert.equal(encoded.balloon.url, SHARE_URL);
  assert.equal(encoded.balloon.isLive, true);
  assert.equal(encoded.balloon.ldText, "Wednesday\u2009–\u2009Friday - 4 Photos");
  assert.equal(encoded.share.photoCount, 4);
});

test("resolves CloudKit share items without exposing Apple access tokens", async () => {
  const calls: Array<{ url: URL; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.pathname.endsWith("/records/resolve")) {
      return jsonResponse({
        results: [{
          zoneID: {
            zoneName: "CMM-ZONE",
            ownerRecordName: "_owner",
            zoneType: "REGULAR_CUSTOM_ZONE",
          },
          rootRecord: {
            recordName: "cmm-root",
            recordType: "CMMRoot",
            fields: {
              assetCount: field(1, "INT64"),
              photosCount: field(1, "INT64"),
              videosCount: field(0, "INT64"),
              startDate: field(1_786_041_600_000, "TIMESTAMP"),
              endDate: field(1_786_041_600_000, "TIMESTAMP"),
              createDate: field(1_786_042_000_000, "TIMESTAMP"),
            },
            pluginFields: { expiryDate: field(1_788_996_224_000, "TIMESTAMP") },
          },
          ownerIdentity: { nameComponents: { givenName: "Kyle", familyName: "Boyer" } },
          anonymousPublicAccess: {
            token: "secret-cloudkit-token",
            databasePartition: "https://p126-ckdatabasews.icloud.com:443",
          },
        }],
      });
    }
    if (url.pathname.endsWith("/records/query")) {
      assert.equal(url.searchParams.get("publicAccessAuthToken"), "secret-cloudkit-token");
      assert.deepEqual((body as { query: { recordType: string } }).query.recordType,
        "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted");
      return jsonResponse({
        records: [
          {
            recordName: "master-1",
            recordType: "CPLMaster",
            fields: {
              itemType: field("public.heic", "STRING"),
              resOriginalFileType: field("public.heic", "STRING"),
              resOriginalFileSize: field(1234, "INT64"),
              resOriginalWidth: field(4032, "INT64"),
              resOriginalHeight: field(3024, "INT64"),
              resOriginalRes: field({
                downloadURL: "https://cvws-h2.icloud-content.com/B/file/${f}?signed=1",
                size: 1234,
              }, "ASSETID"),
              resJPEGThumbFileType: field("public.jpeg", "STRING"),
              resJPEGThumbFileSize: field(123, "INT64"),
              resJPEGThumbWidth: field(360, "INT64"),
              resJPEGThumbHeight: field(270, "INT64"),
              resJPEGThumbRes: field({
                downloadURL: "https://cvws-h2.icloud-content.com/B/thumb/${f}?signed=1",
                size: 123,
              }, "ASSETID"),
            },
          },
          {
            recordName: "asset-guid-1",
            recordType: "CPLAsset",
            fields: {
              masterRef: field({ recordName: "master-1" }, "REFERENCE"),
              assetDate: field(1_786_041_600_000, "TIMESTAMP"),
              duration: field(0, "INT64"),
            },
          },
        ],
      });
    }
    if (url.hostname === "cvws-h2.icloud-content.com") {
      assert.equal(url.pathname, "/B/file/public.heic");
      return new Response(Buffer.from("heic-bytes"), {
        headers: { "content-type": "image/heic", "content-length": "10" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const resolver = new ICloudShareResolver(fetchImpl);
  const resolved = await resolver.resolve(SHARE_URL);
  assert.equal(resolved.itemCount, 1);
  assert.equal(resolved.ownerDisplayName, "Kyle Boyer");
  assert.equal(resolved.items[0]?.mediaType, "image");
  assert.equal(resolved.items[0]?.variants.original?.mimeType, "image/heic");
  assert.equal(resolved.items[0]?.variants.original?.width, 4032);
  assert.equal(resolved.expiresAt, 1_788_996_224_000);

  const presentation = iCloudSharePresentation(resolved);
  assert.equal(presentation.caption, "Thursday");
  assert.equal(presentation.subcaption, "1 Photo");

  const publicValue = publicICloudShare(resolved, "message-guid");
  assert.equal(publicValue.items[0]?.variants.original?.downloadUrl,
    "/api/v1/iblue/icloud-share/message-guid/item/asset-guid-1/original");
  assert.equal(JSON.stringify(publicValue).includes("secret-cloudkit-token"), false);
  assert.equal(JSON.stringify(publicValue).includes("sourceUrl"), false);
  assert.equal(JSON.stringify(publicValue).includes("icloud-content.com"), false);

  const asset = await resolver.fetchAsset(SHARE_URL, "asset-guid-1", "original");
  assert.equal(asset.mimeType, "image/heic");
  assert.equal(asset.filename, "asset-guid-1-original.heic");
  assert.deepEqual(Buffer.from(await asset.response.arrayBuffer()), Buffer.from("heic-bytes"));
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/records/resolve")).length, 1);
});

function field(value: unknown, type: string): { value: unknown; type: string } {
  return { value, type };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
