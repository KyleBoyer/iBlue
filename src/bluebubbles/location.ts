import { inflateRawSync } from "node:zlib";

import type { IncomingAppBalloon } from "../types.js";
import type { IBlueSharedLocation } from "./contracts.js";

export function sharedLocationFromBalloon(
  balloon: IncomingAppBalloon | undefined,
): IBlueSharedLocation | undefined {
  if (!balloon) return undefined;
  const url = balloon.url?.trim() ?? "";
  const locationHint = [balloon.bundleId, balloon.appName, url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const findMyPayload = findMyPayloadFromUrl(url);
  const coordinates = coordinatesFromUrl(url) ?? coordinatesFromFindMyPayload(findMyPayload);
  if (!coordinates && !isLocationBalloon(locationHint, url)) return undefined;

  const label = firstText(balloon.imageTitle, balloon.caption, balloon.ldText, labelFromUrl(url));
  const address = firstText(
    balloon.subcaption,
    balloon.imageSubtitle,
    balloon.secondarySubcaption,
    balloon.tertiarySubcaption,
  );
  return {
    ...(coordinates ?? {}),
    ...(label ? { label } : {}),
    ...(address && address !== label ? { address } : {}),
    url,
    isLive: balloon.isLive,
    ...(balloon.sessionId ? { sessionId: balloon.sessionId } : {}),
    ...(balloon.bundleId ? { bundleId: balloon.bundleId } : {}),
    ...(findMyPayload?.id ? { findMyId: findMyPayload.id } : {}),
  };
}

export function sharedLocationFromMessageText(
  text: string | undefined,
): IBlueSharedLocation | undefined {
  if (!text) return undefined;
  const urls = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  for (const url of urls) {
    const location = sharedLocationFromBalloon({ url, isLive: false });
    if (location) return location;
  }
  return undefined;
}

function coordinatesFromFindMyPayload(
  payload: FindMyMessagePayload | undefined,
): Pick<IBlueSharedLocation, "latitude" | "longitude"> | undefined {
  try {
    const location = payload?.initialLocation;
    if (!location || typeof location !== "object") return undefined;
    const latitude = Number((location as { latitude?: unknown }).latitude);
    const longitude = Number((location as { longitude?: unknown }).longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
    return { latitude, longitude };
  } catch {
    return undefined;
  }
}

interface FindMyMessagePayload {
  id?: string;
  initialLocation?: unknown;
}

function findMyPayloadFromUrl(value: string): FindMyMessagePayload | undefined {
  const match = value.match(/(?:^|[?&])FindMyMessagePayloadZippedDataKey=([^&]+)/);
  if (!match?.[1]) return undefined;
  try {
    // Apple's query value contains literal `+` base64 characters, so using
    // URLSearchParams would incorrectly translate them to spaces.
    const compressed = Buffer.from(decodeURIComponent(match[1]), "base64");
    if (compressed.length === 0 || compressed.length > 128 * 1024) return undefined;
    const payload = JSON.parse(inflateRawSync(compressed, {
      maxOutputLength: 1024 * 1024,
    }).toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    const decoded = payload as FindMyMessagePayload;
    return typeof decoded.id === "string" || decoded.initialLocation ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isLocationBalloon(hint: string, value: string): boolean {
  const appHint = [hint.split(" ")[0], hint.split(" ")[1]].filter(Boolean).join(" ");
  if (/(?:^|[.\s_-])(?:maps?|location|findmy)(?:[.\s_-]|$)/.test(appHint)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "maps:"
      || parsed.hostname === "maps.apple.com"
      || parsed.hostname.endsWith(".maps.apple.com")
      || (/(^|\.)google\.[a-z.]+$/.test(parsed.hostname) && parsed.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

function coordinatesFromUrl(value: string): Pick<IBlueSharedLocation, "latitude" | "longitude"> | undefined {
  if (!value) return undefined;
  const candidates: string[] = [];
  try {
    const parsed = new URL(value);
    for (const key of ["ll", "sll", "center", "coordinate", "coordinates", "daddr", "destination", "q"]) {
      const candidate = parsed.searchParams.get(key);
      if (candidate) candidates.push(candidate);
    }
    candidates.push(parsed.pathname);
  } catch {
    candidates.push(value);
  }
  candidates.push(value);
  for (const candidate of candidates) {
    const match = candidate.match(/(?:@|^|[^\d.-])(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)(?:$|[^\d.])/);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  return undefined;
}

function labelFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return firstText(parsed.searchParams.get("name") ?? undefined);
  } catch {
    return undefined;
  }
}

function firstText(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}
