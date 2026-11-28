import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  FileAudio,
  FileUp,
  Languages,
  Loader2,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import type { SceneSelection, SubtitleGenerationProgress } from "../types";
import {
  buildAiChatFormatGuidePrompt,
  formatSrtTimestamp,
  SUPPORTED_TRANSCRIPT_FORMAT_EXAMPLE,
} from "../utils/exportSubtitles";
import {
  buildSubtitlesFromStructuredTranscript,
  hasStructuredTranscriptFieldLabels,
  type StructuredTranscriptImportResult,
} from "../utils/pasteTranscriptSync";
import { copyTextToClipboard } from "../utils/transcriptHistory";

export type ImportSrtMode = "translate" | "raw";

interface PreviewCue {
  startSec: number;
  endSec: number;
  text: string;
}

interface ImportSrtModalProps {
  isOpen: boolean;
  hasExistingSubtitles: boolean;
  existingSubtitleCount: number;
  hasVideo: boolean;
  selectedScenes: SceneSelection[];
  videoDurationSec: number;
  isImporting: boolean;
  isExportingAudio?: boolean;
  progress: SubtitleGenerationProgress | null;
  error: string | null;
  onImport: (srtContent: string, mode: ImportSrtMode, fileName?: string) => void;
  onImportStructured: (
    result: StructuredTranscriptImportResult,
    fileName?: string
  ) => void;
  onExportAudio?: () => void;
  onCancelImport?: () => void;
  onClose: () => void;
}

function parseTimestampSec(raw: string): number | null {
  const cleaned = raw.trim();
  const hms = cleaned.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const min = Number(hms[2]);
    const s = Number(hms[3]);
    const ms = hms[4] ? Number(hms[4].padEnd(3, "0")) : 0;
    return h * 3600 + min * 60 + s + ms / 1000;
  }
  const msShort = cleaned.match(/^(\d{1,3}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (msShort) {
    const min = Number(msShort[1]);
    const s = Number(msShort[2]);
    const ms = msShort[3] ? Number(msShort[3].padEnd(3, "0")) : 0;
    return min * 60 + s + ms / 1000;
  }
  return null;
}

function parsePreviewCues(content: string): PreviewCue[] {
  if (!content.trim()) return [];
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: PreviewCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const parts = lines[timeIdx].split("-->");
    if (parts.length < 2) continue;
    const startSec = parseTimestampSec(parts[0].trim().split(/\s+/)[0]);
    const endSec = parseTimestampSec(parts[1].trim().split(/\s+/)[0]);
    if (startSec === null || endSec === null || endSec <= startSec) continue;
    const text = lines
      .slice(timeIdx + 1)
      .map((l) => l.replace(/\{\\[^}]*\}/g, "").replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    cues.push({ startSec, endSec, text });
  }
  cues.sort((a, b) => a.startSec - b.startSec);
  return cues;
}

function formatClock(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function convertStructuredToSrt(result: StructuredTranscriptImportResult): string {
  return result.subtitles
    .map((sub, idx) => {
      const line =
        sub.thaiScript.trim() ||
        sub.thaiPhonetic.trim() ||
        sub.burmese.trim() ||
        sub.originalSpokenText.trim();
      return `${idx + 1}\n${formatSrtTimestamp(sub.startTime)} --> ${formatSrtTimestamp(
        sub.endTime
      )}\n${line}`;
    })
    .join("\n\n");
}

export function ImportSrtModal({
  isOpen,
  hasExistingSubtitles,
  existingSubtitleCount,
  hasVideo,
  selectedScenes,
  videoDurationSec,
  isImporting,
  isExportingAudio = false,
  progress,
  error,
  onImport,
  onImportStructured,
  onExportAudio,
  onCancelImport,
  onClose,
}: ImportSrtModalProps) {
  const [inputText, setInputText] = useState("");
  const [fileName, setFileName] = useState<string>("");
  const [mode, setMode] = useState<ImportSrtMode>("translate");
  const [structuredMode, setStructuredMode] = useState<"direct" | "translate">("direct");
  const [isDragging, setIsDragging] = useState(false);
  const [showFormatGuide, setShowFormatGuide] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isImporting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isImporting, onClose]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const hasStructuredLabels = useMemo(
    () => hasStructuredTranscriptFieldLabels(inputText),
    [inputText]
  );

  const parsedSrtCues = useMemo(
    () => (hasStructuredLabels ? [] : parsePreviewCues(inputText)),
    [inputText, hasStructuredLabels]
  );

  const parsedStructured = useMemo(() => {
    if (!inputText.trim() || parsedSrtCues.length > 0) return null;
    const res = buildSubtitlesFromStructuredTranscript(
      inputText,
      selectedScenes,
      videoDurationSec
    );
    return res.subtitles.length > 0 ? res : null;
  }, [inputText, parsedSrtCues.length, selectedScenes, videoDurationSec]);

  // Reset structuredMode to direct whenever Burmese is present
  useEffect(() => {
    if (parsedStructured?.hasBurmese) {
      setStructuredMode("direct");
    }
  }, [parsedStructured?.hasBurmese]);

  const detectedKind: "none" | "srt" | "structured" =
    parsedSrtCues.length > 0
      ? "srt"
      : parsedStructured && parsedStructured.subtitles.length > 0
        ? "structured"
        : "none";

  const srtSpanEndSec = useMemo(
    () => parsedSrtCues.reduce((max, c) => Math.max(max, c.endSec), 0),
    [parsedSrtCues]
  );

  if (!isOpen) return null;

  const flashCopied = (key: string) => {
    setCopiedKey(key);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 2000);
  };

  const handleCopyPrompt = async () => {
    setClipboardNotice(null);
    const ok = await copyTextToClipboard(buildAiChatFormatGuidePrompt());
    if (ok) {
      flashCopied("prompt");
    } else {
      setClipboardNotice("Could not copy automatically. Open Example Format to copy manually.");
    }
  };

  const handleCopyExampleOnly = async () => {
    setClipboardNotice(null);
    const ok = await copyTextToClipboard(SUPPORTED_TRANSCRIPT_FORMAT_EXAMPLE);
    if (ok) {
      flashCopied("example");
    }
  };

  const handlePasteClipboard = async () => {
    setClipboardNotice(null);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        setClipboardNotice("Press Ctrl/Cmd+V inside the text box below to paste.");
        textareaRef.current?.focus();
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardNotice("Clipboard is empty.");
        return;
      }
      setInputText(text);
      setFileName("");
    } catch {
      setClipboardNotice("Press Ctrl/Cmd+V directly inside the text box below.");
      textareaRef.current?.focus();
    }
  };

  const loadFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setInputText(text);
      setFileName(file.name);
      setClipboardNotice(null);
    } catch {
      // Ignore read errors
    }
  };

  const handleSubmit = () => {
    if (!hasVideo) return;
    if (detectedKind === "srt") {
      onImport(inputText, mode, fileName || undefined);
      return;
    }
    if (detectedKind === "structured" && parsedStructured) {
      if (!parsedStructured.hasBurmese && structuredMode === "translate") {
        const convertedSrt = convertStructuredToSrt(parsedStructured);
        onImport(convertedSrt, "translate", fileName || "transcript");
      } else {
        onImportStructured(parsedStructured, fileName || undefined);
      }
    }
  };

  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null;

  const detectedFieldLabels = parsedStructured
    ? [
        parsedStructured.hasPhonetic ? "Phonetic" : null,
        parsedStructured.hasThai ? "Thai" : null,
        parsedStructured.hasBurmese ? "Burmese" : null,
        parsedStructured.hasWords ? "Words" : null,
      ].filter((v): v is string => Boolean(v))
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-3 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isImporting) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Import Transcript or SRT"
    >
      <div className="w-full max-w-xl max-h-[92vh] flex flex-col rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-2xl overflow-hidden text-[#0c1026] dark:text-[#f3f5fc]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#11162e]">
          <div className="min-w-0">
            <h3 className="font-display text-sm font-semibold flex items-center gap-2">
              <FileUp className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
              <span>Import Transcript / .SRT</span>
            </h3>
            <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] mt-0.5">
              Paste a full timestamped AI transcript or drop a .SRT / .VTT file
            </p>
          </div>
          <button
            type="button"
            disabled={isImporting}
            onClick={onClose}
            aria-label="Close modal"
            className="h-8 w-8 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto studio-scrollbar px-4 py-3.5 space-y-3.5">
          {/* Quick External AI Workflow Strip */}
          <div className="rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/75 dark:bg-[#11162e]/85 p-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                External AI Chat Workflow
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {onExportAudio && hasVideo && (
                  <button
                    type="button"
                    disabled={isImporting || isExportingAudio}
                    onClick={onExportAudio}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                  >
                    {isExportingAudio ? (
                      <Loader2 className="w-3 h-3 animate-spin text-teal-700 dark:text-teal-400" />
                    ) : (
                      <FileAudio className="w-3 h-3 text-teal-700 dark:text-teal-400" />
                    )}
                    <span>{isExportingAudio ? "Exporting..." : "1. Export Audio (.mp3)"}</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => void handleCopyPrompt()}
                  className="h-7 px-2.5 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/80 dark:bg-teal-950/45 hover:bg-teal-100/80 dark:hover:bg-teal-900/55 text-[11px] font-semibold text-teal-800 dark:text-teal-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  {copiedKey === "prompt" ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      <span>Copied AI Prompt</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>2. Copy AI Format Prompt</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setShowFormatGuide((v) => !v)}
                  className={`h-7 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                    showFormatGuide
                      ? "border-indigo-500/60 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-800 dark:text-indigo-200"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  <BookOpen className="w-3 h-3" />
                  <span>{showFormatGuide ? "Hide Format" : "Example"}</span>
                </button>
              </div>
            </div>

            {showFormatGuide && (
              <div className="pt-2 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                    Supported formats: Structured Transcript blocks (instant, no AI needed) or .SRT / .VTT
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyExampleOnly()}
                    className="text-[10.5px] font-semibold text-teal-700 dark:text-teal-300 hover:underline inline-flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    {copiedKey === "example" ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Example</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#070814] text-[10.5px] font-mono-tabular leading-relaxed text-[#2c3556] dark:text-[#c7d1ef] whitespace-pre-wrap overflow-x-auto">
                  {SUPPORTED_TRANSCRIPT_FORMAT_EXAMPLE}
                </pre>
              </div>
            )}
          </div>

          {!hasVideo && (
            <div className="px-3 py-2 rounded-md border border-amber-300 dark:border-amber-700/70 bg-amber-50/80 dark:bg-amber-950/35 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Upload a local video on the 9:16 stage first before importing subtitles.</span>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/80 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {/* Paste Text Area (Primary for AI Chat workflow) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="import-srt-textarea"
                className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]"
              >
                3. Paste Transcript or .SRT / .VTT Content
              </label>
              <div className="flex items-center gap-1.5">
                {!isImporting && (
                  <button
                    type="button"
                    onClick={() => void handlePasteClipboard()}
                    className="h-6 px-2 rounded-xs border border-teal-600/40 dark:border-teal-400/40 bg-teal-50/70 dark:bg-teal-950/40 hover:bg-teal-100/80 text-[10.5px] font-semibold text-teal-800 dark:text-teal-200 inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <ClipboardPaste className="w-3 h-3" />
                    <span>Paste</span>
                  </button>
                )}
                {inputText.trim() && !isImporting && (
                  <button
                    type="button"
                    onClick={() => {
                      setInputText("");
                      setFileName("");
                      setClipboardNotice(null);
                    }}
                    className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <textarea
              ref={textareaRef}
              id="import-srt-textarea"
              rows={6}
              disabled={isImporting}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                if (clipboardNotice) setClipboardNotice(null);
              }}
              placeholder={`[01] 00:26 – 00:29\nPhonetic: phá-nák-ngaan-gà-dùk-nà\nThai:     พนักงานกะดึกน่ะ\nBurmese:  ညဂျူတီဝန်ထမ်းတွေပေါ့။\nWords:    phá-nák-ngaan (ဝန်ထမ်း) · gà-dùk (ညဂျူတီ)\n\n— or standard .SRT / .VTT —\n1\n00:00:01,200 --> 00:00:03,800\nสวัสดีครับ`}
              className="w-full px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#070814] text-xs font-mono-tabular leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#6d7a9e]/65 focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 resize-y disabled:opacity-50"
            />
            {clipboardNotice && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">{clipboardNotice}</p>
            )}
          </div>

          {/* Compact File Dropzone */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt,.txt,text/vtt,application/x-subrip,text/plain"
            className="hidden"
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!isImporting) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (isImporting) return;
              void loadFile(e.dataTransfer.files?.[0]);
            }}
            onClick={() => {
              if (!isImporting) fileInputRef.current?.click();
            }}
            className={`rounded-md border border-dashed px-3 py-2.5 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
              isDragging
                ? "border-teal-600 dark:border-teal-400 bg-teal-50/70 dark:bg-teal-950/40"
                : "border-[#bcc9e6] dark:border-[#2a335f] bg-[#f8faff] dark:bg-[#11162e]/75 hover:border-teal-600/60 dark:hover:border-teal-400/60"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Upload className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                  {fileName ? fileName : "Or choose / drop a .SRT, .VTT, or .TXT file"}
                </p>
                <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] truncate">
                  Works with CapCut, Whisper, TurboScribe, YouTube CC, or saved transcripts
                </p>
              </div>
            </div>
            <span className="text-[11px] font-semibold text-teal-700 dark:text-teal-300 shrink-0">
              Browse
            </span>
          </div>

          {/* Live Detection Preview */}
          {inputText.trim().length > 0 && (
            <div
              className={`rounded-md border px-3 py-2.5 text-xs space-y-2 ${
                detectedKind !== "none"
                  ? "border-teal-500/40 bg-teal-50/55 dark:bg-teal-950/25"
                  : "border-amber-400/50 bg-amber-50/70 dark:bg-amber-950/30"
              }`}
            >
              {detectedKind === "structured" && parsedStructured ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-teal-800 dark:text-teal-200 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {parsedStructured.subtitles.length} structured{" "}
                        {parsedStructured.subtitles.length === 1 ? "line" : "lines"} ready
                      </span>
                    </span>
                    <span className="font-mono-tabular text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                      {formatClock(parsedStructured.spanStartSec)} →{" "}
                      {formatClock(parsedStructured.spanEndSec)}
                      {detectedFieldLabels.length > 0
                        ? ` · ${detectedFieldLabels.join(" + ")}`
                        : ""}
                    </span>
                  </div>

                  {parsedStructured.warnings.length > 0 && (
                    <div className="text-[11px] text-amber-800 dark:text-amber-200 space-y-0.5">
                      {parsedStructured.warnings.map((w, i) => (
                        <p key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>{w}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="space-y-1.5 pt-1.5 border-t border-teal-600/15 dark:border-teal-400/15">
                    {parsedStructured.subtitles.slice(0, 3).map((sub, i) => (
                      <div key={i} className="space-y-0.5 text-[11px]">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono-tabular text-[10px] text-[#4d597d] dark:text-[#919ec4] shrink-0">
                            [{String(i + 1).padStart(2, "0")}] {formatClock(sub.startTime)}–
                            {formatClock(sub.endTime)}
                          </span>
                          <span className="truncate font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                            {sub.thaiPhonetic || sub.thaiScript || sub.burmese}
                          </span>
                        </div>
                        {(sub.burmese || sub.thaiScript) && (
                          <div className="pl-12 flex items-baseline gap-2 text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                            {sub.burmese && (
                              <span className="font-myanmar text-[#0c1026] dark:text-[#dbe4ff] truncate">
                                {sub.burmese}
                              </span>
                            )}
                            {sub.words.some((w) => w.burmeseGloss) && (
                              <span className="font-mono-tabular text-[10px] text-teal-700 dark:text-teal-300 shrink-0">
                                · {sub.words.filter((w) => w.burmeseGloss).length} words
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {parsedStructured.subtitles.length > 3 && (
                      <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                        + {parsedStructured.subtitles.length - 3} more lines
                      </p>
                    )}
                  </div>
                </>
              ) : detectedKind === "srt" ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-teal-800 dark:text-teal-200 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {parsedSrtCues.length}{" "}
                        {parsedSrtCues.length === 1 ? "SRT/VTT cue" : "SRT/VTT cues"} detected
                      </span>
                    </span>
                    <span className="font-mono-tabular text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                      0:00 → {formatClock(srtSpanEndSec)}
                    </span>
                  </div>
                  <div className="space-y-1 pt-1 border-t border-teal-600/15 dark:border-teal-400/15">
                    {parsedSrtCues.slice(0, 3).map((cue, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-2 text-[11px] text-[#0c1026] dark:text-[#e2e8f8]"
                      >
                        <span className="font-mono-tabular text-[10px] text-[#4d597d] dark:text-[#919ec4] shrink-0">
                          {formatClock(cue.startSec)}–{formatClock(cue.endSec)}
                        </span>
                        <span className="truncate font-myanmar">{cue.text}</span>
                      </div>
                    ))}
                    {parsedSrtCues.length > 3 && (
                      <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                        + {parsedSrtCues.length - 3} more cues
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-amber-800 dark:text-amber-200 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    No valid transcript blocks ([01] 00:01 – 00:04) or SRT timestamps detected yet.
                  </span>
                </p>
              )}
            </div>
          )}

          {/* Mode Selector: only shown for SRT/VTT or structured transcripts missing Burmese */}
          {detectedKind === "srt" && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]">
                Import Mode
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setMode("translate")}
                  className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    mode === "translate"
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    <Sparkles className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                    <span>Import &amp; Translate (AI)</span>
                  </div>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] mt-1 leading-snug">
                    Locks 100% exact SRT timings &amp; Thai text, and adds natural Burmese + phonetic guide.
                  </p>
                </button>

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setMode("raw")}
                  className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    mode === "raw"
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    <Languages className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span>Import Directly (No AI)</span>
                  </div>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] mt-1 leading-snug">
                    Instant load as-is without calling AI (ideal for pre-translated or Burmese SRT files).
                  </p>
                </button>
              </div>
            </div>
          )}

          {detectedKind === "structured" && parsedStructured && !parsedStructured.hasBurmese && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]">
                Burmese lines were not included — choose how to import:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setStructuredMode("direct")}
                  className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    structuredMode === "direct"
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    <Languages className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <span>Import Directly (Instant)</span>
                  </div>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] mt-1 leading-snug">
                    Load your timestamps and text immediately without calling AI.
                  </p>
                </button>
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setStructuredMode("translate")}
                  className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    structuredMode === "translate"
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    <Sparkles className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                    <span>Import &amp; Translate (AI)</span>
                  </div>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] mt-1 leading-snug">
                    Keep your timestamps and add natural Burmese translations via AI.
                  </p>
                </button>
              </div>
            </div>
          )}

          {hasExistingSubtitles && (
            <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
              Importing will replace your current {existingSubtitleCount} subtitle lines (you can undo anytime).
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#11162e] space-y-2">
          {isImporting ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium flex items-center gap-1.5 truncate">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-600 dark:text-teal-400 shrink-0" />
                  <span className="truncate">
                    {progress?.label || "Importing subtitles..."}
                  </span>
                </span>
                {pct !== null && (
                  <span className="font-mono-tabular font-semibold text-teal-700 dark:text-teal-300 shrink-0">
                    {pct}%
                  </span>
                )}
              </div>
              <div className="h-1.5 w-full rounded-xs bg-[#e7ecf8] dark:bg-[#1a2142] overflow-hidden">
                <div
                  className="h-full bg-teal-600 dark:bg-teal-400 transition-all duration-300"
                  style={{ width: `${pct ?? 18}%` }}
                />
              </div>
              {onCancelImport && (
                <button
                  type="button"
                  onClick={onCancelImport}
                  className="w-full h-9 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/75 dark:bg-red-950/35 hover:bg-red-100/80 text-xs font-semibold text-red-700 dark:text-red-300 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Cancel Import</span>
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-3.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!hasVideo || detectedKind === "none"}
                onClick={handleSubmit}
                className="h-9 px-4 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <FileUp className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {detectedKind === "structured" && parsedStructured
                    ? !parsedStructured.hasBurmese && structuredMode === "translate"
                      ? `Import & Translate (${parsedStructured.subtitles.length})`
                      : `Import Transcript (${parsedStructured.subtitles.length} lines)`
                    : mode === "translate"
                      ? `Import & Translate (${parsedSrtCues.length})`
                      : `Import Directly (${parsedSrtCues.length})`}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
