import type { IncomingAttachment } from "../types.js";
import type { IBlueAppleMusicLink, IBlueRichLink } from "./contracts.js";

export const RICH_LINK_METADATA_MIME = "x-richlink/meta";
export const RICH_LINK_IMAGE_MIME = "x-richlink/image";

export interface DecodedRichLink {
  value: Omit<IBlueRichLink, "artwork">;
  metadataAttachmentIndex: number;
  artworkAttachmentIndex?: number;
  artworkMimeType?: string;
}

function appleMusicLink(value: string): IBlueAppleMusicLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "music.apple.com") return undefined;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  const storefront = parts[0]!;
  const pathType = parts[1]!;
  const pathId = parts.at(-1)!;
  const songId = url.searchParams.get("i") ?? undefined;
  const knownType = pathType === "song"
    || pathType === "album"
    || pathType === "playlist"
    || pathType === "artist"
    || pathType === "music-video"
    ? pathType
    : "unknown";
  const resourceType = pathType === "album" && songId ? "song" : knownType;
  const catalogId = songId ?? pathId;
  if (!catalogId) return undefined;

  return {
    storefront,
    resourceType,
    catalogId,
    ...(pathType === "album" ? { albumId: pathId } : {}),
    ...(songId ? { songId } : {}),
  };
}

export function decodeRichLink(attachments: readonly IncomingAttachment[] | undefined): DecodedRichLink | undefined {
  if (!attachments) return undefined;
  const metadataAttachmentIndex = attachments.findIndex(({ mimeType }) => mimeType === RICH_LINK_METADATA_MIME);
  if (metadataAttachmentIndex < 0) return undefined;
  const encoded = attachments[metadataAttachmentIndex]?.dataBase64;
  if (!encoded) return undefined;

  const [originalUrlField = "", urlField = "", title = "", summary = "", imageMimeType = ""] = Buffer
    .from(encoded, "base64")
    .toString("utf8")
    .split("\x01");
  const originalUrl = originalUrlField || urlField;
  if (!originalUrl) return undefined;
  const url = urlField || originalUrl;
  const music = appleMusicLink(url);
  const artworkAttachmentIndex = attachments.findIndex((attachment, index) =>
    index > metadataAttachmentIndex && attachment.mimeType === RICH_LINK_IMAGE_MIME);

  return {
    value: {
      provider: music ? "apple-music" : "generic",
      originalUrl,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(music ? { appleMusic: music } : {}),
    },
    metadataAttachmentIndex,
    ...(artworkAttachmentIndex < 0 ? {} : { artworkAttachmentIndex }),
    ...(imageMimeType ? { artworkMimeType: imageMimeType } : {}),
  };
}

export function richLinkArtworkFilename(mimeType: string): string {
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/gif"
      ? "gif"
      : mimeType === "image/heic"
        ? "heic"
        : "png";
  return `rich-link-artwork.${extension}`;
}

export function richLinkArtworkUti(mimeType: string): string {
  if (mimeType === "image/jpeg") return "public.jpeg";
  if (mimeType === "image/gif") return "com.compuserve.gif";
  if (mimeType === "image/heic") return "public.heic";
  if (mimeType === "image/png") return "public.png";
  return "public.image";
}
