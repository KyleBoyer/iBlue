import type {
  IBlueAttributedBody,
  IBlueAttributedText,
  IBlueTextEffect,
  IBlueTextRun,
  IBlueTextStyle,
} from "./contracts.js";

export const IBLUE_TEXT_STYLES = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
] as const satisfies readonly IBlueTextStyle[];

export const IBLUE_TEXT_EFFECTS = [
  "big",
  "small",
  "shake",
  "nod",
  "explode",
  "ripple",
  "bloom",
  "jitter",
] as const satisfies readonly IBlueTextEffect[];

const EFFECT_WIRE_VALUES: Readonly<Record<IBlueTextEffect, number>> = {
  big: 5,
  small: 11,
  shake: 9,
  nod: 8,
  explode: 12,
  ripple: 4,
  bloom: 6,
  jitter: 10,
};

const STYLE_ATTRIBUTE_NAMES: Readonly<Record<IBlueTextStyle, string>> = {
  bold: "__kIMTextBoldAttributeName",
  italic: "__kIMTextItalicAttributeName",
  underline: "__kIMTextUnderlineAttributeName",
  strikethrough: "__kIMTextStrikethroughAttributeName",
};

const styleSet = new Set<string>(IBLUE_TEXT_STYLES);
const effectSet = new Set<string>(IBLUE_TEXT_EFFECTS);

function isTextStyle(value: unknown): value is IBlueTextStyle {
  return typeof value === "string" && styleSet.has(value);
}

function isTextEffect(value: unknown): value is IBlueTextEffect {
  return typeof value === "string" && effectSet.has(value);
}

function decodeHtml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hex, named) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (String(named).toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      case "nbsp": return "\u00a0";
      default: return entity;
    }
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function effectFromTag(tag: string): IBlueTextEffect | undefined {
  const match = /\bdata-mx-imessage-effect\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return isTextEffect(value?.toLowerCase()) ? value.toLowerCase() as IBlueTextEffect : undefined;
}

function sameFormatting(
  left: Pick<IBlueTextRun, "styles" | "effect">,
  right: Pick<IBlueTextRun, "styles" | "effect">,
): boolean {
  return left.effect === right.effect
    && (left.styles ?? []).join("\0") === (right.styles ?? []).join("\0");
}

/**
 * Parse the normalized semantic HTML emitted by the native IDS bridge.
 * JavaScript string offsets are UTF-16 code units, which matches Apple's
 * NSRange convention and BlueBubbles' attributed-body ranges.
 */
export function parseAttributedText(html: string): IBlueAttributedText {
  const counters: Record<IBlueTextStyle, number> = {
    bold: 0,
    italic: 0,
    underline: 0,
    strikethrough: 0,
  };
  const effectStack: Array<IBlueTextEffect | null> = [];
  const runs: IBlueTextRun[] = [];
  let text = "";

  const append = (value: string): void => {
    if (!value) return;
    const styles = IBLUE_TEXT_STYLES.filter((style) => counters[style] > 0);
    const effect = effectStack.findLast((value) => value !== null) ?? undefined;
    const next: IBlueTextRun = {
      range: [text.length, value.length],
      text: value,
      ...(styles.length > 0 ? { styles: [...styles] } : {}),
      ...(effect ? { effect } : {}),
    };
    const previous = runs.at(-1);
    if (previous && sameFormatting(previous, next)) {
      previous.range[1] += value.length;
      previous.text += value;
    } else {
      runs.push(next);
    }
    text += value;
  };

  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      append(decodeHtml(token));
      continue;
    }
    if (token.startsWith("<!--")) continue;
    const closing = /^<\s*\//.test(token);
    const name = /^<\s*\/?\s*([\w-]+)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    const delta = closing ? -1 : 1;
    const update = (style: IBlueTextStyle): void => {
      counters[style] = Math.max(0, counters[style] + delta);
    };
    switch (name) {
      case "strong":
      case "b": update("bold"); break;
      case "em":
      case "i": update("italic"); break;
      case "u": update("underline"); break;
      case "del":
      case "s":
      case "strike": update("strikethrough"); break;
      case "br": if (!closing) append("\n"); break;
      case "span": {
        if (closing) {
          effectStack.pop();
        } else {
          effectStack.push(effectFromTag(token) ?? null);
        }
        break;
      }
      default: break;
    }
  }

  return { text, html, rangeEncoding: "utf-16", runs };
}

export function attributedBodyFromText(value: IBlueAttributedText): IBlueAttributedBody[] {
  return [{
    string: value.text,
    runs: value.runs.map((run) => {
      const attributes: Record<string, string | number | boolean | string[]> = {};
      if (run.styles) {
        attributes.iBlueStyles = [...run.styles];
        for (const style of run.styles) attributes[STYLE_ATTRIBUTE_NAMES[style]] = true;
      }
      if (run.effect) {
        attributes.iBlueTextEffect = run.effect;
        attributes.__kIMTextEffectAttributeName = EFFECT_WIRE_VALUES[run.effect];
      }
      return { range: [...run.range], attributes };
    }),
  }];
}

function assertRangeBoundary(text: string, index: number): void {
  if (index <= 0 || index >= text.length) return;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new Error(`Text range boundary ${index} splits a UTF-16 surrogate pair`);
  }
}

export function parseOutboundTextRuns(value: unknown, text: string): IBlueTextRun[] {
  if (!Array.isArray(value)) throw new Error("'textRuns' must be an array");
  const runs: IBlueTextRun[] = [];
  let previousEnd = 0;
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`textRuns[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.range) || record.range.length !== 2) {
      throw new Error(`textRuns[${index}].range must be [location, length]`);
    }
    const [location, length] = record.range;
    if (!Number.isSafeInteger(location) || !Number.isSafeInteger(length)
      || Number(location) < 0 || Number(length) <= 0) {
      throw new Error(`textRuns[${index}].range must contain non-negative UTF-16 integers and a positive length`);
    }
    const start = Number(location);
    const end = start + Number(length);
    if (start < previousEnd) throw new Error("'textRuns' ranges must be sorted and non-overlapping");
    if (end > text.length) throw new Error(`textRuns[${index}].range exceeds the message length`);
    assertRangeBoundary(text, start);
    assertRangeBoundary(text, end);

    const styles = record.styles === undefined
      ? []
      : Array.isArray(record.styles) && record.styles.every(isTextStyle)
        ? [...new Set(record.styles)]
        : undefined;
    if (!styles) throw new Error(`textRuns[${index}].styles contains an unsupported style`);
    const effect = record.effect === undefined ? undefined : record.effect;
    if (effect !== undefined && !isTextEffect(effect)) {
      throw new Error(`textRuns[${index}].effect is unsupported`);
    }
    if (styles.length === 0 && effect === undefined) {
      throw new Error(`textRuns[${index}] must include at least one style or effect`);
    }
    if (styles.length > 0 && effect !== undefined) {
      throw new Error(`textRuns[${index}] cannot combine static styles with an animation`);
    }
    runs.push({
      range: [start, Number(length)],
      text: text.slice(start, end),
      ...(styles.length > 0 ? { styles } : {}),
      ...(effect !== undefined ? { effect } : {}),
    });
    previousEnd = end;
  }
  return runs;
}

export function htmlFromTextRuns(text: string, runs: readonly IBlueTextRun[]): string {
  let html = "";
  let cursor = 0;
  for (const run of runs) {
    const [start, length] = run.range;
    html += escapeHtml(text.slice(cursor, start));
    let value = escapeHtml(text.slice(start, start + length));
    if (run.effect) {
      value = `<span data-mx-imessage-effect="${run.effect}">${value}</span>`;
    } else {
      const tags: Readonly<Record<IBlueTextStyle, readonly [string, string]>> = {
        bold: ["<strong>", "</strong>"],
        italic: ["<em>", "</em>"],
        underline: ["<u>", "</u>"],
        strikethrough: ["<del>", "</del>"],
      };
      for (const style of run.styles ?? []) value = `${tags[style][0]}${value}${tags[style][1]}`;
    }
    html += value;
    cursor = start + length;
  }
  return html + escapeHtml(text.slice(cursor));
}

export function assertSingleEmoji(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    throw new Error("An 'emoji' is required for an emoji reaction");
  }
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  if (segments.length !== 1
    || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)) {
    throw new Error("'emoji' must be one emoji grapheme cluster");
  }
}
