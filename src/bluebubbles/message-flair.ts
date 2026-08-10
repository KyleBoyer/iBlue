import type { IBlueMessageFlair } from "./contracts.js";

type KnownMessageFlair = Omit<IBlueMessageFlair, "known"> & { known: true };

// Apple places screen-effect implementations in
// /System/Library/Messages/iMessageEffects and carries the selected bundle ID
// as expressiveSendStyleId. Bubble effects use the older MobileSMS namespace.
// Keep these wire identifiers explicit: clients can use the friendly name,
// while received identifiers that iBlue does not know yet are still retained.
export const MESSAGE_FLAIRS: readonly KnownMessageFlair[] = [
  {
    name: "slam",
    displayName: "Slam",
    category: "bubble",
    effectId: "com.apple.MobileSMS.expressivesend.impact",
    known: true,
  },
  {
    name: "loud",
    displayName: "Loud",
    category: "bubble",
    effectId: "com.apple.MobileSMS.expressivesend.loud",
    known: true,
  },
  {
    name: "gentle",
    displayName: "Gentle",
    category: "bubble",
    effectId: "com.apple.MobileSMS.expressivesend.gentle",
    known: true,
  },
  {
    name: "invisible-ink",
    displayName: "Invisible Ink",
    category: "bubble",
    effectId: "com.apple.MobileSMS.expressivesend.invisibleink",
    known: true,
  },
  {
    name: "echo",
    displayName: "Echo",
    category: "screen",
    effectId: "com.apple.messages.effect.CKEchoEffect",
    known: true,
  },
  {
    name: "spotlight",
    displayName: "Spotlight",
    category: "screen",
    effectId: "com.apple.messages.effect.CKSpotlightEffect",
    known: true,
  },
  {
    name: "balloons",
    displayName: "Balloons",
    category: "screen",
    effectId: "com.apple.messages.effect.CKHappyBirthdayEffect",
    known: true,
  },
  {
    name: "confetti",
    displayName: "Confetti",
    category: "screen",
    effectId: "com.apple.messages.effect.CKConfettiEffect",
    known: true,
  },
  {
    name: "love",
    displayName: "Love",
    category: "screen",
    effectId: "com.apple.messages.effect.CKHeartEffect",
    known: true,
  },
  {
    name: "lasers",
    displayName: "Lasers",
    category: "screen",
    effectId: "com.apple.messages.effect.CKLasersEffect",
    known: true,
  },
  {
    name: "fireworks",
    displayName: "Fireworks",
    category: "screen",
    effectId: "com.apple.messages.effect.CKFireworksEffect",
    known: true,
  },
  {
    name: "shooting-star",
    displayName: "Shooting Star",
    category: "screen",
    effectId: "com.apple.messages.effect.CKShootingStarEffect",
    known: true,
  },
  {
    name: "celebration",
    displayName: "Celebration",
    category: "screen",
    effectId: "com.apple.messages.effect.CKSparklesEffect",
    known: true,
  },
] as const;

const byEffectId = new Map(MESSAGE_FLAIRS.map((flair) => [flair.effectId, flair]));

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const aliases = new Map<string, KnownMessageFlair>();
for (const flair of MESSAGE_FLAIRS) {
  aliases.set(normalizedName(flair.name), flair);
  aliases.set(normalizedName(flair.displayName), flair);
}
for (const [alias, name] of [
  ["impact", "slam"],
  ["birthday", "balloons"],
  ["happybirthday", "balloons"],
  ["heart", "love"],
  ["sparkles", "celebration"],
] as const) {
  aliases.set(alias, MESSAGE_FLAIRS.find((flair) => flair.name === name)!);
}

export function messageFlairFromEffectId(effectId: string | undefined | null): IBlueMessageFlair | undefined {
  const value = effectId?.trim();
  if (!value) return undefined;
  const known = byEffectId.get(value);
  if (known) return { ...known };
  return {
    name: "unknown",
    displayName: "Unknown",
    category: "unknown",
    effectId: value,
    known: false,
  };
}

/** Resolve a friendly flair name or an explicit Apple effect identifier. */
export function effectIdForMessageFlair(flair: string | undefined | null): string | undefined {
  const value = flair?.trim();
  if (!value) return undefined;
  const known = byEffectId.get(value) ?? aliases.get(normalizedName(value));
  if (known) return known.effectId;
  // Raw identifiers remain an escape hatch for effects introduced by Apple
  // before iBlue's friendly catalog is updated.
  return value.startsWith("com.apple.") ? value : undefined;
}
