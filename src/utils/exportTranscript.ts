import type {
  TranscriptExportFormat,
  TranscriptResult,
  TranscriptSegment,
} from "../types";
import {
  downloadTextFile,
  formatSrtTimestamp,
  formatVttTimestamp,
  makeSafeFileSlug,
} from "./exportSubtitles";

function pad2(n: number): string {
  return String(Math.floor(Math.max(0, n))).padStart(2, "0");
}

export function formatTranscriptClock(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  if (hours > 0) {
    return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}`;
}

function formatLrcTimestamp(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe % 1) * 100);
  return `[${pad2(mins)}:${pad2(secs)}.${pad2(centis)}]`;
}

function escapeCsvCell(value: string | number): string {
  const str = String(value ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildTranscriptPlainText(result: TranscriptResult): string {
  if (result.segments.length > 0) {
    return result.segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .concat("\n");
  }
  return `${result.text.trim()}\n`;
}

export function buildTranscriptTimestampedText(result: TranscriptResult): string {
  const header = [
    result.title || "Transcript",
    `Model: ${result.modelLabel} · Language: ${result.language} · Duration: ${formatTranscriptClock(result.durationSec)}`,
    "=".repeat(48),
    "",
  ].join("\n");

  const body = result.segments
    .map(
      (seg) =>
        `[${formatTranscriptClock(seg.startSec)} – ${formatTranscriptClock(seg.endSec)}] ${seg.text.trim()}`
    )
    .join("\n");

  return `${header}${body}\n`;
}

export function buildTranscriptSrt(result: TranscriptResult): string {
  return result.segments
    .map((seg, idx) => {
      const start = Math.max(0, seg.startSec);
      const end = Math.max(start + 0.1, seg.endSec);
      return `${idx + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${seg.text.trim()}`;
    })
    .join("\n\n")
    .concat(result.segments.length > 0 ? "\n" : "");
}

export function buildTranscriptVtt(result: TranscriptResult): string {
  const body = result.segments
    .map((seg, idx) => {
      const start = Math.max(0, seg.startSec);
      const end = Math.max(start + 0.1, seg.endSec);
      return `${idx + 1}\n${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n${seg.text.trim()}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}${result.segments.length > 0 ? "\n" : ""}`;
}

export function buildTranscriptCsv(result: TranscriptResult): string {
  const rows: string[] = ["Index,Start,End,StartSeconds,EndSeconds,DurationSeconds,Text"];
  result.segments.forEach((seg, idx) => {
    const start = Math.max(0, seg.startSec);
    const end = Math.max(start + 0.1, seg.endSec);
    const dur = Math.max(0.1, end - start);
    rows.push(
      [
        idx + 1,
        escapeCsvCell(formatSrtTimestamp(start)),
        escapeCsvCell(formatSrtTimestamp(end)),
        start.toFixed(2),
        end.toFixed(2),
        dur.toFixed(2),
        escapeCsvCell(seg.text.trim()),
      ].join(",")
    );
  });
  return `\uFEFF${rows.join("\n")}\n`;
}

export function buildTranscriptJson(result: TranscriptResult): string {
  const payload = {
    title: result.title,
    modelId: result.modelId,
    modelLabel: result.modelLabel,
    language: result.language,
    durationSec: Number(result.durationSec.toFixed(2)),
    createdAt: new Date(result.createdAt).toISOString(),
    text: result.segments.map((s) => s.text.trim()).filter(Boolean).join(" "),
    segments: result.segments.map((seg: TranscriptSegment, idx: number) => ({
      index: idx + 1,
      startSec: Number(seg.startSec.toFixed(3)),
      endSec: Number(seg.endSec.toFixed(3)),
      text: seg.text.trim(),
      ...(seg.words && seg.words.length > 0
        ? {
            words: seg.words.map((w) => ({
              text: w.text,
              startSec: Number(w.startSec.toFixed(3)),
              endSec: Number(w.endSec.toFixed(3)),
            })),
          }
        : {}),
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function buildTranscriptMarkdown(result: TranscriptResult): string {
  const lines: string[] = [
    `# ${result.title || "Video Transcript"}`,
    "",
    `- **Model:** ${result.modelLabel}`,
    `- **Language:** ${result.language}`,
    `- **Duration:** ${formatTranscriptClock(result.durationSec)}`,
    `- **Segments:** ${result.segments.length}`,
    "",
    "## Transcript",
    "",
  ];

  for (const seg of result.segments) {
    lines.push(
      `- **\`${formatTranscriptClock(seg.startSec)} – ${formatTranscriptClock(seg.endSec)}\`** ${seg.text.trim()}`
    );
  }

  return `${lines.join("\n")}\n`;
}

export function buildTranscriptLrc(result: TranscriptResult): string {
  const header = `[ti:${result.title || "Transcript"}]\n[by:${result.modelLabel}]\n`;
  const body = result.segments
    .map((seg) => `${formatLrcTimestamp(seg.startSec)} ${seg.text.trim()}`)
    .join("\n");
  return `${header}${body}\n`;
}

export interface TranscriptExportFormatSpec {
  id: TranscriptExportFormat;
  label: string;
  ext: string;
  desc: string;
  mimeType: string;
}

export const TRANSCRIPT_EXPORT_FORMATS: TranscriptExportFormatSpec[] = [
  {
    id: "txt_plain",
    label: "Plain Text",
    ext: ".txt",
    desc: "Clean paragraph text",
    mimeType: "text/plain;charset=utf-8",
  },
  {
    id: "txt_timed",
    label: "Timed Text",
    ext: ".txt",
    desc: "[MM:SS] lines",
    mimeType: "text/plain;charset=utf-8",
  },
  {
    id: "srt",
    label: "SubRip",
    ext: ".srt",
    desc: "NLE / Video editors",
    mimeType: "application/x-subrip;charset=utf-8",
  },
  {
    id: "vtt",
    label: "WebVTT",
    ext: ".vtt",
    desc: "Web & HTML5 players",
    mimeType: "text/vtt;charset=utf-8",
  },
  {
    id: "csv",
    label: "Spreadsheet",
    ext: ".csv",
    desc: "Excel / Sheets (UTF-8)",
    mimeType: "text/csv;charset=utf-8",
  },
  {
    id: "json",
    label: "Structured",
    ext: ".json",
    desc: "Segments & word JSON",
    mimeType: "application/json;charset=utf-8",
  },
  {
    id: "md",
    label: "Markdown",
    ext: ".md",
    desc: "Notion / Obsidian notes",
    mimeType: "text/markdown;charset=utf-8",
  },
  {
    id: "lrc",
    label: "Synced LRC",
    ext: ".lrc",
    desc: "Audio / lyrics sync",
    mimeType: "text/plain;charset=utf-8",
  },
];

export function serializeTranscript(
  result: TranscriptResult,
  format: TranscriptExportFormat
): string {
  switch (format) {
    case "txt_plain":
      return buildTranscriptPlainText(result);
    case "txt_timed":
      return buildTranscriptTimestampedText(result);
    case "srt":
      return buildTranscriptSrt(result);
    case "vtt":
      return buildTranscriptVtt(result);
    case "csv":
      return buildTranscriptCsv(result);
    case "json":
      return buildTranscriptJson(result);
    case "md":
      return buildTranscriptMarkdown(result);
    case "lrc":
      return buildTranscriptLrc(result);
  }
}

export function downloadTranscriptExport(
  result: TranscriptResult,
  format: TranscriptExportFormat
): void {
  const spec = TRANSCRIPT_EXPORT_FORMATS.find((f) => f.id === format);
  if (!spec) return;
  const slug = makeSafeFileSlug(result.title || "transcript");
  const suffix = format === "txt_timed" ? "-timed" : "";
  const filename = `${slug}-transcript${suffix}${spec.ext}`;
  const content = serializeTranscript(result, format);
  downloadTextFile(filename, content, spec.mimeType);
}
