import assert from "node:assert/strict";
import test from "node:test";

import type { IncomingAttachment } from "../../src/types.js";
import { decodeRichLink, encodeRichLinkTransport } from "../../src/bluebubbles/rich-link.js";

function attachment(mimeType: string, value: string): IncomingAttachment {
  return {
    mimeType,
    filename: "",
    utiType: "",
    size: Buffer.byteLength(value),
    isInline: true,
    dataBase64: Buffer.from(value).toString("base64"),
    iris: false,
  };
}

test("Apple Music rich links expose the shared song and catalog identifiers", () => {
  const url = "https://music.apple.com/us/album/way-too-self-aware-remix/6771198461?i=6771198463";
  const decoded = decodeRichLink([
    attachment(
      "x-richlink/meta",
      `${url}\x01${url}\x01Way Too Self Aware (Remix) — Ian Asher\x01\x01image/png`,
    ),
    attachment("x-richlink/image", "png"),
  ]);

  assert.deepEqual(decoded, {
    value: {
      provider: "apple-music",
      originalUrl: url,
      url,
      title: "Way Too Self Aware (Remix) — Ian Asher",
      appleMusic: {
        storefront: "us",
        resourceType: "song",
        catalogId: "6771198463",
        albumId: "6771198461",
        songId: "6771198463",
      },
    },
    metadataAttachmentIndex: 0,
    artworkAttachmentIndex: 1,
    artworkMimeType: "image/png",
  });
});

test("non-Music previews remain generic rich links", () => {
  const decoded = decodeRichLink([
    attachment("x-richlink/meta", "https://example.com\x01\x01Example\x01A summary\x01"),
  ]);
  assert.deepEqual(decoded?.value, {
    provider: "generic",
    originalUrl: "https://example.com",
    url: "https://example.com",
    title: "Example",
    summary: "A summary",
  });
});

test("outbound rich links carry artwork in the native transport envelope", () => {
  const url = "https://music.apple.com/us/album/example/123?i=456";
  const encoded = encodeRichLinkTransport({
    originalUrl: url,
    title: "Example — Artist",
    artworkMimeType: "image/png",
    artworkDataBase64: Buffer.from("png").toString("base64"),
    artworkAttachmentGuid: "artwork-guid",
    appleMusicPlayback: {
      storefrontIdentifier: "143441",
      storeIdentifier: "456",
      name: "Example",
      artist: "Artist",
      album: "Example - Single",
      previewUrl: "https://audio.example/preview.m4a",
    },
  });
  assert.ok(encoded.transportText.startsWith("\x00RL2\x01"));
  assert.equal(encoded.richLink.provider, "apple-music");
  assert.deepEqual(encoded.richLink.artwork, {
    attachmentGuid: "artwork-guid",
    mimeType: "image/png",
  });
});
