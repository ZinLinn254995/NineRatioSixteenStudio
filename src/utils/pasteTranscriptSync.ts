import type { SceneSelection, SpeakingScene, SubtitleItem, SubtitleWord } from "../types";
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
  const tsMatch = trimmed.match(TIMESTAMP_RANGE_RE);
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
    if (TIMESTAMP_RANGE_RE.test(t) && hasFieldLabel) return true;
    const bm = t.match(STRUCTURED_HEADER_BRACKET_RE);
    if (!bm) return false;
    return stripLeadingTimestamp(bm[2] || "").hadTimestamp || !(bm[2] || "").trim();
  });

  // 1. Structured multi-line block mode
  if (hasFieldLabel || hasTimestampBlockHeader) {
    const entries: ParsedTranscriptEntry[] = [];
    let current: (ParsedTranscriptEntry & {
      hasExplicitFields: boolean;
      inlineAfterHeader?: string;
      sawBlankLineAfterContent?: boolean;
      lastField?: "phonetic" | "thai" | "burmese" | "words";
    }) | null = null;

    const finalizeCurrent = () => {
      if (!current) return;
      if (!current.hasExplicitFields && current.inlineAfterHeader) {
        const inlineParsed = classifySingleLinePayload(current.inlineAfterHeader);
        Object.assign(current, inlineParsed);
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

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      if (!trimmed) {
        if (current) {
          current.sawBlankLineAfterContent = true;
        }
        continue;
      }

      if (/^={3,}$|^-{3,}$/.test(trimmed)) {
        continue;
      }

      // Check block header: [01] MM:SS – MM:SS
      const bracketMatch = trimmed.match(STRUCTURED_HEADER_BRACKET_RE);
      if (bracketMatch) {
        const idx = parseInt(bracketMatch[1], 10);
        const afterBracket = (bracketMatch[2] || "").trim();
        const tsInfo = stripLeadingTimestamp(afterBracket);

        // If this is a single-line numbered entry without any structured fields anywhere,
        // it still works, and if fields follow it attaches to this block.
        finalizeCurrent();
        current = {
          index: Number.isFinite(idx) ? idx : null,
          ...(tsInfo.startSec !== undefined ? { startSec: tsInfo.startSec } : {}),
          ...(tsInfo.endSec !== undefined ? { endSec: tsInfo.endSec } : {}),
          rawHeader: trimmed,
          hasExplicitFields: false,
          inlineAfterHeader: tsInfo.rest || undefined,
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
        current = {
          index: Number.isFinite(idx) ? idx : null,
          ...(tsStart !== null ? { startSec: tsStart } : {}),
          ...(tsEnd !== null ? { endSec: tsEnd } : {}),
          rawHeader: trimmed,
          hasExplicitFields: false,
          inlineAfterHeader: (numTsMatch[5] || "").trim() || undefined,
          rawText: trimmed,
        };
        continue;
      }

      // Check standalone MM:SS – MM:SS header when structured fields are present
      if (hasFieldLabel) {
        const bareTs = stripLeadingTimestamp(trimmed);
        if (bareTs.hadTimestamp) {
          finalizeCurrent();
          current = {
            index: null,
            ...(bareTs.startSec !== undefined ? { startSec: bareTs.startSec } : {}),
            ...(bareTs.endSec !== undefined ? { endSec: bareTs.endSec } : {}),
            rawHeader: trimmed,
            hasExplicitFields: false,
            inlineAfterHeader: bareTs.rest || undefined,
            rawText: trimmed,
          };
          continue;
        }
      }

      // Check bare "01." header before Phonetic:/Thai:/Burmese:
      const bareNumMatch = trimmed.match(BARE_NUMBERED_HEADER_RE);
      if (bareNumMatch && hasFieldLabel) {
        const idx = parseInt(bareNumMatch[1], 10);
        finalizeCurrent();
        current = {
          index: Number.isFinite(idx) ? idx : null,
          rawHeader: trimmed,
          hasExplicitFields: false,
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

      // Continuation line inside an active block (only before a blank line)
      if (current && current.hasExplicitFields && !current.sawBlankLineAfterContent) {
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

export interface StructuredTranscriptImportResult {
  mode: ParsedTranscriptMode;
  entries: ParsedTranscriptEntry[];
  subtitles: SubtitleItem[];
  scenes: SpeakingScene[];
  targetDurationSec: number;
  timedCount: number;
  untimedCount: number;
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
  totalDurationSec: number
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

  const baseScenes: SceneSelection[] =
    selectedScenes.length > 0
      ? selectedScenes
      : [{ id: `scene-import-${Date.now()}`, startSec: 0, endSec: safeVideoDur }];

  // Compile speaking scenes (cut timeline)
  let cutCursor = 0;
  const sceneLayouts = baseScenes.map((sc, idx) => {
    const s = Math.max(0, Number(sc.startSec) || 0);
    const e = Math.max(s + 0.5, Number(sc.endSec) || safeVideoDur);
    const dur = Number((e - s).toFixed(3));
    const cutStartSec = Number(cutCursor.toFixed(3));
    const cutEndSec = Number((cutCursor + dur).toFixed(3));
    cutCursor = cutEndSec;
    const scene: SpeakingScene = {
      id: sc.id || `scene-import-${idx + 1}`,
      index: idx,
      startSec: Number(s.toFixed(3)),
      endSec: Number(e.toFixed(3)),
      durationSec: dur,
      summary: `Clip ${idx + 1}`,
    };
    return { scene, cutStartSec, cutEndSec };
  });
  const scenes: SpeakingScene[] = sceneLayouts.map((l) => l.scene);

  const targetDurationSec = Number(Math.max(1, cutCursor).toFixed(3));

  if (parsed.entries.length === 0) {
    return {
      mode: parsed.mode,
      entries: [],
      subtitles: [],
      scenes,
      targetDurationSec,
      timedCount: 0,
      untimedCount: 0,
      spanStartSec: 0,
      spanEndSec: 0,
      hasPhonetic: false,
      hasThai: false,
      hasBurmese: false,
      hasWords: false,
      warnings,
    };
  }

  // Decide whether timed entries represent source-video timestamps matching selectedScenes
  // or direct cut-timeline timestamps.
  const isSingleFullClip =
    scenes.length === 1 && Math.abs(scenes[0].startSec) < 0.05;

  let mapSourceToCut = false;
  if (!isSingleFullClip && timedEntries.length > 0) {
    const overlappingSourceCount = timedEntries.filter((e) => {
      const s = e.startSec!;
      const end = typeof e.endSec === "number" && e.endSec > s ? e.endSec : s + 1.5;
      return scenes.some((sc) => end > sc.startSec + 0.05 && s < sc.endSec - 0.05);
    }).length;
    mapSourceToCut = overlappingSourceCount > 0;
  }

  const nowTs = Date.now();
  const rawBuilt: SubtitleItem[] = [];
  let fallbackCursor = 0;

  const findSceneLayoutForCutTime = (cutSec: number) => {
    for (const layout of sceneLayouts) {
      if (cutSec >= layout.cutStartSec - 0.01 && cutSec <= layout.cutEndSec + 0.01) {
        return layout;
      }
    }
    return sceneLayouts[sceneLayouts.length - 1];
  };

  const createSubtitleItem = (
    entry: ParsedTranscriptEntry,
    startTime: number,
    endTime: number,
    seqIdx: number,
    explicitScene?: { sceneIndex: number; sceneId?: string; sourceStartSec: number; sourceEndSec: number }
  ): SubtitleItem => {
    const cleanStart = Number(Math.max(0, startTime).toFixed(3));
    const cleanEnd = Number(Math.max(cleanStart + 0.15, endTime).toFixed(3));
    const duration = Math.max(0.15, cleanEnd - cleanStart);

    const parsedWords = Array.isArray(entry.words) ? entry.words : [];
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

    const layout = findSceneLayoutForCutTime(cleanStart);
    const sceneIndex = explicitScene ? explicitScene.sceneIndex : layout.scene.index;
    const sceneId = explicitScene ? explicitScene.sceneId : layout.scene.id;
    const sourceStartSec = explicitScene
      ? Number(Math.max(0, explicitScene.sourceStartSec).toFixed(3))
      : Number(Math.max(0, layout.scene.startSec + (cleanStart - layout.cutStartSec)).toFixed(3));
    const sourceEndSec = explicitScene
      ? Number(Math.max(sourceStartSec + 0.15, explicitScene.sourceEndSec).toFixed(3))
      : Number(Math.max(sourceStartSec + 0.15, sourceStartSec + duration).toFixed(3));

    return {
      id: `sub-import-${seqIdx + 1}-${nowTs}`,
      sceneIndex,
      ...(sceneId ? { sceneId } : {}),
      startTime: cleanStart,
      endTime: cleanEnd,
      sourceStartSec,
      sourceEndSec,
      thaiPhonetic,
      thaiScript,
      burmese,
      originalSpokenText,
      words,
      isManuallyEdited: true,
    };
  };

  parsed.entries.forEach((entry, idx) => {
    const hasStart = typeof entry.startSec === "number" && Number.isFinite(entry.startSec);
    if (hasStart) {
      const srcStart = Math.max(0, entry.startSec!);
      const srcEnd =
        typeof entry.endSec === "number" && Number.isFinite(entry.endSec) && entry.endSec > srcStart
          ? entry.endSec
          : srcStart + 2.0;

      if (mapSourceToCut) {
        for (const layout of sceneLayouts) {
          const sc = layout.scene;
          if (srcEnd > sc.startSec + 0.05 && srcStart < sc.endSec - 0.05) {
            const relStart = Math.max(0, srcStart - sc.startSec);
            const relEnd = Math.min(sc.durationSec, srcEnd - sc.startSec);
            if (relEnd > relStart + 0.08) {
              const cutStart = layout.cutStartSec + relStart;
              const cutEnd = layout.cutStartSec + relEnd;
              rawBuilt.push(
                createSubtitleItem(entry, cutStart, cutEnd, rawBuilt.length, {
                  sceneIndex: sc.index,
                  sceneId: sc.id,
                  sourceStartSec: sc.startSec + relStart,
                  sourceEndSec: sc.startSec + relEnd,
                })
              );
              fallbackCursor = Math.max(fallbackCursor, cutEnd);
            }
          }
        }
      } else {
        rawBuilt.push(createSubtitleItem(entry, srcStart, srcEnd, idx));
        fallbackCursor = Math.max(fallbackCursor, srcEnd);
      }
    } else {
      const remainingLines = Math.max(1, parsed.entries.length - idx);
      const remainingDur = Math.max(remainingLines * 1.5, targetDurationSec - fallbackCursor);
      const slot = Math.min(3.0, Math.max(1.2, remainingDur / remainingLines));
      const start = fallbackCursor;
      const end = start + slot;
      rawBuilt.push(createSubtitleItem(entry, start, end, idx));
      fallbackCursor = end;
    }
  });

  if (untimedCount > 0) {
    warnings.push(
      `${untimedCount} ${untimedCount === 1 ? "line had" : "lines had"} no timestamps and ${untimedCount === 1 ? "was" : "were"} paced sequentially.`
    );
  }
  if (mapSourceToCut && rawBuilt.length < parsed.entries.length) {
    const skipped = parsed.entries.length - rawBuilt.length;
    warnings.push(
      `${skipped} ${skipped === 1 ? "line fell" : "lines fell"} outside your selected timeline clip range.`
    );
  }

  rawBuilt.sort((a, b) => a.startTime - b.startTime);

  // Clean up any tiny timing overlaps while keeping exact start times intact
  const subtitles: SubtitleItem[] = rawBuilt.map((sub, i) => {
    const next = rawBuilt[i + 1];
    if (next && sub.endTime > next.startTime && next.startTime > sub.startTime + 0.15) {
      const adjustedEnd = Number(next.startTime.toFixed(3));
      const nextDur = Math.max(0.15, adjustedEnd - sub.startTime);
      const oldDur = Math.max(0.15, sub.endTime - sub.startTime);
      const ratio = nextDur / oldDur;
      return {
        ...sub,
        endTime: adjustedEnd,
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
    targetDurationSec: Math.max(targetDurationSec, Number(spanEndSec.toFixed(3))),
    timedCount,
    untimedCount,
    spanStartSec,
    spanEndSec,
    hasPhonetic: parsed.entries.some((e) => Boolean(e.thaiPhonetic?.trim())),
    hasThai: parsed.entries.some((e) => Boolean(e.thaiScript?.trim())),
    hasBurmese: parsed.entries.some((e) => Boolean(e.burmese?.trim())),
    hasWords: parsed.entries.some((e) => Boolean(e.words && e.words.length > 0)),
    warnings,
  };
}

