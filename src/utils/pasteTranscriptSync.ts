import type {
  SceneSelection,
  SpeakingScene,
  SubtitleItem,
  SubtitleSourceSegment,
  SubtitleWord,
} from "../types";
import {
  buildContiguousClipBlocks,
  getSceneDurationSec,
  mapCutRangeToSourceMetadata,
} from "./projectTimeline";
import { buildWordsFromPhonetic } from "./subtitleState";

export interface ParsedTranscriptWord {
  phonetic: string;
  thai?: string;
  burmeseGloss?: string;
  hasGlossParen: boolean;
}

export interface ParsedTranscriptEntry {
  index: number | null;
  startSec?: number;
  endSec?: number;
  rawHeader?: string;
  thaiPhonetic?: string;
  thaiScript?: string;
  burmese?: string;
  words?: ParsedTranscriptWord[];
  rawText?: string;
}

export type ParsedTranscriptMode =
  | "structured"
  | "numbered_lines"
  | "plain_lines"
  | "empty";

export interface ParsedTranscriptResult {
  mode: ParsedTranscriptMode;
  entries: ParsedTranscriptEntry[];
  warnings: string[];
}

export type SyncChangedField = "thaiPhonetic" | "thaiScript" | "burmese" | "words";

export interface TranscriptSyncRowPreview {
  subtitleId: string;
  lineNumber: number;
  startTime: number;
  endTime: number;
  matched: boolean;
  changed: boolean;
  changedFields: SyncChangedField[];
  before: SubtitleItem;
  after: SubtitleItem;
  matchedEntry?: ParsedTranscriptEntry;
}

export interface TranscriptSyncPreview {
  parsed: ParsedTranscriptResult;
  matchedCount: number;
  changedCount: number;
  unchangedCount: number;
  countMismatch: boolean;
  unmatchedEntries: ParsedTranscriptEntry[];
  warnings: string[];
  rows: TranscriptSyncRowPreview[];
  nextSubtitles: SubtitleItem[];
}

const MYANMAR_CHAR_RE = /[\u1000-\u109F\uAA60-\uAA7F]/;
const THAI_CHAR_RE = /[\u0E00-\u0E7F]/;
const LATIN_CHAR_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

const TIMESTAMP_TOKEN = "(\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?)";
const TIMESTAMP_SEP = "(?:[–—\\-→]+|-->|->|to)";

const TIMESTAMP_RANGE_RE = new RegExp(
  `^${TIMESTAMP_TOKEN}\\s*${TIMESTAMP_SEP}\\s*${TIMESTAMP_TOKEN}(?:\\s+(.*))?$`,
  "i"
);

const WRAPPED_TIMESTAMP_RANGE_RE = new RegExp(
  `^[\\[(]\\s*${TIMESTAMP_TOKEN}\\s*${TIMESTAMP_SEP}\\s*${TIMESTAMP_TOKEN}\\s*[\\])](?:\\s+(.*))?$`,
  "i"
);

const STRUCTURED_HEADER_BRACKET_RE =
  /^(?:[-*•]\s*|\#{1,4}\s*|\*{1,2})*\[(\d{1,4})\](?:\*{1,2})?(?:\s+(.*))?$/;

const NUMBERED_TIMESTAMP_HEADER_RE = new RegExp(
  `^(?:[-*•]\\s*|\\#{1,4}\\s*|\\*{1,2})*(\\d{1,4})[.)]\\s+(${TIMESTAMP_TOKEN}\\s*${TIMESTAMP_SEP}\\s*${TIMESTAMP_TOKEN})(?:\\s+(.*))?$`,
  "i"
);

const BARE_NUMBERED_HEADER_RE = /^(?:[-*•]\s*|\#{1,4}\s*|\*{1,2})*(\d{1,4})[.)]\s*$/;

const SINGLE_LINE_NUMBERED_RE =
  /^(?:[-*•]\s*|\*{1,2})*(?:\[(\d{1,4})\]|(\d{1,4})[.)])(?:\*{1,2})?\s+(.+)$/;

const FIELD_LABEL_RE =
  /^(?:[-*•]\s*|\*{1,2})*(thai\s*phonetic|phonetic|pronunciation|romanized|thai\s*script|thai|burmese|myanmar|translation|words?|vocab|word\s*gloss|gloss)(?:\*{1,2})?\s*:\s*(.*)$/i;

function stripWrappingCodeFences(raw: string): string {
  const trimmed = raw.replace(/\r\n?/g, "\n").trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function splitOutsideParens(input: string, separators: Set<string>): string[] {
  const parts: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(" || ch === "（") parenDepth++;
    else if ((ch === ")" || ch === "）") && parenDepth > 0) parenDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]" && bracketDepth > 0) bracketDepth--;

    if (parenDepth === 0 && bracketDepth === 0 && separators.has(ch)) {
      const piece = current.trim();
      if (piece) parts.push(piece);
      current = "";
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

export function parseWordsLine(rawWords: string): ParsedTranscriptWord[] {
  const cleaned = rawWords.trim();
  if (!cleaned) return [];

  let segments = splitOutsideParens(cleaned, new Set(["·", "•", "|"]));
  if (segments.length <= 1) {
    const altSegments = splitOutsideParens(cleaned, new Set([";", ","]));
    if (altSegments.length > 1) {
      segments = altSegments;
    }
  }

  const words: ParsedTranscriptWord[] = [];
  for (const seg of segments) {
    let remaining = seg.trim();
    if (!remaining) continue;

    let burmeseGloss: string | undefined;
    let hasGlossParen = false;
    let thai: string | undefined;

    // Handle optional double-parenthesis form: phonetic (thai) (burmese)
    const doubleParen = remaining.match(
      /^(.*?)\s*[（(]([^()（）]*)[)）]\s*[（(]([^()（）]*)[)）]\s*$/
    );
    if (doubleParen) {
      remaining = doubleParen[1].trim();
      const p1 = doubleParen[2].trim();
      const p2 = doubleParen[3].trim();
      if (THAI_CHAR_RE.test(p1) && !THAI_CHAR_RE.test(p2)) {
        thai = p1;
        burmeseGloss = p2;
      } else {
        burmeseGloss = p2 || p1;
      }
      hasGlossParen = true;
    } else {
      const singleParen = remaining.match(/^(.*?)\s*[（(]([^()（）]*)[)）]\s*$/);
      if (singleParen) {
        remaining = singleParen[1].trim();
        burmeseGloss = singleParen[2].trim();
        hasGlossParen = true;
      }
    }

    // Handle optional [thai] script tag
    const bracketThai = remaining.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    if (bracketThai) {
      const maybeThai = bracketThai[2].trim();
      if (maybeThai) {
        thai = maybeThai;
        remaining = bracketThai[1].trim();
      }
    }

    const phonetic = remaining.replace(/^[`"'*]+|[`"'*]+$/g, "").trim();
    if (!phonetic && !thai && !burmeseGloss) continue;

    words.push({
      phonetic: phonetic || thai || "",
      ...(thai ? { thai } : {}),
      ...(hasGlossParen ? { burmeseGloss: burmeseGloss ?? "" } : {}),
      hasGlossParen,
    });
  }

  return words;
}

function classifySingleLinePayload(
  payload: string
): Pick<ParsedTranscriptEntry, "thaiPhonetic" | "thaiScript" | "burmese"> {
  const trimmed = payload.trim();
  if (!trimmed) return {};

  // Check pipe or tab delimited multi-field single-line format
  const delimiter = trimmed.includes("|") ? "|" : trimmed.includes("\t") ? "\t" : null;
  if (delimiter) {
    const parts = trimmed
      .split(delimiter)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      let thaiPhonetic: string | undefined;
      let thaiScript: string | undefined;
      let burmese: string | undefined;
      const unassigned: string[] = [];

      for (const part of parts) {
        const hasMy = MYANMAR_CHAR_RE.test(part);
        const hasTh = THAI_CHAR_RE.test(part);
        const hasLat = LATIN_CHAR_RE.test(part);

        if (hasMy && !hasTh && !hasLat && !burmese) {
          burmese = part;
        } else if (hasTh && !hasMy && !hasLat && !thaiScript) {
          thaiScript = part;
        } else if (hasLat && !hasMy && !hasTh && !thaiPhonetic) {
          thaiPhonetic = part;
        } else {
          unassigned.push(part);
        }
      }

      for (const part of unassigned) {
        if (!thaiPhonetic) thaiPhonetic = part;
        else if (!burmese) burmese = part;
        else if (!thaiScript) thaiScript = part;
      }

      return {
        ...(thaiPhonetic ? { thaiPhonetic } : {}),
        ...(thaiScript ? { thaiScript } : {}),
        ...(burmese ? { burmese } : {}),
      };
    }
  }

  // Single un-delimited value: route by script
  if (MYANMAR_CHAR_RE.test(trimmed)) {
    return { burmese: trimmed };
  }
  if (THAI_CHAR_RE.test(trimmed) && !LATIN_CHAR_RE.test(trimmed)) {
    return { thaiScript: trimmed };
  }
  return { thaiPhonetic: trimmed };
}

export function parseFlexibleTimestampSec(raw: string): number | null {
  const cleaned = raw.trim();
  const hms = cleaned.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const min = Number(hms[2]);
    const s = Number(hms[3]);
    const ms = hms[4] ? Number(hms[4].padEnd(3, "0")) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(s)) return null;
    return Number((h * 3600 + min * 60 + s + ms / 1000).toFixed(3));
  }
  const msShort = cleaned.match(/^(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (msShort) {
    const min = Number(msShort[1]);
    const s = Number(msShort[2]);
    const ms = msShort[3] ? Number(msShort[3].padEnd(3, "0")) : 0;
    if (!Number.isFinite(min) || !Number.isFinite(s)) return null;
    return Number((min * 60 + s + ms / 1000).toFixed(3));
  }
  return null;
}

function stripLeadingTimestamp(text: string): {
  hadTimestamp: boolean;
  startSec?: number;
  endSec?: number;
  rest: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return { hadTimestamp: false, rest: "" };
  const tsMatch = trimmed.match(WRAPPED_TIMESTAMP_RANGE_RE) ?? trimmed.match(TIMESTAMP_RANGE_RE);
  if (tsMatch) {
    const startSec = parseFlexibleTimestampSec(tsMatch[1] || "");
    const endSec = parseFlexibleTimestampSec(tsMatch[2] || "");
    return {
      hadTimestamp: true,
      ...(startSec !== null ? { startSec } : {}),
      ...(endSec !== null ? { endSec } : {}),
      rest: (tsMatch[3] || "").trim(),
    };
  }
  return { hadTimestamp: false, rest: trimmed };
}

function normalizeFieldKey(rawKey: string): "phonetic" | "thai" | "burmese" | "words" | null {
  const k = rawKey.toLowerCase().replace(/\s+/g, " ").trim();
  if (k === "phonetic" || k === "thai phonetic" || k === "pronunciation" || k === "romanized") {
    return "phonetic";
  }
  if (k === "thai" || k === "thai script") {
    return "thai";
  }
  if (k === "burmese" || k === "myanmar" || k === "translation") {
    return "burmese";
  }
  if (k === "words" || k === "word" || k === "vocab" || k === "gloss" || k === "word gloss") {
    return "words";
  }
  return null;
}

export function parsePastedTranscript(rawInput: string): ParsedTranscriptResult {
  const cleaned = stripWrappingCodeFences(rawInput || "");
  if (!cleaned) {
    return { mode: "empty", entries: [], warnings: [] };
  }

  const lines = cleaned.split("\n");
  const warnings: string[] = [];

  const hasFieldLabel = lines.some((line) => FIELD_LABEL_RE.test(line.trim()));
  const hasTimestampBlockHeader = lines.some((line) => {
    const t = line.trim();
    if (NUMBERED_TIMESTAMP_HEADER_RE.test(t)) return true;
    if (stripLeadingTimestamp(t).hadTimestamp) return true;
    const bm = t.match(STRUCTURED_HEADER_BRACKET_RE);
    if (!bm) return false;
    return stripLeadingTimestamp(bm[2] || "").hadTimestamp || !(bm[2] || "").trim();
  });

  // 1. Structured multi-line or timestamped block mode
  if (hasFieldLabel || hasTimestampBlockHeader) {
    const entries: ParsedTranscriptEntry[] = [];
    let current: (ParsedTranscriptEntry & {
      hasExplicitFields: boolean;
      unlabeledLines: string[];
      sawBlankLineAfterContent?: boolean;
      lastField?: "phonetic" | "thai" | "burmese" | "words";
    }) | null = null;
    let pendingCueIndex: number | null = null;

    const mergeInlineText = (
      target: ParsedTranscriptEntry,
      payload: string
    ) => {
      const classified = classifySingleLinePayload(payload);
      if (classified.thaiPhonetic) {
        target.thaiPhonetic = target.thaiPhonetic
          ? `${target.thaiPhonetic} ${classified.thaiPhonetic}`
          : classified.thaiPhonetic;
      }
      if (classified.thaiScript) {
        target.thaiScript = target.thaiScript
          ? `${target.thaiScript} ${classified.thaiScript}`
          : classified.thaiScript;
      }
      if (classified.burmese) {
        target.burmese = target.burmese
          ? `${target.burmese} ${classified.burmese}`
          : classified.burmese;
      }
    };

    const finalizeCurrent = () => {
      if (!current) return;
      if (!current.hasExplicitFields && current.unlabeledLines.length > 0) {
        for (const line of current.unlabeledLines) {
          mergeInlineText(current, line);
        }
      }
      if (
        current.thaiPhonetic !== undefined ||
        current.thaiScript !== undefined ||
        current.burmese !== undefined ||
        (current.words && current.words.length > 0)
      ) {
        entries.push({
          index: current.index,
          ...(current.startSec !== undefined ? { startSec: current.startSec } : {}),
          ...(current.endSec !== undefined ? { endSec: current.endSec } : {}),
          rawHeader: current.rawHeader,
          ...(current.thaiPhonetic !== undefined ? { thaiPhonetic: current.thaiPhonetic } : {}),
          ...(current.thaiScript !== undefined ? { thaiScript: current.thaiScript } : {}),
          ...(current.burmese !== undefined ? { burmese: current.burmese } : {}),
          ...(current.words !== undefined ? { words: current.words } : {}),
          rawText: current.rawText,
        });
      }
      current = null;
    };

    for (let li = 0; li < lines.length; li++) {
      const trimmed = lines[li].trim();

      if (!trimmed) {
        pendingCueIndex = null;
        if (current) {
          current.sawBlankLineAfterContent = true;
        }
        continue;
      }

      if (/^={3,}$|^-{3,}$/.test(trimmed)) {
        pendingCueIndex = null;
        continue;
      }

      if (!current && entries.length === 0 && /^(?:WEBVTT(?:\s.*)?|NOTE(?:\s.*)?)$/i.test(trimmed)) {
        pendingCueIndex = null;
        continue;
      }

      // Skip SRT/VTT bare numeric cue index line immediately preceding a timestamp line
      if (/^\d{1,4}$/.test(trimmed)) {
        const nextLine = lines[li + 1]?.trim() ?? "";
        if (stripLeadingTimestamp(nextLine).hadTimestamp) {
          const parsedCueIdx = parseInt(trimmed, 10);
          pendingCueIndex = Number.isFinite(parsedCueIdx) ? parsedCueIdx : null;
          continue;
        }
      }

      // Check block header: [01] MM:SS – MM:SS
      const bracketMatch = trimmed.match(STRUCTURED_HEADER_BRACKET_RE);
      if (bracketMatch) {
        const idx = parseInt(bracketMatch[1], 10);
        const afterBracket = (bracketMatch[2] || "").trim();
        const tsInfo = stripLeadingTimestamp(afterBracket);

        finalizeCurrent();
        pendingCueIndex = null;
        current = {
          index: Number.isFinite(idx) ? idx : null,
          ...(tsInfo.startSec !== undefined ? { startSec: tsInfo.startSec } : {}),
          ...(tsInfo.endSec !== undefined ? { endSec: tsInfo.endSec } : {}),
          rawHeader: trimmed,
          hasExplicitFields: false,
          unlabeledLines: tsInfo.rest ? [tsInfo.rest] : [],
          rawText: trimmed,
        };
        continue;
      }

      // Check 01. MM:SS – MM:SS header
      const numTsMatch = trimmed.match(NUMBERED_TIMESTAMP_HEADER_RE);
      if (numTsMatch) {
        const idx = parseInt(numTsMatch[1], 10);
        const tsStart = parseFlexibleTimestampSec(numTsMatch[3] || "");
        const tsEnd = parseFlexibleTimestampSec(numTsMatch[4] || "");
        finalizeCurrent();
        pendingCueIndex = null;
        const inlineRest = (numTsMatch[5] || "").trim();
        current = {
          index: Number.isFinite(idx) ? idx : null,
          ...(tsStart !== null ? { startSec: tsStart } : {}),
          ...(tsEnd !== null ? { endSec: tsEnd } : {}),
          rawHeader: trimmed,
          hasExplicitFields: false,
          unlabeledLines: inlineRest ? [inlineRest] : [],
          rawText: trimmed,
        };
        continue;
      }

      // Check standalone MM:SS – MM:SS, [MM:SS – MM:SS], or SRT/VTT cue timestamp header
      const bareTs = stripLeadingTimestamp(trimmed);
      if (bareTs.hadTimestamp) {
        finalizeCurrent();
        current = {
          index: pendingCueIndex,
          ...(bareTs.startSec !== undefined ? { startSec: bareTs.startSec } : {}),
          ...(bareTs.endSec !== undefined ? { endSec: bareTs.endSec } : {}),
          rawHeader: trimmed,
          hasExplicitFields: false,
          unlabeledLines: bareTs.rest ? [bareTs.rest] : [],
          rawText: trimmed,
        };
        pendingCueIndex = null;
        continue;
      }

      pendingCueIndex = null;

      // Check bare "01." header before Phonetic:/Thai:/Burmese:
      const bareNumMatch = trimmed.match(BARE_NUMBERED_HEADER_RE);
      if (bareNumMatch && hasFieldLabel) {
        const idx = parseInt(bareNumMatch[1], 10);
        finalizeCurrent();
        current = {
          index: Number.isFinite(idx) ? idx : null,
          rawHeader: trimmed,
          hasExplicitFields: false,
          unlabeledLines: [],
          rawText: trimmed,
        };
        continue;
      }

      // Check field line
      const fieldMatch = trimmed.match(FIELD_LABEL_RE);
      if (fieldMatch) {
        const key = normalizeFieldKey(fieldMatch[1]);
        const value = (fieldMatch[2] || "").trim();
        if (key) {
          if (!current) {
            current = {
              index: null,
              hasExplicitFields: true,
              unlabeledLines: [],
              rawText: trimmed,
            };
          }
          current.hasExplicitFields = true;
          current.sawBlankLineAfterContent = false;
          current.lastField = key;
          if (key === "phonetic") {
            current.thaiPhonetic = value;
          } else if (key === "thai") {
            current.thaiScript = value;
          } else if (key === "burmese") {
            current.burmese = value;
          } else if (key === "words") {
            current.words = parseWordsLine(value);
          }
          continue;
        }
      }

      // Continuation or unlabeled cue body lines inside an active block (before a blank line)
      if (current && !current.sawBlankLineAfterContent) {
        if (current.hasExplicitFields) {
          if (current.lastField === "burmese") {
            current.burmese = current.burmese ? `${current.burmese} ${trimmed}` : trimmed;
          } else if (current.lastField === "phonetic") {
            current.thaiPhonetic = current.thaiPhonetic
              ? `${current.thaiPhonetic} ${trimmed}`
              : trimmed;
          } else if (current.lastField === "thai") {
            current.thaiScript = current.thaiScript ? `${current.thaiScript}${trimmed}` : trimmed;
          } else if (current.lastField === "words") {
            const extra = parseWordsLine(trimmed);
            current.words = [...(current.words ?? []), ...extra];
          }
        } else if (current.startSec !== undefined || current.index !== null) {
          current.unlabeledLines.push(trimmed);
        }
      }
    }

    finalizeCurrent();

    if (entries.length > 0) {
      return { mode: "structured", entries, warnings };
    }
  }

  // 2. Single-line numbered format ([1] ... or 1. ...)
  const numberedEntries: ParsedTranscriptEntry[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^={3,}$|^-{3,}$/.test(trimmed)) continue;
    const match = trimmed.match(SINGLE_LINE_NUMBERED_RE);
    if (match) {
      const idx = parseInt(match[1] || match[2], 10);
      const payloadRaw = (match[3] || "").trim();
      const tsInfo = stripLeadingTimestamp(payloadRaw);
      const payload = tsInfo.rest || payloadRaw;
      if (!payload) continue;
      numberedEntries.push({
        index: Number.isFinite(idx) ? idx : null,
        ...(tsInfo.startSec !== undefined ? { startSec: tsInfo.startSec } : {}),
        ...(tsInfo.endSec !== undefined ? { endSec: tsInfo.endSec } : {}),
        rawHeader: trimmed,
        rawText: payload,
        ...classifySingleLinePayload(payload),
      });
    }
  }

  if (numberedEntries.length > 0) {
    const nonEmptyCount = lines.filter(
      (l) => l.trim() && !/^={3,}$|^-{3,}$/.test(l.trim())
    ).length;
    if (nonEmptyCount > numberedEntries.length + 2 && numberedEntries.length === 1) {
      // Only 1 accidental numbered line among many plain lines -> fall through to plain_lines
    } else {
      return { mode: "numbered_lines", entries: numberedEntries, warnings };
    }
  }

  // 3. Plain line-by-line fallback
  const plainEntries: ParsedTranscriptEntry[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^={3,}$|^-{3,}$/.test(trimmed)) continue;
    if (/^title\s*:/i.test(trimmed) && plainEntries.length === 0) continue;

    plainEntries.push({
      index: null,
      rawText: trimmed,
      ...classifySingleLinePayload(trimmed),
    });
  }

  if (plainEntries.length === 0) {
    return { mode: "empty", entries: [], warnings };
  }

  return { mode: "plain_lines", entries: plainEntries, warnings };
}

function areWordsEqual(a: SubtitleWord[], b: SubtitleWord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].phonetic !== b[i].phonetic ||
      a[i].thai !== b[i].thai ||
      (a[i].burmeseGloss || "") !== (b[i].burmeseGloss || "") ||
      a[i].startOffsetSec !== b[i].startOffsetSec ||
      a[i].endOffsetSec !== b[i].endOffsetSec
    ) {
      return false;
    }
  }
  return true;
}

function distributeParsedWords(
  parsedWords: ParsedTranscriptWord[],
  spanStart: number,
  spanEnd: number,
  existingWords: SubtitleWord[]
): SubtitleWord[] {
  const safeStart = Number.isFinite(spanStart) ? Math.max(0, spanStart) : 0;
  const safeEnd = Number.isFinite(spanEnd) ? Math.max(safeStart + 0.2, spanEnd) : safeStart + 0.2;
  const spanDur = Math.max(0.2, safeEnd - safeStart);
  const totalWeight =
    parsedWords.reduce((acc, w) => acc + Math.max(2, w.phonetic.length), 0) || 1;
  let cursor = safeStart;

  return parsedWords.map((pw, idx) => {
    const ex = existingWords[idx];
    const wDur = (Math.max(2, pw.phonetic.length) / totalWeight) * spanDur;
    const startOffsetSec = Number(cursor.toFixed(2));
    const endOffsetSec = Number(
      (idx === parsedWords.length - 1 ? safeEnd : cursor + wDur).toFixed(2)
    );
    cursor = endOffsetSec;
    return {
      phonetic: pw.phonetic,
      thai: pw.thai || ex?.thai || pw.phonetic,
      burmeseGloss: pw.hasGlossParen
        ? pw.burmeseGloss ?? ""
        : ex?.burmeseGloss ?? "",
      startOffsetSec,
      endOffsetSec,
    };
  });
}

function syncSingleSubtitle(
  existing: SubtitleItem,
  entry: ParsedTranscriptEntry
): { next: SubtitleItem; changedFields: SyncChangedField[] } {
  const existingWords = Array.isArray(existing.words) ? existing.words : [];

  let nextThaiPhonetic =
    entry.thaiPhonetic !== undefined && entry.thaiPhonetic.trim() !== ""
      ? entry.thaiPhonetic.trim()
      : existing.thaiPhonetic;

  const nextThaiScript =
    entry.thaiScript !== undefined && entry.thaiScript.trim() !== ""
      ? entry.thaiScript.trim()
      : existing.thaiScript;

  const nextBurmese =
    entry.burmese !== undefined && entry.burmese.trim() !== ""
      ? entry.burmese.trim()
      : existing.burmese;

  const duration = Math.max(0.2, existing.endTime - existing.startTime);
  const hasExistingWords = existingWords.length > 0;
  const spanStart = hasExistingWords ? existingWords[0].startOffsetSec : 0;
  const spanEnd = hasExistingWords
    ? Math.max(spanStart + 0.2, existingWords[existingWords.length - 1].endOffsetSec)
    : duration;

  let nextWords: SubtitleWord[] = existingWords.map((w) => ({ ...w }));

  if (entry.words && entry.words.length > 0) {
    if (hasExistingWords && entry.words.length === existingWords.length) {
      nextWords = entry.words.map((pw, idx) => {
        const prevWord = existingWords[idx];
        return {
          phonetic: pw.phonetic || prevWord.phonetic,
          thai: pw.thai || prevWord.thai,
          burmeseGloss: pw.hasGlossParen
            ? pw.burmeseGloss ?? ""
            : prevWord.burmeseGloss ?? "",
          startOffsetSec: prevWord.startOffsetSec,
          endOffsetSec: prevWord.endOffsetSec,
        };
      });
    } else {
      nextWords = distributeParsedWords(entry.words, spanStart, spanEnd, existingWords);
    }

    if (entry.thaiPhonetic === undefined || entry.thaiPhonetic.trim() === "") {
      const joinedFromWords = nextWords
        .map((w) => w.phonetic.trim())
        .filter(Boolean)
        .join(" ");
      if (joinedFromWords) {
        nextThaiPhonetic = joinedFromWords;
      }
    }
  } else if (nextThaiPhonetic !== existing.thaiPhonetic) {
    const wsTokens = nextThaiPhonetic.split(/\s+/).filter(Boolean);
    const hyTokens = nextThaiPhonetic.split(/[\s-]+/).filter(Boolean);

    if (hasExistingWords && wsTokens.length === existingWords.length) {
      nextWords = wsTokens.map((tok, idx) => ({
        ...existingWords[idx],
        phonetic: tok,
      }));
    } else if (hasExistingWords && hyTokens.length === existingWords.length) {
      nextWords = hyTokens.map((tok, idx) => ({
        ...existingWords[idx],
        phonetic: tok,
      }));
    } else {
      nextWords = buildWordsFromPhonetic(
        nextThaiPhonetic,
        spanStart,
        spanEnd,
        existingWords
      );
    }
  }

  const changedFields: SyncChangedField[] = [];
  if (nextThaiPhonetic !== existing.thaiPhonetic) changedFields.push("thaiPhonetic");
  if (nextThaiScript !== existing.thaiScript) changedFields.push("thaiScript");
  if (nextBurmese !== existing.burmese) changedFields.push("burmese");
  if (!areWordsEqual(existingWords, nextWords)) changedFields.push("words");

  const changed = changedFields.length > 0;
  const next: SubtitleItem = changed
    ? {
        ...existing,
        thaiPhonetic: nextThaiPhonetic,
        thaiScript: nextThaiScript,
        burmese: nextBurmese,
        words: nextWords,
        isManuallyEdited: true,
      }
    : existing;

  return { next, changedFields };
}

export function computeTranscriptSyncPreview(
  existingSubtitles: SubtitleItem[],
  rawInput: string
): TranscriptSyncPreview {
  const parsed = parsePastedTranscript(rawInput);
  const warnings = [...parsed.warnings];
  const unmatchedEntries: ParsedTranscriptEntry[] = [];
  const matchedBySubIndex = new Map<number, ParsedTranscriptEntry>();

  const hasNumberedEntries = parsed.entries.some((e) => e.index !== null);

  if (parsed.entries.length > 0) {
    if (hasNumberedEntries) {
      const duplicateIndices = new Set<number>();
      let sequentialFallbackCursor = 0;

      for (const entry of parsed.entries) {
        if (entry.index !== null) {
          const targetIdx = entry.index - 1;
          if (targetIdx < 0 || targetIdx >= existingSubtitles.length) {
            unmatchedEntries.push(entry);
          } else {
            if (matchedBySubIndex.has(targetIdx)) {
              duplicateIndices.add(entry.index);
            }
            matchedBySubIndex.set(targetIdx, entry);
          }
        } else {
          while (
            sequentialFallbackCursor < existingSubtitles.length &&
            matchedBySubIndex.has(sequentialFallbackCursor)
          ) {
            sequentialFallbackCursor++;
          }
          if (sequentialFallbackCursor < existingSubtitles.length) {
            matchedBySubIndex.set(sequentialFallbackCursor, entry);
            sequentialFallbackCursor++;
          } else {
            unmatchedEntries.push(entry);
          }
        }
      }

      if (duplicateIndices.size > 0) {
        const list = Array.from(duplicateIndices).sort((a, b) => a - b);
        warnings.push(
          `Duplicate index numbers detected (${list.map((n) => `[${n}]`).join(", ")}); using the latest entry for each.`
        );
      }
    } else {
      parsed.entries.forEach((entry, idx) => {
        if (idx < existingSubtitles.length) {
          matchedBySubIndex.set(idx, entry);
        } else {
          unmatchedEntries.push(entry);
        }
      });
    }
  }

  let matchedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  const rows: TranscriptSyncRowPreview[] = [];
  const nextSubtitles: SubtitleItem[] = [];

  existingSubtitles.forEach((existing, idx) => {
    const entry = matchedBySubIndex.get(idx);
    if (!entry) {
      unchangedCount++;
      rows.push({
        subtitleId: existing.id,
        lineNumber: idx + 1,
        startTime: existing.startTime,
        endTime: existing.endTime,
        matched: false,
        changed: false,
        changedFields: [],
        before: existing,
        after: existing,
      });
      nextSubtitles.push(existing);
      return;
    }

    matchedCount++;
    const { next, changedFields } = syncSingleSubtitle(existing, entry);
    const changed = changedFields.length > 0;
    if (changed) changedCount++;
    else unchangedCount++;

    rows.push({
      subtitleId: existing.id,
      lineNumber: idx + 1,
      startTime: existing.startTime,
      endTime: existing.endTime,
      matched: true,
      changed,
      changedFields,
      before: existing,
      after: next,
      matchedEntry: entry,
    });
    nextSubtitles.push(next);
  });

  const countMismatch =
    parsed.entries.length > 0 && parsed.entries.length !== existingSubtitles.length;

  if (unmatchedEntries.length > 0) {
    warnings.push(
      `${unmatchedEntries.length} pasted ${unmatchedEntries.length === 1 ? "entry" : "entries"} did not match any existing subtitle index (1–${existingSubtitles.length}).`
    );
  }

  return {
    parsed,
    matchedCount,
    changedCount,
    unchangedCount,
    countMismatch,
    unmatchedEntries,
    warnings,
    rows,
    nextSubtitles,
  };
}

export type TranscriptTimingCoordinateMode = "auto" | "timeline" | "source";

export interface PasteTranscriptBuildOptions {
  timingMode?: TranscriptTimingCoordinateMode;
  scenes?: SpeakingScene[];
  sourceDurationSec?: number;
  primaryMediaUrl?: string;
}

export interface StructuredTranscriptImportResult {
  mode: ParsedTranscriptMode;
  entries: ParsedTranscriptEntry[];
  subtitles: SubtitleItem[];
  scenes: SpeakingScene[];
  targetDurationSec: number;
  clipTotalDurationSec: number;
  resolvedTimingMode: "timeline" | "source";
  autoDetectedTimingMode: "timeline" | "source";
  canToggleTimingMode: boolean;
  hasMultiSourceClips: boolean;
  timedCount: number;
  untimedCount: number;
  exceedsTimelineCount: number;
  outsideSourceClipsCount: number;
  spanStartSec: number;
  spanEndSec: number;
  hasPhonetic: boolean;
  hasThai: boolean;
  hasBurmese: boolean;
  hasWords: boolean;
  warnings: string[];
}

export function hasStructuredTranscriptFieldLabels(rawInput: string): boolean {
  const cleaned = stripWrappingCodeFences(rawInput || "");
  if (!cleaned) return false;
  return cleaned.split("\n").some((line) => FIELD_LABEL_RE.test(line.trim()));
}

export function buildSubtitlesFromStructuredTranscript(
  rawInput: string,
  selectedScenes: SceneSelection[],
  totalDurationSec: number,
  options?: PasteTranscriptBuildOptions
): StructuredTranscriptImportResult {
  const parsed = parsePastedTranscript(rawInput);
  const warnings = [...parsed.warnings];

  const timedEntries = parsed.entries.filter(
    (e) => typeof e.startSec === "number" && Number.isFinite(e.startSec)
  );
  const timedCount = timedEntries.length;
  const untimedCount = parsed.entries.length - timedCount;

  const maxParsedEnd = parsed.entries.reduce((max, e) => {
    const end =
      typeof e.endSec === "number" && Number.isFinite(e.endSec)
        ? e.endSec
        : typeof e.startSec === "number" && Number.isFinite(e.startSec)
          ? e.startSec + 2
          : 0;
    return Math.max(max, end);
  }, 0);

  const safeVideoDur = Math.max(
    1,
    Number.isFinite(totalDurationSec) && totalDurationSec > 0 ? totalDurationSec : 0,
    Math.ceil(maxParsedEnd)
  );

  const richScenes = options?.scenes && options.scenes.length > 0 ? options.scenes : null;
  const hasExplicitScenes = Boolean(richScenes || selectedScenes.length > 0);

  let cutCursor = 0;
  const scenes: SpeakingScene[] = richScenes
    ? richScenes.map((sc, idx) => {
        const s = Math.max(0, Number(sc.startSec) || 0);
        const durFallback = Number.isFinite(sc.durationSec) && sc.durationSec > 0 ? sc.durationSec : 0.1;
        const e = Math.max(
          s + 0.1,
          Number.isFinite(sc.endSec) && sc.endSec > s ? sc.endSec : s + durFallback
        );
        const dur = Number(getSceneDurationSec({ startSec: s, endSec: e, durationSec: sc.durationSec }).toFixed(3));
        cutCursor += dur;
        return {
          ...sc,
          id: sc.id || `scene-import-${idx + 1}`,
          index: idx,
          startSec: Number(s.toFixed(3)),
          endSec: Number(e.toFixed(3)),
          durationSec: dur,
          summary: sc.summary || `Clip ${idx + 1}`,
        };
      })
    : (selectedScenes.length > 0
        ? selectedScenes
        : [{ id: `scene-import-${Date.now()}`, startSec: 0, endSec: safeVideoDur }]
      ).map((sc, idx) => {
        const s = Math.max(0, Number(sc.startSec) || 0);
        const e = Math.max(s + 0.1, Number(sc.endSec) || safeVideoDur);
        const dur = Number((e - s).toFixed(3));
        cutCursor += dur;
        return {
          id: sc.id || `scene-import-${idx + 1}`,
          index: idx,
          startSec: Number(s.toFixed(3)),
          endSec: Number(e.toFixed(3)),
          durationSec: dur,
          summary: `Clip ${idx + 1}`,
        };
      });

  const clipTotalDurationSec = Number(Math.max(0.5, cutCursor).toFixed(3));
  const targetDurationSec = clipTotalDurationSec;

  const mergedBlocks = buildContiguousClipBlocks(scenes);
  const videoBlocks = mergedBlocks.filter((b) => b.mediaType !== "image");
  const distinctVideoMediaUrls = new Set(videoBlocks.map((b) => b.mediaUrl));
  const hasImages = scenes.some((sc) => sc.mediaType === "image");
  const hasMultiSourceClips = distinctVideoMediaUrls.size > 1 || (hasImages && scenes.length > 0);

  const sourceDurHint =
    typeof options?.sourceDurationSec === "number" &&
    Number.isFinite(options.sourceDurationSec) &&
    options.sourceDurationSec > 0
      ? options.sourceDurationSec
      : undefined;

  const primaryVideoUrl =
    options?.primaryMediaUrl &&
    videoBlocks.some((b) => (b.mediaUrl || "") === options.primaryMediaUrl)
      ? options.primaryMediaUrl
      : (videoBlocks[0]?.mediaUrl ?? "");

  const isContiguousFullFromZero =
    !hasImages &&
    videoBlocks.length === 1 &&
    Math.abs(videoBlocks[0].startSec) < 0.05 &&
    (!sourceDurHint || Math.abs(videoBlocks[0].endSec - sourceDurHint) < 0.5);

  const canToggleTimingMode =
    timedCount > 0 && videoBlocks.length > 0 && !isContiguousFullFromZero;

  // Auto-detect whether timestamps represent Cut-Timeline coordinates (0:00 = Clip 1 start,
  // e.g. Whisper tab output) or Original Source-Video coordinates (unedited full video).
  let autoDetectedTimingMode: "timeline" | "source" = "timeline";
  if (
    timedEntries.length > 0 &&
    !isContiguousFullFromZero &&
    videoBlocks.length > 0
  ) {
    const primaryBlocks = videoBlocks.filter((b) => (b.mediaUrl || "") === (primaryVideoUrl || ""));
    if (primaryBlocks.length > 0) {
      const minVideoStart = primaryBlocks.reduce((m, b) => Math.min(m, b.startSec), Infinity);
      const maxVideoEnd = primaryBlocks.reduce((m, b) => Math.max(m, b.endSec), 0);

      let timelineInRangeCount = 0;
      let sourceOverlapCount = 0;
      let matchesPastCutEndInSource = 0;
      let beforeMinVideoCount = 0;

      for (const e of timedEntries) {
        const s = Math.max(0, e.startSec!);
        const end = typeof e.endSec === "number" && e.endSec > s ? e.endSec : s + 1.5;

        if (s < clipTotalDurationSec - 0.05) {
          timelineInRangeCount++;
        }
        const overlapsSource = primaryBlocks.some(
          (b) => Math.min(b.endSec, end) - Math.max(b.startSec, s) >= 0.08
        );
        if (overlapsSource) {
          sourceOverlapCount++;
          if (s >= clipTotalDurationSec + 0.45) {
            matchesPastCutEndInSource++;
          }
        }
        if (s < minVideoStart - 0.25 && end <= minVideoStart + 0.25) {
          beforeMinVideoCount++;
        }
      }

      if (matchesPastCutEndInSource > 0) {
        autoDetectedTimingMode = "source";
      } else if (beforeMinVideoCount > 0 && timelineInRangeCount === timedEntries.length) {
        autoDetectedTimingMode = "timeline";
      } else if (
        minVideoStart > 0.8 &&
        beforeMinVideoCount === 0 &&
        sourceOverlapCount === timedEntries.length
      ) {
        autoDetectedTimingMode = "source";
      } else if (
        maxVideoEnd > clipTotalDurationSec + 0.5 &&
        timedEntries.some((e) => e.startSec! >= clipTotalDurationSec + 0.45) &&
        sourceOverlapCount > 0
      ) {
        autoDetectedTimingMode = "source";
      } else if (sourceOverlapCount > timelineInRangeCount) {
        autoDetectedTimingMode = "source";
      }
    }
  }

  const resolvedTimingMode: "timeline" | "source" =
    options?.timingMode === "source"
      ? "source"
      : options?.timingMode === "timeline"
        ? "timeline"
        : autoDetectedTimingMode;

  if (parsed.entries.length === 0) {
    return {
      mode: parsed.mode,
      entries: [],
      subtitles: [],
      scenes,
      targetDurationSec,
      clipTotalDurationSec,
      resolvedTimingMode,
      autoDetectedTimingMode,
      canToggleTimingMode,
      hasMultiSourceClips,
      timedCount: 0,
      untimedCount: 0,
      exceedsTimelineCount: 0,
      outsideSourceClipsCount: 0,
      spanStartSec: 0,
      spanEndSec: 0,
      hasPhonetic: false,
      hasThai: false,
      hasBurmese: false,
      hasWords: false,
      warnings,
    };
  }

  const nowTs = Date.now();
  const rawBuilt: SubtitleItem[] = [];
  let fallbackCursor = 0;
  let outsideSourceClipsCount = 0;
  let exceedsTimelineCount = 0;

  const createSubtitleItem = (
    entry: ParsedTranscriptEntry,
    startTime: number,
    endTime: number,
    seqIdx: number,
    opts?: {
      clipLeftFrac?: number;
      clipRightFrac?: number;
      bounds?: { minCutStart: number; maxCutEnd: number };
      explicitSource?: {
        sceneIndex: number;
        sceneId?: string;
        mediaUrl?: string;
        sourceStartSec: number;
        sourceEndSec: number;
        sourceSegments?: SubtitleSourceSegment[];
      };
    }
  ): SubtitleItem => {
    let cleanStartNum = Math.max(0, startTime);
    let cleanEndNum = endTime;
    if (opts?.bounds) {
      const minBound = Math.max(0, opts.bounds.minCutStart);
      const maxBound = Math.max(minBound + 0.08, opts.bounds.maxCutEnd);
      cleanStartNum = Math.max(minBound, Math.min(maxBound - 0.08, cleanStartNum));
      cleanEndNum = Math.min(maxBound, Math.max(cleanStartNum + 0.08, cleanEndNum));
      if (cleanEndNum - cleanStartNum < 0.15 && maxBound - minBound >= 0.15) {
        if (cleanStartNum + 0.15 <= maxBound) {
          cleanEndNum = cleanStartNum + 0.15;
        } else {
          cleanEndNum = maxBound;
          cleanStartNum = Math.max(minBound, maxBound - 0.15);
        }
      }
    } else {
      cleanEndNum = Math.max(cleanStartNum + 0.15, cleanEndNum);
    }
    const cleanStart = Number(cleanStartNum.toFixed(3));
    const cleanEnd = Number(cleanEndNum.toFixed(3));
    const duration = Math.max(0.08, cleanEnd - cleanStart);

    let parsedWords = Array.isArray(entry.words) ? entry.words : [];
    if (
      parsedWords.length > 1 &&
      typeof opts?.clipLeftFrac === "number" &&
      typeof opts?.clipRightFrac === "number" &&
      (opts.clipLeftFrac > 0.04 || opts.clipRightFrac < 0.96)
    ) {
      const totalW = parsedWords.length;
      const startW = Math.max(0, Math.min(totalW - 1, Math.floor(opts.clipLeftFrac * totalW)));
      const endW = Math.max(startW + 1, Math.min(totalW, Math.ceil(opts.clipRightFrac * totalW)));
      parsedWords = parsedWords.slice(startW, endW);
    }

    const thaiScript = (entry.thaiScript || "").trim();
    const burmese = (entry.burmese || "").trim();
    let thaiPhonetic = (entry.thaiPhonetic || "").trim();
    if (!thaiPhonetic && parsedWords.length > 0) {
      thaiPhonetic = parsedWords
        .map((w) => w.phonetic.trim())
        .filter(Boolean)
        .join(" ");
    }
    if (!thaiPhonetic && thaiScript) {
      thaiPhonetic = thaiScript;
    }

    const words: SubtitleWord[] =
      parsedWords.length > 0
        ? distributeParsedWords(parsedWords, 0, duration, [])
        : thaiPhonetic
          ? buildWordsFromPhonetic(thaiPhonetic, 0, duration, [])
          : [];

    const originalSpokenText = thaiScript || thaiPhonetic || burmese;

    if (opts?.explicitSource) {
      const ex = opts.explicitSource;
      return {
        id: `sub-import-${seqIdx + 1}-${nowTs}`,
        sceneIndex: ex.sceneIndex,
        ...(ex.sceneId ? { sceneId: ex.sceneId } : {}),
        ...(ex.mediaUrl !== undefined ? { mediaUrl: ex.mediaUrl } : {}),
        startTime: cleanStart,
        endTime: cleanEnd,
        sourceStartSec: Number(Math.max(0, ex.sourceStartSec).toFixed(3)),
        sourceEndSec: Number(Math.max(ex.sourceStartSec + 0.08, ex.sourceEndSec).toFixed(3)),
        ...(ex.sourceSegments && ex.sourceSegments.length > 1
          ? { sourceSegments: ex.sourceSegments }
          : {}),
        thaiPhonetic,
        thaiScript,
        burmese,
        originalSpokenText,
        words,
        isManuallyEdited: true,
      };
    }

    const mapped = mapCutRangeToSourceMetadata(scenes, cleanStart, cleanEnd);
    return {
      id: `sub-import-${seqIdx + 1}-${nowTs}`,
      sceneIndex: mapped.sceneIndex,
      ...(mapped.sceneId ? { sceneId: mapped.sceneId } : {}),
      ...(mapped.mediaUrl !== undefined ? { mediaUrl: mapped.mediaUrl } : {}),
      startTime: cleanStart,
      endTime: cleanEnd,
      sourceStartSec: mapped.sourceStartSec,
      sourceEndSec: mapped.sourceEndSec,
      ...(mapped.sourceSegments ? { sourceSegments: mapped.sourceSegments } : {}),
      thaiPhonetic,
      thaiScript,
      burmese,
      originalSpokenText,
      words,
      isManuallyEdited: true,
    };
  };

  const sourceMatchingBlocks = videoBlocks.filter(
    (b) => (b.mediaUrl || "") === (primaryVideoUrl || "")
  );

  if (resolvedTimingMode === "source" && distinctVideoMediaUrls.size > 1) {
    warnings.push(
      "Source Video timing matched your primary video clip; separately uploaded clips keep their own cut timeline."
    );
  }
  if (resolvedTimingMode === "source" && hasImages) {
    warnings.push("Image clips are skipped when mapping Source Video timestamps.");
  }

  parsed.entries.forEach((entry, idx) => {
    const hasStart = typeof entry.startSec === "number" && Number.isFinite(entry.startSec);
    if (hasStart) {
      const rawStart = Math.max(0, entry.startSec!);
      const rawEnd =
        typeof entry.endSec === "number" && Number.isFinite(entry.endSec) && entry.endSec > rawStart
          ? entry.endSec
          : rawStart + 2.0;

      if (resolvedTimingMode === "source") {
        const entryDur = Math.max(0.15, rawEnd - rawStart);
        interface SourceSliceMatch {
          sceneIndex: number;
          sceneId?: string;
          mediaUrl?: string;
          sourceStartSec: number;
          sourceEndSec: number;
          cutStart: number;
          cutEnd: number;
          sceneCutStart: number;
          sceneCutEnd: number;
        }
        const sliceMatches: SourceSliceMatch[] = [];

        for (const block of sourceMatchingBlocks) {
          const blockOvStart = Math.max(block.startSec, rawStart);
          const blockOvEnd = Math.min(block.endSec, rawEnd);
          if (blockOvEnd - blockOvStart < 0.08) continue;

          for (const ref of block.sceneRefs) {
            const ovStart = Math.max(ref.startSec, rawStart);
            const ovEnd = Math.min(ref.endSec, rawEnd);
            if (ovEnd - ovStart >= 0.04) {
              const cutStart = ref.cutStart + (ovStart - ref.startSec);
              const cutEnd = ref.cutStart + (ovEnd - ref.startSec);
              sliceMatches.push({
                sceneIndex: ref.sceneIndex,
                sceneId: ref.sceneId ?? scenes[ref.sceneIndex]?.id,
                mediaUrl: scenes[ref.sceneIndex]?.mediaUrl,
                sourceStartSec: Number(ovStart.toFixed(3)),
                sourceEndSec: Number(ovEnd.toFixed(3)),
                cutStart,
                cutEnd,
                sceneCutStart: ref.cutStart,
                sceneCutEnd: ref.cutEnd,
              });
            }
          }
        }

        if (sliceMatches.length === 0) {
          outsideSourceClipsCount++;
          return;
        }

        sliceMatches.sort((a, b) => a.cutStart - b.cutStart);

        const groups: SourceSliceMatch[][] = [];
        for (const sl of sliceMatches) {
          const curGroup = groups[groups.length - 1];
          if (!curGroup) {
            groups.push([sl]);
            continue;
          }
          const prev = curGroup[curGroup.length - 1];
          if (sl.cutStart - prev.cutEnd <= 0.08) {
            curGroup.push(sl);
          } else {
            groups.push([sl]);
          }
        }

        for (const group of groups) {
          const groupCutStart = group[0].cutStart;
          const groupCutEnd = group[group.length - 1].cutEnd;
          const boundsMinCut = group[0].sceneCutStart;
          const boundsMaxCut = group[group.length - 1].sceneCutEnd;

          let bestPos = 0;
          let bestDur = -1;
          group.forEach((g, gi) => {
            const d = g.sourceEndSec - g.sourceStartSec;
            if (d > bestDur) {
              bestDur = d;
              bestPos = gi;
            }
          });
          const dom = group[bestPos];

          let runStart = dom.sourceStartSec;
          let runEnd = dom.sourceEndSec;
          for (let i = bestPos - 1; i >= 0; i--) {
            const g = group[i];
            if (
              (g.mediaUrl || "") === (dom.mediaUrl || "") &&
              Math.abs(runStart - g.sourceEndSec) <= 0.05
            ) {
              runStart = Math.min(runStart, g.sourceStartSec);
            } else {
              break;
            }
          }
          for (let i = bestPos + 1; i < group.length; i++) {
            const g = group[i];
            if (
              (g.mediaUrl || "") === (dom.mediaUrl || "") &&
              Math.abs(g.sourceStartSec - runEnd) <= 0.05
            ) {
              runEnd = Math.max(runEnd, g.sourceEndSec);
            } else {
              break;
            }
          }

          const minSrc = group.reduce((m, g) => Math.min(m, g.sourceStartSec), Infinity);
          const maxSrc = group.reduce((m, g) => Math.max(m, g.sourceEndSec), 0);

          const sourceSegments: SubtitleSourceSegment[] | undefined =
            group.length > 1
              ? group.map((g) => ({
                  ...(g.sceneId ? { sceneId: g.sceneId } : {}),
                  ...(g.mediaUrl !== undefined ? { mediaUrl: g.mediaUrl } : {}),
                  sourceStartSec: g.sourceStartSec,
                  sourceEndSec: g.sourceEndSec,
                }))
              : undefined;

          const created = createSubtitleItem(entry, groupCutStart, groupCutEnd, rawBuilt.length, {
            clipLeftFrac: Math.max(0, (minSrc - rawStart) / entryDur),
            clipRightFrac: Math.min(1, (maxSrc - rawStart) / entryDur),
            bounds: { minCutStart: boundsMinCut, maxCutEnd: boundsMaxCut },
            explicitSource: {
              sceneIndex: dom.sceneIndex,
              sceneId: dom.sceneId,
              mediaUrl: dom.mediaUrl,
              sourceStartSec: runStart,
              sourceEndSec: runEnd,
              ...(sourceSegments ? { sourceSegments } : {}),
            },
          });
          rawBuilt.push(created);
          fallbackCursor = Math.max(fallbackCursor, created.endTime);
        }
      } else {
        if (hasExplicitScenes && rawStart >= clipTotalDurationSec - 0.05) {
          exceedsTimelineCount++;
        }
        rawBuilt.push(createSubtitleItem(entry, rawStart, rawEnd, rawBuilt.length));
        fallbackCursor = Math.max(fallbackCursor, rawEnd);
      }
    } else {
      const remainingLines = Math.max(1, parsed.entries.length - idx);
      const remainingTimeline = Math.max(0, targetDurationSec - fallbackCursor);
      const fitSlot =
        hasExplicitScenes && remainingTimeline > 0.25
          ? Math.max(0.25, Math.min(3.0, remainingTimeline / remainingLines))
          : Math.min(3.0, Math.max(1.2, (remainingTimeline || remainingLines * 1.5) / remainingLines));
      const start = fallbackCursor;
      const end = start + fitSlot;
      if (hasExplicitScenes && start >= clipTotalDurationSec - 0.05) {
        exceedsTimelineCount++;
      }
      rawBuilt.push(createSubtitleItem(entry, start, end, rawBuilt.length));
      fallbackCursor = end;
    }
  });

  if (untimedCount > 0) {
    warnings.push(
      `${untimedCount} ${untimedCount === 1 ? "line had" : "lines had"} no timestamps and ${untimedCount === 1 ? "was" : "were"} paced sequentially.`
    );
  }
  if (resolvedTimingMode === "source" && outsideSourceClipsCount > 0) {
    warnings.push(
      `${outsideSourceClipsCount} ${outsideSourceClipsCount === 1 ? "line fell" : "lines fell"} outside your kept timeline clips (trimmed out) and ${outsideSourceClipsCount === 1 ? "was" : "were"} skipped.`
    );
  }
  if (resolvedTimingMode === "timeline" && exceedsTimelineCount > 0) {
    warnings.push(
      `${exceedsTimelineCount} ${exceedsTimelineCount === 1 ? "line starts" : "lines start"} past the timeline end (${clipTotalDurationSec.toFixed(1)}s). If these timestamps match the unedited source video, switch Timing to Source Video.`
    );
  }

  rawBuilt.sort((a, b) => a.startTime - b.startTime);

  // Clean up tiny timing overlaps while preserving exact start times and valid non-inverted source ranges
  const subtitles: SubtitleItem[] = rawBuilt.map((sub, i) => {
    const next = rawBuilt[i + 1];
    if (next && sub.endTime > next.startTime && next.startTime > sub.startTime + 0.15) {
      const adjustedEnd = Number(next.startTime.toFixed(3));
      const nextDur = Math.max(0.15, adjustedEnd - sub.startTime);
      const oldDur = Math.max(0.15, sub.endTime - sub.startTime);
      const cutDelta = Math.max(0, sub.endTime - adjustedEnd);
      const ratio = nextDur / oldDur;
      const mapped = mapCutRangeToSourceMetadata(scenes, sub.startTime, adjustedEnd);

      if (resolvedTimingMode === "source") {
        let nextSourceSegments = sub.sourceSegments
          ? sub.sourceSegments.map((seg) => ({ ...seg }))
          : undefined;
        let trimmedDelta = cutDelta;
        if (nextSourceSegments && nextSourceSegments.length > 0) {
          const kept: SubtitleSourceSegment[] = [];
          // Trim cutDelta cleanly from trailing source segments so we never bleed across deleted gaps
          for (let sIdx = nextSourceSegments.length - 1; sIdx >= 0; sIdx--) {
            const seg = nextSourceSegments[sIdx];
            const segDur = Math.max(0, seg.sourceEndSec - seg.sourceStartSec);
            if (trimmedDelta <= 0.001) {
              kept.unshift(seg);
              continue;
            }
            if (segDur - trimmedDelta >= 0.04) {
              kept.unshift({
                ...seg,
                sourceEndSec: Number((seg.sourceEndSec - trimmedDelta).toFixed(3)),
              });
              trimmedDelta = 0;
            } else {
              trimmedDelta = Math.max(0, trimmedDelta - segDur);
            }
          }
          if (kept.length > 0) {
            nextSourceSegments = kept;
          } else {
            nextSourceSegments = [
              {
                ...nextSourceSegments[0],
                sourceEndSec: Number((nextSourceSegments[0].sourceStartSec + 0.08).toFixed(3)),
              },
            ];
          }
        }

        const nextSourceEnd =
          nextSourceSegments && nextSourceSegments.length > 0
            ? nextSourceSegments[nextSourceSegments.length - 1].sourceEndSec
            : Number(
                Math.max(sub.sourceStartSec + 0.08, sub.sourceEndSec - cutDelta).toFixed(3)
              );

        return {
          ...sub,
          endTime: adjustedEnd,
          sourceEndSec: nextSourceEnd,
          ...(nextSourceSegments && nextSourceSegments.length > 1
            ? { sourceSegments: nextSourceSegments }
            : { sourceSegments: undefined }),
          words: sub.words.map((w) => ({
            ...w,
            startOffsetSec: Number((w.startOffsetSec * ratio).toFixed(2)),
            endOffsetSec: Number((w.endOffsetSec * ratio).toFixed(2)),
          })),
        };
      }

      return {
        ...sub,
        endTime: adjustedEnd,
        sceneIndex: mapped.sceneIndex,
        ...(mapped.sceneId ? { sceneId: mapped.sceneId } : {}),
        ...(mapped.mediaUrl !== undefined ? { mediaUrl: mapped.mediaUrl } : {}),
        sourceStartSec: mapped.sourceStartSec,
        sourceEndSec: mapped.sourceEndSec,
        ...(mapped.sourceSegments
          ? { sourceSegments: mapped.sourceSegments }
          : { sourceSegments: undefined }),
        words: sub.words.map((w) => ({
          ...w,
          startOffsetSec: Number((w.startOffsetSec * ratio).toFixed(2)),
          endOffsetSec: Number((w.endOffsetSec * ratio).toFixed(2)),
        })),
      };
    }
    return sub;
  });

  const spanStartSec = subtitles.length > 0 ? subtitles[0].startTime : 0;
  const spanEndSec = subtitles.reduce((m, s) => Math.max(m, s.endTime), 0);

  return {
    mode: parsed.mode,
    entries: parsed.entries,
    subtitles,
    scenes,
    targetDurationSec: hasExplicitScenes
      ? targetDurationSec
      : Math.max(targetDurationSec, Number(spanEndSec.toFixed(3))),
    clipTotalDurationSec,
    resolvedTimingMode,
    autoDetectedTimingMode,
    canToggleTimingMode,
    hasMultiSourceClips,
    timedCount,
    untimedCount,
    exceedsTimelineCount,
    outsideSourceClipsCount,
    spanStartSec,
    spanEndSec,
    hasPhonetic: parsed.entries.some((e) => Boolean(e.thaiPhonetic?.trim())),
    hasThai: parsed.entries.some((e) => Boolean(e.thaiScript?.trim())),
    hasBurmese: parsed.entries.some((e) => Boolean(e.burmese?.trim())),
    hasWords: parsed.entries.some((e) => Boolean(e.words && e.words.length > 0)),
    warnings,
  };
}

