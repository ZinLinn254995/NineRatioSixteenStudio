import type { SubtitleItem } from "../types";

export interface SubtitleExportOptions {
  speed?: number;
  showThaiScript?: boolean;
  showWordGloss?: boolean;
  showBurmeseLine?: boolean;
}

function pad2(n: number): string {
  return String(Math.floor(Math.max(0, n))).padStart(2, "0");
}

function pad3(n: number): string {
  return String(Math.floor(Math.max(0, n))).padStart(3, "0");
}

export function formatSrtTimestamp(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)},${pad3(ms)}`;
}

export function formatVttTimestamp(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}.${pad3(ms)}`;
}

function formatClockSec(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${pad2(mins)}:${pad2(secs)}`;
}

function buildCueLines(sub: SubtitleItem, opts: SubtitleExportOptions): string[] {
  const lines: string[] = [];
  if (sub.thaiPhonetic.trim()) {
    lines.push(sub.thaiPhonetic.trim());
  }
  if (opts.showThaiScript && sub.thaiScript.trim()) {
    lines.push(sub.thaiScript.trim());
  }
  if (opts.showBurmeseLine !== false && sub.burmese.trim()) {
    lines.push(sub.burmese.trim());
  }
  if (lines.length === 0 && sub.originalSpokenText.trim()) {
    lines.push(sub.originalSpokenText.trim());
  }
  return lines;
}

export function buildSrtContent(
  subtitles: SubtitleItem[],
  opts: SubtitleExportOptions = {}
): string {
  const speed = Math.max(0.25, opts.speed ?? 1);
  return subtitles
    .map((sub, idx) => {
      const start = sub.startTime / speed;
      const end = Math.max(start + 0.1, sub.endTime / speed);
      const lines = buildCueLines(sub, opts);
      return `${idx + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${lines.join("\n")}`;
    })
    .join("\n\n")
    .concat(subtitles.length > 0 ? "\n" : "");
}

export function buildVttContent(
  subtitles: SubtitleItem[],
  opts: SubtitleExportOptions = {}
): string {
  const speed = Math.max(0.25, opts.speed ?? 1);
  const body = subtitles
    .map((sub, idx) => {
      const start = sub.startTime / speed;
      const end = Math.max(start + 0.1, sub.endTime / speed);
      const lines = buildCueLines(sub, opts);
      return `${idx + 1}\n${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n${lines.join("\n")}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}${subtitles.length > 0 ? "\n" : ""}`;
}

export function buildStudyTextContent(
  title: string,
  subtitles: SubtitleItem[],
  opts: SubtitleExportOptions = {}
): string {
  const speed = Math.max(0.25, opts.speed ?? 1);
  const header = `${title || "Thai - Burmese Study Subtitles"}\n${"=".repeat(42)}\n`;
  const entries = subtitles.map((sub, idx) => {
    const start = sub.startTime / speed;
    const end = Math.max(start + 0.1, sub.endTime / speed);
    const parts: string[] = [
      `[${String(idx + 1).padStart(2, "0")}] ${formatClockSec(start)} – ${formatClockSec(end)}`,
    ];
    if (sub.thaiPhonetic.trim()) parts.push(`Phonetic: ${sub.thaiPhonetic.trim()}`);
    if (opts.showThaiScript && sub.thaiScript.trim()) {
      parts.push(`Thai:     ${sub.thaiScript.trim()}`);
    }
    if (opts.showBurmeseLine !== false && sub.burmese.trim()) {
      parts.push(`Burmese:  ${sub.burmese.trim()}`);
    }
    if (opts.showWordGloss !== false && sub.words.some((w) => w.burmeseGloss?.trim())) {
      const vocab = sub.words
        .filter((w) => w.phonetic.trim() && w.burmeseGloss?.trim())
        .map((w) => `${w.phonetic.trim()} (${w.burmeseGloss!.trim()})`)
        .join(" · ");
      if (vocab) parts.push(`Words:    ${vocab}`);
    }
    return parts.join("\n");
  });

  return `${header}\n${entries.join("\n\n")}\n`;
}

export function buildAiChatTranscriptContent(
  title: string,
  subtitles: SubtitleItem[],
  opts: SubtitleExportOptions = {}
): string {
  const speed = Math.max(0.25, opts.speed ?? 1);
  const instruction = [
    "Please improve the Burmese translations, Thai phonetics, Thai script, and word glosses below.",
    "IMPORTANT: Keep every [index] number (such as [01], [02]) and field label (Phonetic:, Thai:, Burmese:, Words:) intact and in order so I can paste the result back into my editor.",
  ].join("\n");
  const header = `${instruction}\n\nTitle: ${title || "Thai - Burmese Study Subtitles"}\n${"=".repeat(42)}\n`;

  const entries = subtitles.map((sub, idx) => {
    const start = sub.startTime / speed;
    const end = Math.max(start + 0.1, sub.endTime / speed);
    const parts: string[] = [
      `[${String(idx + 1).padStart(2, "0")}] ${formatClockSec(start)} – ${formatClockSec(end)}`,
      `Phonetic: ${sub.thaiPhonetic.trim()}`,
      `Thai:     ${sub.thaiScript.trim()}`,
      `Burmese:  ${sub.burmese.trim()}`,
    ];
    if (Array.isArray(sub.words) && sub.words.length > 0) {
      const vocab = sub.words
        .filter((w) => w.phonetic.trim())
        .map((w) => `${w.phonetic.trim()} (${(w.burmeseGloss || "").trim()})`)
        .join(" · ");
      if (vocab) {
        parts.push(`Words:    ${vocab}`);
      }
    }
    return parts.join("\n");
  });

  return `${header}\n${entries.join("\n\n")}\n`;
}

export function makeSafeFileSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "subtitles"
  );
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8"
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
