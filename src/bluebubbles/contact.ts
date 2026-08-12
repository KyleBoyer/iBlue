import type {
  IBlueContactCardAddress,
  IBlueContactCardField,
  IBlueContactCardInput,
  IBlueContactCardSocialProfile,
  IBlueContactSource,
} from "./contracts.js";
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
  return parseVCardContactCards(vcf).flatMap((card) => {
    const addresses = [
      ...(card.phones ?? []).map(({ value }) => stripTransport(value.replace(/^tel:/i, ""))),
      ...(card.emails ?? []).map(({ value }) => stripTransport(value.replace(/^mailto:/i, ""))),
    ].filter((address, index, all) => {
      const key = contactAddressKey(address);
      return Boolean(key) && all.findIndex((candidate) => contactAddressKey(candidate) === key) === index;
    });
    if (addresses.length === 0) return [];
    return [{
      addresses,
      displayName: card.displayName,
      ...(card.firstName ? { firstName: card.firstName } : {}),
      ...(card.lastName ? { lastName: card.lastName } : {}),
      ...(card.nickname ? { nickname: card.nickname } : {}),
      ...(card.photoData?.length ? { avatar: card.photoData } : {}),
      source: "profile-vcf" as const,
    }];
  });
}

interface VCardProperty {
  group?: string;
  name: string;
  parameters: Map<string, string[]>;
  value: string;
}

export interface ParsedVCardContactCard extends IBlueContactCardInput {
  version?: string;
  photo?: { mimeType: string; totalBytes: number };
  photoData?: Buffer;
}

/** Parse one or more vCards while preserving Apple labels and preferred fields. */
export function parseVCardContactCards(vcf: string): ParsedVCardContactCard[] {
  const cards = unfoldVCard(vcf).match(/BEGIN:VCARD\n[\s\S]*?END:VCARD/gi) ?? [];
  return cards.flatMap((card) => {
    const properties = card.split("\n").flatMap(parseProperty);
    const labels = new Map(properties
      .filter((property) => property.group && property.name === "X-ABLABEL")
      .map((property) => [property.group!, cleanAppleLabel(property.value)]));
    const first = (name: string): string | undefined => properties
      .filter((property) => property.name === name)
      .map((property) => unescapeVCardValue(property.value).trim())
      .find(Boolean);
    const structuredName = splitStructuredValue(
      properties.find((property) => property.name === "N")?.value ?? "",
    );
    const lastName = structuredName[0] || undefined;
    const firstName = structuredName[1] || undefined;
    const middleName = structuredName[2] || undefined;
    const prefix = structuredName[3] || undefined;
    const suffix = structuredName[4] || undefined;
    const nickname = first("NICKNAME");
    const organizationParts = splitStructuredValue(
      properties.find((property) => property.name === "ORG")?.value ?? "",
    );
    const organization = organizationParts[0] || undefined;
    const department = organizationParts[1] || undefined;
    const displayName = first("FN")
      || [prefix, firstName, middleName, lastName, suffix].filter(Boolean).join(" ")
      || organization
      || nickname;
    if (!displayName) return [];

    const fields = (name: string): IBlueContactCardField[] => properties
      .filter((property) => property.name === name)
      .flatMap((property) => {
        const value = unescapeVCardValue(property.value).trim();
        return value ? [{
          value,
          ...fieldMetadata(property, labels),
        }] : [];
      });
    const addresses = properties
      .filter((property) => property.name === "ADR")
      .flatMap((property): IBlueContactCardAddress[] => {
        const parts = splitStructuredValue(property.value);
        const address: IBlueContactCardAddress = {
          ...fieldMetadata(property, labels),
          ...(parts[1] ? { extended: parts[1] } : {}),
          ...(parts[2] ? { street: parts[2] } : {}),
          ...(parts[3] ? { city: parts[3] } : {}),
          ...(parts[4] ? { region: parts[4] } : {}),
          ...(parts[5] ? { postalCode: parts[5] } : {}),
          ...(parts[6] ? { country: parts[6] } : {}),
        };
        return Object.keys(address).length > 0 ? [address] : [];
      });
    const socialProfiles = properties
      .filter((property) => property.name === "X-SOCIALPROFILE")
      .flatMap((property): IBlueContactCardSocialProfile[] => {
        const value = unescapeVCardValue(property.value).trim();
        if (!value) return [];
        const types = property.parameters.get("TYPE") ?? [];
        const service = types.find((type) => type.toLowerCase() !== "pref");
        const userId = property.parameters.get("X-USERID")?.[0];
        return [{
          value,
          ...fieldMetadata(property, labels),
          ...(service ? { service: service.toLowerCase() } : {}),
          ...(userId ? { userId: userId } : {}),
        }];
      });
    const photoProperty = properties.find((property) => property.name === "PHOTO");
    const photoData = photoProperty && hasParameter(photoProperty, "ENCODING", "b", "base64")
      ? decodeBase64(photoProperty.value)
      : undefined;
    const photo = photoData?.length && photoProperty
      ? { mimeType: contactPhotoMime(photoData, photoProperty), totalBytes: photoData.length }
      : undefined;
    const title = first("TITLE");
    const birthday = first("BDAY");
    const note = first("NOTE");
    const version = first("VERSION");

    return [{
      displayName,
      ...(firstName ? { firstName } : {}),
      ...(middleName ? { middleName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      ...(nickname ? { nickname } : {}),
      ...(organization ? { organization } : {}),
      ...(department ? { department } : {}),
      ...(title ? { title } : {}),
      ...(birthday ? { birthday } : {}),
      ...(note ? { note } : {}),
      ...(fields("TEL").length ? { phones: fields("TEL") } : {}),
      ...(fields("EMAIL").length ? { emails: fields("EMAIL") } : {}),
      ...(fields("URL").length ? { urls: fields("URL") } : {}),
      ...(addresses.length ? { addresses } : {}),
      ...(socialProfiles.length ? { socialProfiles } : {}),
      ...(version ? { version } : {}),
      ...(photo && photoData ? { photo, photoData } : {}),
    }];
  });
}

/** Build an Apple-compatible vCard 3.0 attachment from normalized fields. */
export function buildVCardContact(
  contact: IBlueContactCardInput,
  photo?: { data: Buffer; mimeType: string },
): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//iBlue//Contact Card 1.0//EN",
    `N:${[
      contact.lastName,
      contact.firstName,
      contact.middleName,
      contact.prefix,
      contact.suffix,
    ].map((value) => escapeVCardValue(value ?? "")).join(";")}`,
    `FN:${escapeVCardValue(contact.displayName)}`,
  ];
  if (contact.nickname) lines.push(`NICKNAME:${escapeVCardValue(contact.nickname)}`);
  if (contact.organization || contact.department) {
    lines.push(`ORG:${escapeVCardValue(contact.organization ?? "")};${escapeVCardValue(contact.department ?? "")}`);
  }
  if (contact.title) lines.push(`TITLE:${escapeVCardValue(contact.title)}`);
  for (const field of contact.phones ?? []) lines.push(vCardFieldLine("TEL", field));
  for (const field of contact.emails ?? []) lines.push(vCardFieldLine("EMAIL", field));
  for (const field of contact.urls ?? []) lines.push(vCardFieldLine("URL", field));
  for (const address of contact.addresses ?? []) {
    const types = [address.label, address.preferred ? "pref" : undefined]
      .filter((value): value is string => Boolean(value));
    const descriptor = types.length ? `ADR;TYPE=${types.map(escapeParameter).join(",")}` : "ADR";
    lines.push(`${descriptor}:${[
      "",
      address.extended,
      address.street,
      address.city,
      address.region,
      address.postalCode,
      address.country,
    ].map((value) => escapeVCardValue(value ?? "")).join(";")}`);
  }
  for (const profile of contact.socialProfiles ?? []) {
    const service = profile.service || profile.label;
    const parameters = [
      ...(service ? [`TYPE=${escapeParameter(service)}`] : []),
      ...(profile.preferred ? ["TYPE=pref"] : []),
      ...(profile.userId ? [`X-USERID=${escapeParameter(profile.userId)}`] : []),
    ];
    lines.push(`X-SOCIALPROFILE${parameters.length ? `;${parameters.join(";")}` : ""}:${escapeVCardValue(profile.value)}`);
  }
  if (contact.birthday) lines.push(`BDAY:${escapeVCardValue(contact.birthday)}`);
  if (contact.note) lines.push(`NOTE:${escapeVCardValue(contact.note)}`);
  if (photo?.data.length) {
    const type = photo.mimeType === "image/png" ? "PNG" : "JPEG";
    lines.push(`PHOTO;ENCODING=b;TYPE=${type}:${photo.data.toString("base64")}`);
  }
  lines.push("END:VCARD");
  return `${lines.map(foldVCardLine).join("\r\n")}\r\n`;
}

function unfoldVCard(vcf: string): string {
  return vcf
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
}

function parseProperty(line: string): VCardProperty[] {
  const separator = descriptorSeparator(line);
  if (separator < 0) return [];
  const descriptorParts = line.slice(0, separator).split(";");
  const qualifiedName = descriptorParts.shift() ?? "";
  const nameParts = qualifiedName.split(".");
  const name = (nameParts.pop() ?? "").toUpperCase();
  if (!name) return [];
  const group = nameParts.join(".") || undefined;
  const parameters = new Map<string, string[]>();
  for (const raw of descriptorParts) {
    const equals = raw.indexOf("=");
    const key = equals < 0 ? "TYPE" : raw.slice(0, equals).toUpperCase();
    const value = equals < 0 ? raw : raw.slice(equals + 1);
    const values = splitParameter(value).map((item) => item.replace(/^"|"$/g, ""));
    parameters.set(key, [...(parameters.get(key) ?? []), ...values]);
  }
  const rawValue = line.slice(separator + 1);
  const value = hasParameter({ parameters }, "ENCODING", "quoted-printable")
    ? decodeQuotedPrintable(rawValue)
    : rawValue;
  return [{ ...(group ? { group } : {}), name, parameters, value }];
}

function descriptorSeparator(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ":" && !quoted) return index;
  }
  return -1;
}

function splitParameter(value: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      if (current) output.push(current);
      current = "";
    } else current += character;
  }
  if (current) output.push(current);
  return output;
}

function splitStructuredValue(value: string): string[] {
  const output: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character === "n" || character === "N" ? "\n" : character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === ";") {
      output.push(current.trim());
      current = "";
    } else current += character;
  }
  output.push(current.trim());
  return output;
}

function fieldMetadata(
  property: VCardProperty,
  labels: ReadonlyMap<string, string>,
): Pick<IBlueContactCardField, "label" | "types" | "preferred"> {
  const types = (property.parameters.get("TYPE") ?? []).map(cleanAppleLabel).filter(Boolean);
  const label = (property.group ? labels.get(property.group) : undefined)
    ?? types.find((type) => type.toLowerCase() !== "pref");
  const preferred = types.some((type) => type.toLowerCase() === "pref")
    || hasParameter(property, "PREF", "1");
  return {
    ...(label ? { label: label.toLowerCase() } : {}),
    ...(types.length ? { types: types.map((type) => type.toLowerCase()) } : {}),
    ...(preferred ? { preferred: true } : {}),
  };
}

function hasParameter(property: Pick<VCardProperty, "parameters">, key: string, ...values: string[]): boolean {
  const expected = new Set(values.map((value) => value.toLowerCase()));
  return (property.parameters.get(key.toUpperCase()) ?? [])
    .some((value) => expected.has(value.toLowerCase()));
}

function cleanAppleLabel(value: string): string {
  return unescapeVCardValue(value)
    .replace(/^_\$!<(.*)>!\$_$/, "$1")
    .trim();
}

function contactPhotoMime(data: Buffer, property: VCardProperty): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const type = (property.parameters.get("TYPE") ?? [])[0]?.toLowerCase();
  return type === "png" ? "image/png" : type === "gif" ? "image/gif" : "image/jpeg";
}

function vCardFieldLine(name: string, field: IBlueContactCardField): string {
  const types = [
    ...(field.types ?? []),
    ...(field.label && !(field.types ?? []).some((value) => value.toLowerCase() === field.label!.toLowerCase())
      ? [field.label]
      : []),
    ...(field.preferred ? ["pref"] : []),
  ].filter((value, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
  return `${name}${types.length ? `;TYPE=${types.map(escapeParameter).join(",")}` : ""}:${escapeVCardValue(field.value)}`;
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function escapeParameter(value: string): string {
  return value.replace(/[\r\n,;:]/g, "").trim();
}

function foldVCardLine(line: string): string {
  const output: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character);
    if (bytes + width > 75 && current) {
      output.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += width;
  }
  output.push(current);
  return output.join("\r\n");
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
