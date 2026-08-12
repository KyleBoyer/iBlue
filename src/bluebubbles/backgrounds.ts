export const IBLUE_BUILTIN_CONVERSATION_BACKGROUNDS = [
  { identifier: "ocean_1", family: "ocean", name: "Ice", animated: true },
  { identifier: "ocean_2", family: "ocean", name: "Deep Sea", animated: true },
  { identifier: "aurora_1", family: "aurora", name: "Green", animated: true },
  { identifier: "aurora_2", family: "aurora", name: "Purple", animated: true },
  { identifier: "aurora_3", family: "aurora", name: "Magenta", animated: true },
  { identifier: "clouds_1", family: "clouds", name: "Dawn", animated: true },
  { identifier: "clouds_2", family: "clouds", name: "Sunrise", animated: true },
  { identifier: "clouds_3", family: "clouds", name: "Clear", animated: true },
  { identifier: "clouds_4", family: "clouds", name: "Haze", animated: true },
  { identifier: "clouds_5", family: "clouds", name: "Dusk", animated: true },
  { identifier: "clouds_6", family: "clouds", name: "Dark", animated: true },
  { identifier: "glitter", family: "glitter", name: "Glitter", animated: true },
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
