import type { SubtitleItem, SubtitleWord } from "../types";

export interface FindReplaceSubtitleOptions {
  findText: string;
  replaceText: string;
  field: "all" | "burmese" | "thaiPhonetic" | "thaiScript";
  caseSensitive?: boolean;
}

export interface RetranslateSubtitlePatch {
  id: string;
  thaiScript: string;
  thaiPhonetic: string;
  burmese: string;
  words: SubtitleWord[];
}

export function applyFindReplaceToSubtitles(
  list: SubtitleItem[],
  opts: FindReplaceSubtitleOptions
): { subtitles: SubtitleItem[]; totalMatches: number } {
  if (!opts.findText) {
    return { subtitles: list, totalMatches: 0 };
  }

  const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = opts.caseSensitive ? "g" : "gi";
  const regex = new RegExp(escapeRegExp(opts.findText), flags);
  let totalMatches = 0;

  const replaceText = (src: string, countMatches: boolean): string => {
    if (!src) return src;
    if (countMatches) {
      const matches = src.match(regex);
      if (matches && matches.length > 0) {
        totalMatches += matches.length;
        return src.replace(regex, opts.replaceText);
      }
      return src;
    }
    return src.replace(regex, opts.replaceText);
  };

  const subtitles = list.map((sub) => {
    const nextPhonetic =
      opts.field === "all" || opts.field === "thaiPhonetic"
        ? replaceText(sub.thaiPhonetic, true)
        : sub.thaiPhonetic;
    const nextThai =
      opts.field === "all" || opts.field === "thaiScript"
        ? replaceText(sub.thaiScript, true)
        : sub.thaiScript;
    const nextBurmese =
      opts.field === "all" || opts.field === "burmese"
        ? replaceText(sub.burmese, true)
        : sub.burmese;

    let wordsChanged = false;
    const nextWords = sub.words.map((w) => {
      const nextWordPhonetic =
        opts.field === "all" || opts.field === "thaiPhonetic"
          ? replaceText(w.phonetic, false)
          : w.phonetic;
      const nextWordGloss =
        (opts.field === "all" || opts.field === "burmese") && w.burmeseGloss
          ? replaceText(w.burmeseGloss, false)
          : w.burmeseGloss;
      if (nextWordPhonetic !== w.phonetic || nextWordGloss !== w.burmeseGloss) {
        wordsChanged = true;
      }
      return {
        ...w,
        phonetic: nextWordPhonetic,
        burmeseGloss: nextWordGloss,
      };
    });

    const rowChanged =
      nextPhonetic !== sub.thaiPhonetic ||
      nextThai !== sub.thaiScript ||
      nextBurmese !== sub.burmese ||
      wordsChanged;

    if (!rowChanged) {
      return sub;
    }

    return {
      ...sub,
      thaiPhonetic: nextPhonetic,
      thaiScript: nextThai,
      burmese: nextBurmese,
      words: nextWords,
      isManuallyEdited: true,
    };
  });

  return { subtitles, totalMatches };
}

export function selectSubtitlesForRetranslation(
  list: SubtitleItem[],
  skipManuallyEdited: boolean
): SubtitleItem[] {
  return skipManuallyEdited ? list.filter((sub) => !sub.isManuallyEdited) : list;
}

export function mergeRetranslatedSubtitles(
  list: SubtitleItem[],
  patches: RetranslateSubtitlePatch[]
): SubtitleItem[] {
  const byId = new Map(patches.map((item) => [item.id, item]));
  return list.map((sub) => {
    const patch = byId.get(sub.id);
    if (!patch || sub.isManuallyEdited) {
      return sub;
    }
    return {
      ...sub,
      thaiScript: patch.thaiScript || sub.thaiScript,
      thaiPhonetic: patch.thaiPhonetic || sub.thaiPhonetic,
      burmese: patch.burmese || sub.burmese,
      words: Array.isArray(patch.words) && patch.words.length > 0 ? patch.words : sub.words,
      isManuallyEdited: false,
    };
  });
}

export type AutoFollowState =
  | "following"
  | "paused_by_scroll"
  | "paused_by_editing"
  | "off";

/**
 * Resolves the next selectedSubtitleId when subtitles change (delete, merge, undo/redo, clip trim).
 * Never alters a still-present selection; when removed, falls back to the adjacent next row,
 * then adjacent previous row, or null if none remain.
 */
export function resolveNextSelectedSubtitleId(
  prevSubs: SubtitleItem[],
  nextSubs: SubtitleItem[],
  currentSelectedId: string | null
): string | null {
  if (!currentSelectedId) return null;
  if (nextSubs.some((sub) => sub.id === currentSelectedId)) {
    return currentSelectedId;
  }
  const oldIdx = prevSubs.findIndex((sub) => sub.id === currentSelectedId);
  if (oldIdx === -1) return null;

  const nextIds = new Set(nextSubs.map((sub) => sub.id));
  for (let i = oldIdx + 1; i < prevSubs.length; i++) {
    if (nextIds.has(prevSubs[i].id)) {
      return prevSubs[i].id;
    }
  }
  for (let i = oldIdx - 1; i >= 0; i--) {
    if (nextIds.has(prevSubs[i].id)) {
      return prevSubs[i].id;
    }
  }
  return null;
}

/**
 * Returns the subtitle strictly spanning timeSec ([startTime, endTime]), or undefined in silent gaps.
 */
export function findExactSubtitleAtTime(
  subtitles: SubtitleItem[],
  timeSec: number
): SubtitleItem | undefined {
  let match: SubtitleItem | undefined;
  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    if (timeSec >= sub.startTime && timeSec <= sub.endTime) {
      match = sub;
    }
  }
  return match;
}

/**
 * Detects a clean pointer click on a Stage9x16 caption card (rejecting drags and long holds).
 */
export function isStageCleanClick(
  dx: number,
  dy: number,
  durationMs: number
): boolean {
  return Math.hypot(dx, dy) <= 6 && durationMs >= 0 && durationMs < 400;
}

const INTERACTIVE_SHORTCUT_BLOCK_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="slider"]',
  '[role="menuitem"]',
  '[role="tab"]',
].join(", ");

interface MinimalElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

function matchesInteractiveBlockElement(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as MinimalElementLike;
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === "function") {
    const ce = el.getAttribute("contenteditable");
    if (ce === "true" || ce === "") return true;
  }
  if (typeof el.closest === "function" && el.closest(INTERACTIVE_SHORTCUT_BLOCK_SELECTOR)) {
    return true;
  }
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") {
    return true;
  }
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return (
    role === "button" ||
    role === "slider" ||
    role === "menuitem" ||
    role === "tab"
  );
}

/**
 * Returns true if single-key global shortcuts (Space, L, S) must be ignored
 * because focus or event target is inside an interactive control.
 */
export function isKeyboardShortcutBlockedByElement(
  target: unknown,
  activeElement: unknown
): boolean {
  return (
    matchesInteractiveBlockElement(target) ||
    matchesInteractiveBlockElement(activeElement)
  );
}

export type SubtitleQualityIssue =
  | "overlap"
  | "too_fast"
  | "silent_mismatch"
  | "missing_gloss";

export interface SubtitleQualityFlags {
  overlap: boolean;
  too_fast: boolean;
  silent_mismatch: boolean;
  missing_gloss: boolean;
  issues: SubtitleQualityIssue[];
  burmeseCps: number;
  phoneticCps: number;
  durationSec: number;
  missingGlossCount: number;
}

export interface SpeechRangeLike {
  cutStart: number;
  cutEnd: number;
}

const burmeseGraphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("my", { granularity: "grapheme" })
    : null;

export function countBurmeseGraphemes(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  if (burmeseGraphemeSegmenter) {
    let count = 0;
    for (const _seg of burmeseGraphemeSegmenter.segment(clean)) {
      count++;
    }
    return count;
  }
  return Array.from(clean).length;
}

/**
 * Computes non-destructive per-subtitle quality flags without mutating input subtitles.
 */
export function computeSubtitleQualityMap(
  subtitles: SubtitleItem[],
  options: {
    cutSpeechRegions?: SpeechRangeLike[];
    showWordGloss?: boolean;
  } = {}
): Record<string, SubtitleQualityFlags> {
  const result: Record<string, SubtitleQualityFlags> = {};
  if (!Array.isArray(subtitles) || subtitles.length === 0) return result;

  const cutSpeechRegions = Array.isArray(options.cutSpeechRegions)
    ? options.cutSpeechRegions
    : [];
  const hasSpeechRegions = cutSpeechRegions.length > 0;
  const showWordGloss = options.showWordGloss !== false;

  const overlapIds = new Set<string>();
  const sorted = [...subtitles].sort(
    (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
  );

  let maxPrevEnd = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (i > 0 && maxPrevEnd > cur.startTime + 0.001) {
      overlapIds.add(cur.id);
    }
    if (cur.endTime > maxPrevEnd) {
      maxPrevEnd = cur.endTime;
    }
  }

  let minNextStart = Infinity;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const cur = sorted[i];
    if (i < sorted.length - 1 && minNextStart < cur.endTime - 0.001) {
      overlapIds.add(cur.id);
    }
    if (cur.startTime < minNextStart) {
      minNextStart = cur.startTime;
    }
  }

  for (const sub of subtitles) {
    const durationSec = Math.max(0, sub.endTime - sub.startTime);
    const safeDur = Math.max(0.01, durationSec);
    const burmeseGraphemes = countBurmeseGraphemes(sub.burmese || "");
    const phoneticChars = (sub.thaiPhonetic || "").trim().length;
    const burmeseCps = burmeseGraphemes / safeDur;
    const phoneticCps = phoneticChars / safeDur;

    const overlap = overlapIds.has(sub.id);
    const too_fast =
      durationSec < 0.5 || burmeseCps > 18 || phoneticCps > 22;
    const silent_mismatch =
      hasSpeechRegions &&
      !cutSpeechRegions.some(
        (sr) =>
          Math.min(sub.endTime, sr.cutEnd) >
          Math.max(sub.startTime, sr.cutStart) + 0.001
      );
    const missingGlossCount = Array.isArray(sub.words)
      ? sub.words.filter((w) => !w.burmeseGloss || !w.burmeseGloss.trim()).length
      : 0;
    const missing_gloss = showWordGloss && missingGlossCount > 0;

    const issues: SubtitleQualityIssue[] = [];
    if (overlap) issues.push("overlap");
    if (too_fast) issues.push("too_fast");
    if (silent_mismatch) issues.push("silent_mismatch");
    if (missing_gloss) issues.push("missing_gloss");

    result[sub.id] = {
      overlap,
      too_fast,
      silent_mismatch,
      missing_gloss,
      issues,
      burmeseCps,
      phoneticCps,
      durationSec,
      missingGlossCount,
    };
  }

  return result;
}

export function updateWordChipInSubtitle(
  sub: SubtitleItem,
  wordIndex: number,
  patch: {
    phonetic?: string;
    thai?: string;
    burmeseGloss?: string;
  }
): SubtitleItem {
  if (!Array.isArray(sub.words) || wordIndex < 0 || wordIndex >= sub.words.length) {
    return sub;
  }
  const nextWords = sub.words.map((w, idx) =>
    idx === wordIndex
      ? {
          ...w,
          ...(patch.phonetic !== undefined ? { phonetic: patch.phonetic } : {}),
          ...(patch.thai !== undefined ? { thai: patch.thai } : {}),
          ...(patch.burmeseGloss !== undefined ? { burmeseGloss: patch.burmeseGloss } : {}),
        }
      : w
  );
  const nextThaiPhonetic =
    patch.phonetic !== undefined
      ? nextWords
          .map((w) => w.phonetic.trim())
          .filter(Boolean)
          .join(" ")
      : sub.thaiPhonetic;

  return {
    ...sub,
    thaiPhonetic: nextThaiPhonetic,
    words: nextWords,
    isManuallyEdited: true,
  };
}

export function mergeWordChipsInSubtitle(
  sub: SubtitleItem,
  leftIndex: number
): SubtitleItem {
  if (
    !Array.isArray(sub.words) ||
    leftIndex < 0 ||
    leftIndex + 1 >= sub.words.length
  ) {
    return sub;
  }
  const w1 = sub.words[leftIndex];
  const w2 = sub.words[leftIndex + 1];
  const p1 = (w1.phonetic || "").trim();
  const p2 = (w2.phonetic || "").trim();
  const joinedPhonetic =
    p1.endsWith("-") && p2 ? `${p1}${p2}` : [p1, p2].filter(Boolean).join(" ");
  const joinedThai = [w1.thai, w2.thai]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("");
  const joinedGloss = [w1.burmeseGloss, w2.burmeseGloss]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ");

  const mergedWord: SubtitleWord = {
    phonetic: joinedPhonetic,
    thai: joinedThai,
    burmeseGloss: joinedGloss,
    startOffsetSec: w1.startOffsetSec,
    endOffsetSec: Math.max(w1.startOffsetSec, w2.endOffsetSec),
  };

  const nextWords = [
    ...sub.words.slice(0, leftIndex),
    mergedWord,
    ...sub.words.slice(leftIndex + 2),
  ];

  return {
    ...sub,
    thaiPhonetic: nextWords
      .map((w) => w.phonetic.trim())
      .filter(Boolean)
      .join(" "),
    words: nextWords,
    isManuallyEdited: true,
  };
}

export function splitWordChipInSubtitle(
  sub: SubtitleItem,
  wordIndex: number,
  partAInput: string,
  partBInput: string,
  partAGloss?: string,
  partBGloss?: string
): SubtitleItem {
  if (!Array.isArray(sub.words) || wordIndex < 0 || wordIndex >= sub.words.length) {
    return sub;
  }
  const partA = partAInput.trim();
  const partB = partBInput.trim();
  if (!partA || !partB) return sub;

  const target = sub.words[wordIndex];
  const lenA = Math.max(1, Array.from(partA).length);
  const lenB = Math.max(1, Array.from(partB).length);
  const ratio = Math.max(0.2, Math.min(0.8, lenA / (lenA + lenB)));

  const start = target.startOffsetSec;
  const end = Math.max(start + 0.04, target.endOffsetSec);
  const splitOffset = Number((start + (end - start) * ratio).toFixed(2));

  const thaiChars = Array.from((target.thai || "").trim());
  let thaiA = "";
  let thaiB = "";
  if (thaiChars.length >= 2) {
    const cut = Math.max(1, Math.min(thaiChars.length - 1, Math.round(thaiChars.length * ratio)));
    thaiA = thaiChars.slice(0, cut).join("");
    thaiB = thaiChars.slice(cut).join("");
  } else {
    thaiA = (target.thai || "").trim() || partA;
    thaiB = "";
  }

  const wordA: SubtitleWord = {
    phonetic: partA,
    thai: thaiA,
    burmeseGloss: partAGloss !== undefined ? partAGloss : (target.burmeseGloss || ""),
    startOffsetSec: start,
    endOffsetSec: splitOffset,
  };
  const wordB: SubtitleWord = {
    phonetic: partB,
    thai: thaiB,
    burmeseGloss: partBGloss !== undefined ? partBGloss : "",
    startOffsetSec: splitOffset,
    endOffsetSec: end,
  };

  const nextWords = [
    ...sub.words.slice(0, wordIndex),
    wordA,
    wordB,
    ...sub.words.slice(wordIndex + 1),
  ];

  return {
    ...sub,
    thaiPhonetic: nextWords
      .map((w) => w.phonetic.trim())
      .filter(Boolean)
      .join(" "),
    words: nextWords,
    isManuallyEdited: true,
  };
}

export function clampAndSnapVideoHeightPct(
  rawPct: number,
  snapThreshold = 1.0
): { pct: number; snapped: boolean } {
  const clamped = Math.max(26, Math.min(52, Number.isFinite(rawPct) ? rawPct : 35));
  if (Math.abs(clamped - 35) <= snapThreshold) {
    return { pct: 35, snapped: true };
  }
  return { pct: Math.round(clamped), snapped: false };
}

export interface UnmatchedSpeechGap {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/**
 * Finds cut-timeline speech intervals from `cutSpeechRegions` that are not covered
 * by any existing subtitle (filtering tiny <0.45s edge artifacts and merging close fragments).
 */
export function findUnmatchedSpeechGaps(
  subtitles: SubtitleItem[],
  cutSpeechRegions: SpeechRangeLike[],
  totalDurationSec?: number
): UnmatchedSpeechGap[] {
  if (!Array.isArray(cutSpeechRegions) || cutSpeechRegions.length === 0) {
    return [];
  }

  const maxDur =
    typeof totalDurationSec === "number" && Number.isFinite(totalDurationSec) && totalDurationSec > 0
      ? totalDurationSec
      : Infinity;

  const covered = (Array.isArray(subtitles) ? subtitles : [])
    .map((sub) => ({
      start: Math.max(0, sub.startTime - 0.08),
      end: Math.min(maxDur, sub.endTime + 0.08),
    }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const mergedCovered: { start: number; end: number }[] = [];
  for (const iv of covered) {
    const prev = mergedCovered[mergedCovered.length - 1];
    if (prev && iv.start <= prev.end + 0.02) {
      if (iv.end > prev.end) prev.end = iv.end;
    } else {
      mergedCovered.push({ ...iv });
    }
  }

  const rawUncovered: { startSec: number; endSec: number }[] = [];
  for (const sr of cutSpeechRegions) {
    const srStart = Math.max(0, Math.min(maxDur, sr.cutStart));
    const srEnd = Math.max(srStart, Math.min(maxDur, sr.cutEnd));
    if (srEnd - srStart < 0.35) continue;

    let cursor = srStart;
    for (const cov of mergedCovered) {
      if (cov.end <= cursor) continue;
      if (cov.start >= srEnd) break;
      if (cov.start > cursor) {
        const pieceEnd = Math.min(srEnd, cov.start);
        if (pieceEnd - cursor >= 0.35) {
          rawUncovered.push({ startSec: cursor, endSec: pieceEnd });
        }
      }
      if (cov.end > cursor) {
        cursor = Math.min(srEnd, cov.end);
      }
      if (cursor >= srEnd) break;
    }
    if (srEnd - cursor >= 0.35) {
      rawUncovered.push({ startSec: cursor, endSec: srEnd });
    }
  }

  if (rawUncovered.length === 0) return [];
  rawUncovered.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const coalesced: { startSec: number; endSec: number }[] = [];
  for (const seg of rawUncovered) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && seg.startSec - prev.endSec <= 0.35) {
      const blockedBySub = mergedCovered.some(
        (c) => c.end > prev.endSec + 0.05 && c.start < seg.startSec - 0.05
      );
      if (!blockedBySub) {
        prev.endSec = Math.max(prev.endSec, seg.endSec);
        continue;
      }
    }
    coalesced.push({ ...seg });
  }

  return coalesced
    .map((g) => {
      const startSec = Number(g.startSec.toFixed(2));
      const endSec = Number(g.endSec.toFixed(2));
      return {
        startSec,
        endSec,
        durationSec: Number((endSec - startSec).toFixed(2)),
      };
    })
    .filter((g) => g.durationSec >= 0.45);
}

/**
 * Picks a sensible default [startSec, endSec] range for AI range transcription:
 * prefers an unmatched speech gap around `cutTime`, otherwise the gap between
 * adjacent subtitles bracketing `cutTime`, otherwise a compact playhead window.
 */
export function suggestTranscribeRange(
  subtitles: SubtitleItem[],
  cutSpeechRegions: SpeechRangeLike[],
  cutTime: number,
  totalDurationSec: number
): { startSec: number; endSec: number; reason: "speech_gap" | "subtitle_gap" | "playhead" } {
  const maxDur = Math.max(0.5, Number.isFinite(totalDurationSec) ? totalDurationSec : 10);
  const safeCut = Math.max(0, Math.min(maxDur, Number.isFinite(cutTime) ? cutTime : 0));
  const gaps = findUnmatchedSpeechGaps(subtitles, cutSpeechRegions, maxDur);

  const gapNearPlayhead = gaps.find(
    (g) => safeCut >= g.startSec - 0.35 && safeCut <= g.endSec + 0.35
  );
  if (gapNearPlayhead) {
    return {
      startSec: gapNearPlayhead.startSec,
      endSec: gapNearPlayhead.endSec,
      reason: "speech_gap",
    };
  }

  const sorted = [...(Array.isArray(subtitles) ? subtitles : [])].sort(
    (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
  );
  const insideSub = sorted.find((s) => safeCut >= s.startTime && safeCut <= s.endTime);

  if (!insideSub) {
    let prevEnd = 0;
    let nextStart = maxDur;
    for (const s of sorted) {
      if (s.endTime <= safeCut + 0.05) {
        prevEnd = Math.max(prevEnd, s.endTime);
      } else if (s.startTime >= safeCut - 0.05) {
        nextStart = Math.min(nextStart, s.startTime);
        break;
      }
    }
    if (nextStart - prevEnd >= 0.45) {
      if (nextStart - prevEnd <= 12) {
        return {
          startSec: Number(prevEnd.toFixed(1)),
          endSec: Number(nextStart.toFixed(1)),
          reason: "subtitle_gap",
        };
      }
      const start = Math.max(prevEnd, safeCut - 0.5);
      const end = Math.min(nextStart, start + 5.0);
      return {
        startSec: Number(start.toFixed(1)),
        endSec: Number(Math.max(start + 0.5, end).toFixed(1)),
        reason: "subtitle_gap",
      };
    }
  } else {
    const idx = sorted.indexOf(insideSub);
    const nextSub = idx + 1 < sorted.length ? sorted[idx + 1] : null;
    const afterStart = insideSub.endTime;
    const afterEnd = nextSub ? nextSub.startTime : maxDur;
    if (afterEnd - afterStart >= 0.45) {
      return {
        startSec: Number(afterStart.toFixed(1)),
        endSec: Number(Math.min(afterEnd, afterStart + 8.0).toFixed(1)),
        reason: "subtitle_gap",
      };
    }
  }

  if (gaps.length > 0) {
    let closest = gaps[0];
    let bestDist = Infinity;
    for (const g of gaps) {
      const mid = (g.startSec + g.endSec) / 2;
      const dist = Math.abs(mid - safeCut);
      if (dist < bestDist) {
        bestDist = dist;
        closest = g;
      }
    }
    return {
      startSec: closest.startSec,
      endSec: closest.endSec,
      reason: "speech_gap",
    };
  }

  const start = Math.min(maxDur - 0.5, safeCut);
  const end = Math.min(maxDur, Math.max(start + 0.5, start + 2.5));
  return {
    startSec: Number(start.toFixed(1)),
    endSec: Number(end.toFixed(1)),
    reason: "playhead",
  };
}

export function buildWordsFromPhonetic(
  phonetic: string,
  spanStart: number,
  spanEnd: number,
  existingWords: SubtitleWord[] = []
): SubtitleWord[] {
  const tokens = phonetic.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const safeStart = Number.isFinite(spanStart) ? Math.max(0, spanStart) : 0;
  const safeEnd = Number.isFinite(spanEnd) ? Math.max(safeStart + 0.2, spanEnd) : safeStart + 0.2;
  const spanDur = Math.max(0.2, safeEnd - safeStart);
  const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0) || 1;
  let cursor = safeStart;
  return tokens.map((tok, wi) => {
    const existing = existingWords[wi];
    const wDur = (Math.max(2, tok.length) / totalWeight) * spanDur;
    const startOffsetSec = Number(cursor.toFixed(2));
    const endOffsetSec = Number(
      (wi === tokens.length - 1 ? safeEnd : cursor + wDur).toFixed(2)
    );
    cursor = endOffsetSec;
    return {
      phonetic: tok,
      thai: existing?.thai || tok,
      burmeseGloss: existing?.burmeseGloss || "",
      startOffsetSec,
      endOffsetSec,
    };
  });
}



