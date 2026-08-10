import type { IBlueContactSource } from "./contracts.js";
import { stripTransport } from "./guid.js";

export interface ContactInput {
  addresses: string[];
  displayName: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  avatar?: Buffer;
  source: IBlueContactSource;
}

export function contactAddressKey(value: string): string {
  const stripped = stripTransport(value).trim();
  if (stripped.includes("@")) return stripped.toLowerCase();
  const international = stripped.startsWith("00") ? `+${stripped.slice(2)}` : stripped;
  const digits = international.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return `+${digits.slice(1).replace(/\D/g, "")}`;
  const national = digits.replace(/\D/g, "");
  return national.length === 10 ? `+1${national}` : national;
}

export function parseVCardContacts(vcf: string): ContactInput[] {
  const unfolded = vcf
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
  const cards = unfolded.match(/BEGIN:VCARD\n[\s\S]*?END:VCARD/gi) ?? [];
  return cards.flatMap((card) => {
    const properties = card.split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return [];
      const descriptor = line.slice(0, separator);
      const name = (descriptor.split(";")[0]?.split(".").at(-1) ?? "").toUpperCase();
      const parameters = descriptor.slice(descriptor.indexOf(";") + 1).toUpperCase();
      const rawValue = line.slice(separator + 1);
      const value = parameters.includes("ENCODING=QUOTED-PRINTABLE")
        ? decodeQuotedPrintable(rawValue)
        : rawValue;
      return [{ name, parameters, value }];
    });
    const values = (name: string): string[] => properties
      .filter((property) => property.name === name)
      .map((property) => unescapeVCardValue(property.value).trim())
      .filter(Boolean);
    const structuredName = values("N")[0]?.split(";") ?? [];
    const firstName = structuredName[1]?.trim() || undefined;
    const lastName = structuredName[0]?.trim() || undefined;
    const nickname = values("NICKNAME")[0];
    const displayName = values("FN")[0]
      || [firstName, lastName].filter(Boolean).join(" ")
      || nickname;
    const addresses = [
      ...values("TEL").map((value) => stripTransport(value.replace(/^tel:/i, ""))),
      ...values("EMAIL").map((value) => stripTransport(value.replace(/^mailto:/i, ""))),
    ].filter((address, index, all) => {
      const key = contactAddressKey(address);
      return Boolean(key) && all.findIndex((candidate) => contactAddressKey(candidate) === key) === index;
    });
    if (addresses.length === 0 || !displayName) return [];
    const photo = properties.find((property) => property.name === "PHOTO");
    const avatar = photo && /ENCODING=(?:B|BASE64)/.test(photo.parameters)
      ? decodeBase64(photo.value)
      : undefined;
    return [{
      addresses,
      displayName,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(nickname ? { nickname } : {}),
      ...(avatar?.length ? { avatar } : {}),
      source: "profile-vcf" as const,
    }];
  });
}

function unescapeVCardValue(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1");
}

function decodeQuotedPrintable(value: string): string {
  const joined = value.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const hex = joined.slice(index + 1, index + 3);
    if (joined[index] === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(Buffer.from(joined[index]!).at(0)!);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBase64(value: string): Buffer | undefined {
  const compact = value.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  try {
    return Buffer.from(compact, "base64");
  } catch {
    return undefined;
  }
}
