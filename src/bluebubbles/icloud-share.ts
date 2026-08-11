import type { IncomingAppBalloon } from "../types.js";
import type {
  IBlueICloudShare,
  IBlueICloudShareItem,
  IBlueICloudShareSummary,
  IBlueICloudShareVariant,
  IBlueICloudShareVariantName,
} from "./contracts.js";

export const ICLOUD_PHOTOS_BUNDLE_ID =
  "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp";

const ICLOUD_PHOTOS_BUNDLE_SUFFIX = "com.apple.mobileslideshow.PhotosMessagesApp";
const CLOUDKIT_RESOLVE_URL =
  "https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RESOLVED_ITEMS = 100;
const DEFAULT_CACHE_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;

type Fetch = typeof fetch;
type VariantWithSource = IBlueICloudShareVariant & { sourceUrl: string };

interface CloudKitRecord {
  recordName?: unknown;
  recordType?: unknown;
  fields?: unknown;
}

interface ResolvedICloudShareItem extends Omit<IBlueICloudShareItem, "variants"> {
  variants: Partial<Record<IBlueICloudShareVariantName, VariantWithSource>>;
}

export interface ResolvedICloudShare extends Omit<IBlueICloudShare, "items"> {
  items: ResolvedICloudShareItem[];
}

export interface ICloudShareAssetResponse {
  response: Response;
  filename: string;
  mimeType: string;
  totalBytes: number;
}

export class ICloudShareError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 | 504 = 502,
  ) {
    super(message);
  }
}

export class ICloudShareResolver {
  readonly #fetch: Fetch;
  readonly #cacheMs: number;
  readonly #cache = new Map<string, { expiresAt: number; value: ResolvedICloudShare }>();

  constructor(fetchImpl: Fetch = fetch, cacheMs = DEFAULT_CACHE_MS) {
    this.#fetch = fetchImpl;
    this.#cacheMs = Math.max(0, cacheMs);
  }

  async resolve(shareUrl: string, force = false): Promise<ResolvedICloudShare> {
    const parsed = parseICloudPhotosShareUrl(shareUrl);
    if (!parsed) throw new ICloudShareError("Invalid iCloud Photos share URL", 400);
    const cached = this.#cache.get(parsed.shareId);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const resolveUrl = new URL(CLOUDKIT_RESOLVE_URL);
    resolveUrl.searchParams.set("remapEnums", "true");
    resolveUrl.searchParams.set("getCurrentSyncToken", "true");
    resolveUrl.searchParams.set("sharing_url_key", parsed.shareId);
    const resolved = await this.#requestJson(resolveUrl, {
      shortGUIDs: [{ value: parsed.shareId }],
    });
    const result = records(resolved, "results")[0];
    if (!result) throw new ICloudShareError("iCloud Photos share was not found or has expired", 404);

    const root = record(result.rootRecord);
    const zoneID = objectValue(result.zoneID);
    const publicAccess = objectValue(result.anonymousPublicAccess);
    const accessToken = stringValue(publicAccess.token);
    const partition = cloudKitPartition(stringValue(publicAccess.databasePartition));
    if (!root || !zoneID || !accessToken || !partition) {
      throw new ICloudShareError("iCloud Photos share did not include public download access", 404);
    }

    const itemCount = integerField(root, "assetCount") ?? 0;
    const photoCount = integerField(root, "photosCount") ?? 0;
    const videoCount = integerField(root, "videosCount") ?? 0;
    const owner = objectValue(result.ownerIdentity);
    const ownerName = objectValue(owner.nameComponents);
    const ownerDisplayName = [stringValue(ownerName.givenName), stringValue(ownerName.familyName)]
      .filter(Boolean)
      .join(" ") || undefined;

    let items: ResolvedICloudShareItem[] = [];
    if (itemCount > 0) {
      const returnedItemCount = Math.min(itemCount, MAX_RESOLVED_ITEMS);
      const queryUrl = new URL("/database/1/com.apple.photos.cloud/production/shared/records/query", partition);
      queryUrl.searchParams.set("remapEnums", "true");
      queryUrl.searchParams.set("getCurrentSyncToken", "true");
      queryUrl.searchParams.set("publicAccessAuthToken", accessToken);
      const query = await this.#requestJson(queryUrl, {
        query: {
          recordType: "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
          filterBy: [
            {
              fieldName: "direction",
              comparator: "EQUALS",
              fieldValue: { value: "DESCENDING", type: "STRING" },
            },
            {
              fieldName: "startRank",
              comparator: "EQUALS",
              fieldValue: { value: itemCount - 1, type: "INT64" },
            },
          ],
        },
        zoneID,
        resultsLimit: returnedItemCount * 2,
      });
      items = normalizeItems(records(query, "records"));
    }

    const resolvedShare: ResolvedICloudShare = {
      provider: "icloud-photos",
      shareId: parsed.shareId,
      url: parsed.url,
      isLive: true,
      itemCount,
      photoCount,
      videoCount,
      ...(timestampField(root, "startDate") === undefined
        ? {}
        : { startDate: timestampField(root, "startDate")! }),
      ...(timestampField(root, "endDate") === undefined
        ? {}
        : { endDate: timestampField(root, "endDate")! }),
      ...(timestampField(root, "createDate") === undefined
        ? {}
        : { createdAt: timestampField(root, "createDate")! }),
      ...(timestampField(root, "expiryDate", "pluginFields") === undefined
        ? {}
        : { expiresAt: timestampField(root, "expiryDate", "pluginFields")! }),
      ...(ownerDisplayName ? { ownerDisplayName } : {}),
      truncated: itemCount > items.length,
      items,
    };
    this.#cache.set(parsed.shareId, { expiresAt: Date.now() + this.#cacheMs, value: resolvedShare });
    return resolvedShare;
  }

  async fetchAsset(
    shareUrl: string,
    itemGuid: string,
    variantName: IBlueICloudShareVariantName,
  ): Promise<ICloudShareAssetResponse> {
    let resolved = await this.resolve(shareUrl);
    let variant = resolved.items.find(({ guid }) => guid === itemGuid)?.variants[variantName];
    if (!variant) throw new ICloudShareError("iCloud Photos share item or variant was not found", 404);

    let response = await this.#fetchAssetUrl(variant.sourceUrl);
    if ((response.status === 401 || response.status === 403 || response.status === 404) && this.#cacheMs > 0) {
      resolved = await this.resolve(shareUrl, true);
      variant = resolved.items.find(({ guid }) => guid === itemGuid)?.variants[variantName];
      if (!variant) throw new ICloudShareError("iCloud Photos share item or variant was not found", 404);
      response = await this.#fetchAssetUrl(variant.sourceUrl);
    }
    if (!response.ok) {
      throw new ICloudShareError(`Apple returned HTTP ${response.status} for shared media`, 502);
    }
    return {
      response,
      filename: `${safeFilename(itemGuid)}-${variantName}.${extensionForMime(variant.mimeType)}`,
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] || variant.mimeType,
      totalBytes: numberHeader(response.headers.get("content-length")) ?? variant.totalBytes,
    };
  }

  async #requestJson(url: URL, body: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ICloudShareError("Apple timed out while resolving the iCloud Photos share", 504);
      }
      throw new ICloudShareError(`Could not resolve iCloud Photos share: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502;
      throw new ICloudShareError(`Apple returned HTTP ${response.status} for the iCloud Photos share`, status);
    }
    const declaredBytes = numberHeader(response.headers.get("content-length"));
    if (declaredBytes !== undefined && declaredBytes > MAX_JSON_BYTES) {
      throw new ICloudShareError("Apple returned an unexpectedly large iCloud Photos response");
    }
    const bytes = await readLimitedResponse(response, MAX_JSON_BYTES);
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      throw new ICloudShareError("Apple returned malformed iCloud Photos metadata");
    }
  }

  async #fetchAssetUrl(sourceUrl: string): Promise<Response> {
    let current = assetUrl(sourceUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetch(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new ICloudShareError("Apple timed out while downloading shared media", 504);
        }
        throw new ICloudShareError(`Could not download shared media: ${errorMessage(error)}`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new ICloudShareError("Apple returned an invalid shared-media redirect");
      current = assetUrl(new URL(location, current).toString());
    }
    throw new ICloudShareError("Apple returned too many shared-media redirects");
  }
}

export function parseICloudPhotosShareUrl(value: string): { shareId: string; url: string } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port && url.port !== "443"
  ) return undefined;
  const hostname = url.hostname.toLowerCase();
  let shareId: string | undefined;
  if (hostname === "share.icloud.com" || hostname === "share.icloud.com.cn") {
    const match = url.pathname.match(/^\/photos\/([A-Za-z0-9_-]+)\/?$/);
    shareId = match?.[1];
  } else if (
    hostname === "www.icloud.com"
    || hostname === "icloud.com"
    || hostname === "www.icloud.com.cn"
    || hostname === "icloud.com.cn"
  ) {
    if (/^\/photos\/?$/.test(url.pathname)) shareId = url.hash.replace(/^#/, "");
  }
  if (!shareId || !/^[A-Za-z0-9_-]{16,128}$/.test(shareId)) return undefined;
  const shareHost = hostname.endsWith(".cn") ? "share.icloud.com.cn" : "share.icloud.com";
  return { shareId, url: `https://${shareHost}/photos/${shareId}` };
}

export function iCloudShareFromBalloon(
  balloon: IncomingAppBalloon | undefined,
): IBlueICloudShareSummary | undefined {
  if (!balloon?.url) return undefined;
  if (balloon.bundleId && !balloon.bundleId.endsWith(ICLOUD_PHOTOS_BUNDLE_SUFFIX)) return undefined;
  const parsed = parseICloudPhotosShareUrl(balloon.url);
  if (!parsed) return undefined;
  const counts = countsFromText([balloon.subcaption, balloon.ldText].filter(Boolean).join(" "));
  return {
    provider: "icloud-photos",
    shareId: parsed.shareId,
    url: parsed.url,
    isLive: balloon.isLive,
    ...(balloon.caption ? { caption: balloon.caption } : {}),
    ...counts,
    ...(balloon.bundleId ? { bundleId: balloon.bundleId } : {}),
  };
}

export function encodeICloudShareTransport(input: {
  url: string;
  caption?: string;
  subcaption?: string;
  ldText?: string;
}): { transportText: string; balloon: IncomingAppBalloon; share: IBlueICloudShareSummary } {
  const parsed = parseICloudPhotosShareUrl(input.url);
  if (!parsed) throw new ICloudShareError("Invalid iCloud Photos share URL", 400);
  const caption = input.caption?.trim() ?? "";
  const subcaption = input.subcaption?.trim() ?? "Shared Photos";
  const ldText = input.ldText?.trim() || [caption, subcaption].filter(Boolean).join(" - ");
  const metadata = Buffer.from(JSON.stringify({
    url: parsed.url,
    caption,
    subcaption,
    ldText,
  }), "utf8").toString("base64");
  const balloon: IncomingAppBalloon = {
    appName: "None",
    bundleId: ICLOUD_PHOTOS_BUNDLE_ID,
    url: parsed.url,
    isLive: true,
    ldText,
    imageTitle: "",
    imageSubtitle: "",
    caption,
    subcaption,
    secondarySubcaption: "",
    tertiarySubcaption: "",
  };
  return {
    transportText: `\x00ICL\x01${metadata}\x00\ufffd\ufffc`,
    balloon,
    share: iCloudShareFromBalloon(balloon)!,
  };
}

export function iCloudSharePresentation(
  share: Pick<IBlueICloudShare, "startDate" | "endDate" | "itemCount" | "photoCount" | "videoCount">,
): { caption: string; subcaption: string; ldText: string } {
  const caption = dateRangeCaption(share.startDate, share.endDate);
  const labels = [
    countLabel(share.photoCount, "Photo"),
    countLabel(share.videoCount, "Video"),
  ].filter((value): value is string => Boolean(value));
  const subcaption = labels.join(", ") || countLabel(share.itemCount, "Item") || "Shared Photos";
  return { caption, subcaption, ldText: [caption, subcaption].filter(Boolean).join(" - ") };
}

export function publicICloudShare(
  share: ResolvedICloudShare,
  messageGuid: string,
): IBlueICloudShare {
  return {
    ...share,
    items: share.items.map((item) => ({
      ...item,
      variants: Object.fromEntries(
        Object.entries(item.variants).map(([name, variant]) => [
          name,
          {
            mimeType: variant.mimeType,
            uti: variant.uti,
            totalBytes: variant.totalBytes,
            width: variant.width,
            height: variant.height,
            downloadUrl: `/api/v1/iblue/icloud-share/${encodeURIComponent(messageGuid)}/item/${encodeURIComponent(item.guid)}/${name}`,
          },
        ] as const),
      ) as IBlueICloudShareItem["variants"],
    })),
  };
}

function normalizeItems(input: CloudKitRecord[]): ResolvedICloudShareItem[] {
  const masters = new Map(input
    .filter(({ recordType }) => recordType === "CPLMaster")
    .flatMap((item) => stringValue(item.recordName) ? [[stringValue(item.recordName)!, item] as const] : []));
  return input
    .filter(({ recordType }) => recordType === "CPLAsset")
    .flatMap((asset) => {
      const guid = stringValue(asset.recordName);
      const masterReference = objectValue(fieldValue(asset, "masterRef"));
      const master = masters.get(stringValue(masterReference.recordName) ?? "");
      if (!guid || !master) return [];
      const itemType = stringField(master, "itemType") ?? "";
      const durationMs = integerField(asset, "duration");
      const mediaType = mediaTypeFor(itemType, durationMs);
      const variants = Object.fromEntries(([
        ["original", "resOriginal"],
        ["medium", "resJPEGMed"],
        ["thumbnail", "resJPEGThumb"],
      ] as const).flatMap(([name, prefix]) => {
        const variant = variantFromMaster(master, prefix);
        return variant ? [[name, variant]] : [];
      })) as ResolvedICloudShareItem["variants"];
      return [{
        guid,
        mediaType,
        ...(timestampField(asset, "assetDate") === undefined
          ? {}
          : { createdAt: timestampField(asset, "assetDate")! }),
        ...(durationMs === undefined ? {} : { durationMs }),
        variants,
      }];
    })
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
}

function variantFromMaster(master: CloudKitRecord, prefix: string): VariantWithSource | undefined {
  const asset = objectValue(fieldValue(master, `${prefix}Res`));
  const template = stringValue(asset.downloadURL);
  const uti = stringField(master, `${prefix}FileType`);
  if (!template || !uti) return undefined;
  const mimeType = mimeForUti(uti);
  return {
    mimeType,
    uti,
    totalBytes: integerField(master, `${prefix}FileSize`) ?? integerValue(asset.size) ?? 0,
    width: integerField(master, `${prefix}Width`) ?? 0,
    height: integerField(master, `${prefix}Height`) ?? 0,
    sourceUrl: assetUrl(template.replace("${f}", `public.${extensionForMime(mimeType)}`)).toString(),
  };
}

function records(value: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const list = value[key];
  return Array.isArray(list)
    ? list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function record(value: unknown): CloudKitRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CloudKitRecord : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fieldValue(item: CloudKitRecord, name: string, container = "fields"): unknown {
  const fields = objectValue((item as Record<string, unknown>)[container]);
  return objectValue(fields[name]).value;
}

function stringField(item: CloudKitRecord, name: string): string | undefined {
  return stringValue(fieldValue(item, name));
}

function integerField(item: CloudKitRecord, name: string, container = "fields"): number | undefined {
  return integerValue(fieldValue(item, name, container));
}

function timestampField(item: CloudKitRecord, name: string, container = "fields"): number | undefined {
  return integerField(item, name, container);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function numberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function cloudKitPartition(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port && url.port !== "443"
  ) return undefined;
  if (!/^p\d+-ckdatabasews\.icloud\.com(?:\.cn)?$/i.test(url.hostname)) return undefined;
  return url;
}

function assetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ICloudShareError("Apple returned an invalid shared-media URL");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port && url.port !== "443"
    || !/\.icloud-content\.com(?:\.cn)?$/i.test(url.hostname)
  ) {
    throw new ICloudShareError("Apple returned an untrusted shared-media URL");
  }
  return url;
}

function countsFromText(value: string): Pick<IBlueICloudShareSummary, "itemCount" | "photoCount" | "videoCount"> {
  const photoCount = countMatch(value, /(?:^|\D)(\d+)\s+photos?\b/i);
  const videoCount = countMatch(value, /(?:^|\D)(\d+)\s+videos?\b/i);
  const itemCount = countMatch(value, /(?:^|\D)(\d+)\s+items?\b/i)
    ?? (photoCount === undefined && videoCount === undefined ? undefined : (photoCount ?? 0) + (videoCount ?? 0));
  return {
    ...(itemCount === undefined ? {} : { itemCount }),
    ...(photoCount === undefined ? {} : { photoCount }),
    ...(videoCount === undefined ? {} : { videoCount }),
  };
}

function countMatch(value: string, pattern: RegExp): number | undefined {
  const parsed = Number(pattern.exec(value)?.[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function dateRangeCaption(startDate: number | undefined, endDate: number | undefined): string {
  if (startDate === undefined || endDate === undefined) return "";
  const format = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
  const start = format.format(new Date(startDate));
  const end = format.format(new Date(endDate));
  return start === end ? start : `${start}\u2009–\u2009${end}`;
}

function countLabel(value: number | undefined, singular: string): string | undefined {
  if (value === undefined || value === 0) return undefined;
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function mediaTypeFor(itemType: string, durationMs: number | undefined): IBlueICloudShareItem["mediaType"] {
  const normalized = itemType.toLowerCase();
  if (durationMs && durationMs > 0 || normalized.includes("movie") || normalized.includes("video")) return "video";
  if (normalized.includes("image") || normalized.includes("jpeg") || normalized.includes("heic")) return "image";
  return "unknown";
}

function mimeForUti(uti: string): string {
  const normalized = uti.toLowerCase();
  if (normalized === "public.jpeg" || normalized === "public.jpg") return "image/jpeg";
  if (normalized === "public.png") return "image/png";
  if (normalized.includes("heic") || normalized.includes("heif")) return "image/heic";
  if (normalized.includes("quicktime") || normalized.endsWith(".movie")) return "video/quicktime";
  if (normalized.includes("mpeg-4") || normalized.includes("mp4")) return "video/mp4";
  return "application/octet-stream";
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/mp4") return "mp4";
  return "bin";
}

function safeFilename(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "icloud-share-item";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ICloudShareError("Apple returned an unexpectedly large iCloud Photos response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}
