export const IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS = [
  { identifier: "color", family: "color", name: "Color", animated: true, customizable: true },
  { identifier: "ocean_1", family: "water", name: "Light Water", animated: true },
  { identifier: "ocean_2", family: "water", name: "Dark Water", animated: true },
  { identifier: "aurora_1", family: "aurora", name: "Blue", animated: true },
  { identifier: "aurora_2", family: "aurora", name: "Purple", animated: true },
  { identifier: "aurora_3", family: "aurora", name: "Red", animated: true },
  { identifier: "clouds_1", family: "sky", name: "Dawn", animated: true },
  { identifier: "clouds_2", family: "sky", name: "Sunrise", animated: true },
  { identifier: "clouds_3", family: "sky", name: "Clear", animated: true },
  { identifier: "clouds_4", family: "sky", name: "Haze", animated: true },
  { identifier: "clouds_5", family: "sky", name: "Dusk", animated: true },
  { identifier: "clouds_6", family: "sky", name: "Dark", animated: true },
] as const;

export type IBlueBuiltinConversationBackgroundPreset =
  (typeof IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS)[number]["identifier"];

const BUILTIN_PRESET_IDENTIFIERS = new Set<string>(
  IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS.map((background) => background.identifier),
);

export function isBuiltinConversationBackgroundPreset(
  value: string,
): value is IBlueBuiltinConversationBackgroundPreset {
  return BUILTIN_PRESET_IDENTIFIERS.has(value);
}

export function normalizeConversationBackgroundColors(value: unknown): [string, string] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const colors = value.map((color) => {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return undefined;
    return `${color.slice(0, 7).toUpperCase()}${color.length === 7 ? "FF" : color.slice(7).toUpperCase()}`;
  });
  return colors.every((color): color is string => color !== undefined)
    ? colors as [string, string]
    : undefined;
}

export function conversationBackgroundEnginePreset(
  preset: IBlueBuiltinConversationBackgroundPreset,
  colors?: [string, string],
): string {
  if (preset !== "color") return preset;
  if (!colors) throw new Error("A Color background requires exactly two hex colors");
  const custom = colors.map((color) => {
    const components = [1, 3, 5, 7].map((offset) =>
      (Number.parseInt(color.slice(offset, offset + 2), 16) / 255).toFixed(6));
    return components.join("/");
  }).join("//");
  return `color:${custom}`;
}
