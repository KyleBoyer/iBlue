import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";

import type {
  BlueBubblesAutoAnswerMode,
  BlueBubblesAutoAnswerRule,
} from "./contracts.js";
import type { BlueBubblesStore } from "./store.js";

export interface AutoAnswerRuleDraft {
  name?: string | null;
  enabled?: boolean;
  callers: readonly string[];
  mode: BlueBubblesAutoAnswerMode;
  priority?: number;
  displayName: string;
  maxDurationSeconds: number;
}

export interface AutoAnswerRuleMediaInput {
  filename: string;
  mimeType: string;
  size: number;
  /** Absolute path to media already written beneath {@link mediaRoot}. */
  path: string;
}

export interface AutoAnswerMatchInput {
  mode: "audio" | "video";
  /** Caller plus participants, already normalized. */
  addresses: readonly string[];
}

/**
 * Standing auto-answer rules: which media to play for an incoming FaceTime
 * call, chosen by caller and by whether the call is audio or video.
 *
 * This is the durable, many-rule counterpart to the one-shot arm. The one-shot
 * arm stays authoritative when both could match, because it is an explicit
 * request for the very next call.
 */
export class FaceTimeAutoAnswerRules {
  readonly store: BlueBubblesStore;
  readonly mediaRoot: string;

  constructor(options: { store: BlueBubblesStore; mediaRoot: string }) {
    this.store = options.store;
    this.mediaRoot = options.mediaRoot;
  }

  list(): BlueBubblesAutoAnswerRule[] {
    return this.store.listAutoAnswerRules();
  }

  get(id: number): BlueBubblesAutoAnswerRule | undefined {
    return this.store.getAutoAnswerRule(id);
  }

  /** Directory a caller should write media into before {@link create}. */
  async prepareMediaDirectory(token: string): Promise<string> {
    const directory = join(this.mediaRoot, token);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  create(
    draft: AutoAnswerRuleDraft,
    media: AutoAnswerRuleMediaInput,
  ): BlueBubblesAutoAnswerRule {
    return this.store.createAutoAnswerRule({
      name: draft.name ?? null,
      ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
      callers: draft.callers,
      mode: draft.mode,
      ...(draft.priority === undefined ? {} : { priority: draft.priority }),
      displayName: draft.displayName,
      maxDurationSeconds: draft.maxDurationSeconds,
      mediaPath: media.path,
      mediaFilename: media.filename,
      mediaMime: media.mimeType,
      mediaSize: media.size,
    });
  }

  async update(
    id: number,
    changes: Partial<AutoAnswerRuleDraft>,
    media?: AutoAnswerRuleMediaInput,
  ): Promise<BlueBubblesAutoAnswerRule | undefined> {
    const previousMediaPath = media ? this.store.autoAnswerRuleMediaPath(id) : undefined;
    // Drop absent keys rather than writing undefined, so a partial update never
    // silently clears a field the caller did not mention.
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    ) as Partial<AutoAnswerRuleDraft>;
    const updated = this.store.updateAutoAnswerRule(id, {
      ...defined,
      ...(media
        ? {
            mediaPath: media.path,
            mediaFilename: media.filename,
            mediaMime: media.mimeType,
            mediaSize: media.size,
          }
        : {}),
    });
    // Only discard the old media once the row committed, so a failed update
    // cannot leave a rule pointing at a file that no longer exists.
    if (updated && previousMediaPath && previousMediaPath !== media?.path) {
      await this.#removeMediaDirectory(previousMediaPath);
    }
    return updated;
  }

  async delete(id: number): Promise<BlueBubblesAutoAnswerRule | undefined> {
    const mediaPath = this.store.autoAnswerRuleMediaPath(id);
    const removed = this.store.deleteAutoAnswerRule(id);
    if (removed && mediaPath) await this.#removeMediaDirectory(mediaPath);
    return removed;
  }

  recordAnswered(id: number): void {
    this.store.recordAutoAnswerRuleAnswered(id);
  }

  mediaPath(id: number): string | undefined {
    return this.store.autoAnswerRuleMediaPath(id);
  }

  /**
   * The rule that should answer a ringing call, or undefined for none.
   *
   * Ordering is by explicit priority first, then by specificity so a rule
   * naming this caller wins over a catch-all at the same priority, then by id
   * so the result is stable rather than dependent on insertion order.
   */
  match(input: AutoAnswerMatchInput): BlueBubblesAutoAnswerRule | undefined {
    const addresses = new Set(input.addresses);
    const candidates = this.list().filter((rule) => {
      if (!rule.enabled) return false;
      if (rule.mode !== "any" && rule.mode !== input.mode) return false;
      if (rule.callers.length === 0) return true;
      return rule.callers.some((caller) => addresses.has(caller));
    });
    candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const leftSpecific = left.callers.length > 0 ? 0 : 1;
      const rightSpecific = right.callers.length > 0 ? 0 : 1;
      if (leftSpecific !== rightSpecific) return leftSpecific - rightSpecific;
      return left.id - right.id;
    });
    return candidates[0];
  }

  async #removeMediaDirectory(mediaPath: string): Promise<void> {
    // Media lives one directory deep under mediaRoot; refuse anything that did
    // not come from there so a corrupted row cannot delete outside the profile.
    // Resolve both sides and compare with relative() rather than string
    // prefixes: Windows separates with a backslash, so a hardcoded "/" matched
    // nothing there and every removal was silently skipped.
    const root = resolve(this.mediaRoot);
    const relative = relativePath(root, resolve(mediaPath));
    if (relative === "" || relative.startsWith("..") || isAbsolute(relative)) return;
    const [token] = relative.split(sep);
    if (!token || token === "." || token === "..") return;
    await rm(join(root, token), { recursive: true, force: true });
  }
}
