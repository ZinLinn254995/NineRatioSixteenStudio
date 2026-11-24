import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Copy,
  Eraser,
  RefreshCw,
  X,
} from "lucide-react";
import type { SubtitleItem } from "../types";
import type { SubtitleExportOptions } from "../utils/exportSubtitles";
import { buildAiChatTranscriptContent } from "../utils/exportSubtitles";
import {
  computeTranscriptSyncPreview,
  type ParsedTranscriptMode,
} from "../utils/pasteTranscriptSync";

interface PasteTranscriptModalProps {
  isOpen: boolean;
  projectTitle: string;
  subtitles: SubtitleItem[];
  exportOpts: SubtitleExportOptions;
  onClose: () => void;
  onApplySync: (nextSubtitles: SubtitleItem[], changedCount: number) => void;
}

function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatModeLabel(mode: ParsedTranscriptMode): string {
  switch (mode) {
    case "structured":
      return "Structured blocks";
    case "numbered_lines":
      return "Numbered lines";
    case "plain_lines":
      return "Plain lines";
    default:
      return "Waiting for input";
  }
}

export function PasteTranscriptModal({
  isOpen,
  projectTitle,
  subtitles,
  exportOpts,
  onClose,
  onApplySync,
}: PasteTranscriptModalProps) {
  const [rawText, setRawText] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "changed">("all");
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const speed = Math.max(0.25, exportOpts.speed ?? 1);

  const preview = useMemo(
    () => computeTranscriptSyncPreview(subtitles, rawText),
    [subtitles, rawText]
  );

  useEffect(() => {
    if (!isOpen) return;
    setClipboardError(null);
    setCopiedPrompt(false);
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const displayedRows =
    filterMode === "changed"
      ? preview.rows.filter((r) => r.changed)
      : preview.rows;

  const handlePasteClipboard = async () => {
    setClipboardError(null);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        setClipboardError("Clipboard read is not supported in this browser. Press Ctrl/Cmd+V inside the box.");
        textareaRef.current?.focus();
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardError("Clipboard is empty.");
        return;
      }
      setRawText(text);
    } catch {
      setClipboardError("Clipboard access was blocked. Press Ctrl/Cmd+V directly inside the text box.");
      textareaRef.current?.focus();
    }
  };

  const handleCopyPrompt = async () => {
    setClipboardError(null);
    try {
      await navigator.clipboard.writeText(
        buildAiChatTranscriptContent(projectTitle, subtitles, exportOpts)
      );
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      setClipboardError("Could not write to clipboard. Use Export → Copy for AI Chat.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-3 sm:p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-sync-modal-title"
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-2xl overflow-hidden text-[#0c1026] dark:text-[#f3f5fc]">
        {/* Header */}
        <div className="shrink-0 px-5 py-3.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/80 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="paste-sync-modal-title"
              className="font-display text-base font-semibold tracking-tight truncate"
            >
              Paste &amp; Sync Transcript
            </h2>
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4] mt-0.5">
              Update translations, phonetics, Thai script, and word glosses while keeping existing timing offsets intact.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Paste & Sync dialog"
            className="h-8 w-8 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center shrink-0 cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto studio-scrollbar p-5 space-y-4">
          {/* Input Controls */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="paste-sync-textarea"
                className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]"
              >
                Edited transcript from AI chat or text editor
              </label>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  disabled={subtitles.length === 0}
                  className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-emerald-700 dark:text-emerald-300">Copied Prompt</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                      <span>Copy Current for AI</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  className="h-7 px-2.5 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/70 dark:bg-teal-950/40 hover:bg-teal-100/80 dark:hover:bg-teal-900/50 text-[11px] font-medium text-teal-800 dark:text-teal-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <ClipboardPaste className="w-3 h-3" />
                  <span>Paste from Clipboard</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setRawText("");
                    setClipboardError(null);
                    textareaRef.current?.focus();
                  }}
                  disabled={!rawText}
                  className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Eraser className="w-3 h-3" />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <textarea
              ref={textareaRef}
              id="paste-sync-textarea"
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                if (clipboardError) setClipboardError(null);
              }}
              rows={7}
              spellCheck={false}
              placeholder={`Paste structured blocks:\n[01] 00:01 – 00:04\nPhonetic: sa-wat-dee khrap\nThai:     สวัสดีครับ\nBurmese:  မင်္ဂလာပါခင်ဗျာ\nWords:    sa-wat-dee (မင်္ဂလာပါ) · khrap (ခင်ဗျာ)\n\nOr numbered / plain lines:\n[1] မင်္ဂလာပါခင်ဗျာ`}
              className="w-full p-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/50 dark:bg-[#070814] text-xs font-mono-tabular leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d]/70 dark:placeholder:text-[#919ec4]/60 focus:outline-none focus:border-teal-700 dark:focus:border-teal-400 resize-y"
            />

            {clipboardError && (
              <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{clipboardError}</span>
              </p>
            )}
          </div>

          {/* Live Summary & Warning */}
          <div className="pt-2 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#4d597d] dark:text-[#919ec4]">
                <span className="font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                  {formatModeLabel(preview.parsed.mode)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">
                  Matched {preview.matchedCount}/{subtitles.length}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  className={`font-mono-tabular font-medium ${
                    preview.changedCount > 0
                      ? "text-emerald-700 dark:text-emerald-300"
                      : ""
                  }`}
                >
                  {preview.changedCount} changed
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">
                  {preview.unchangedCount} unchanged
                </span>
              </div>

              {rawText.trim() && subtitles.length > 0 && (
                <div className="inline-flex items-center p-0.5 rounded-sm bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]">
                  <button
                    type="button"
                    onClick={() => setFilterMode("all")}
                    className={`px-2.5 py-0.5 rounded-xs text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                      filterMode === "all"
                        ? "bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] shadow-xs"
                        : "text-[#4d597d] dark:text-[#919ec4]"
                    }`}
                  >
                    All ({preview.rows.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterMode("changed")}
                    className={`px-2.5 py-0.5 rounded-xs text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                      filterMode === "changed"
                        ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 shadow-xs"
                        : "text-[#4d597d] dark:text-[#919ec4]"
                    }`}
                  >
                    Changed ({preview.changedCount})
                  </button>
                </div>
              )}
            </div>

            {(preview.countMismatch || preview.warnings.length > 0) && (
              <div className="px-3 py-2.5 rounded-md border border-amber-300 dark:border-amber-700/70 bg-amber-50/80 dark:bg-amber-950/35 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                {preview.countMismatch && (
                  <div className="flex items-start gap-2 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
                    <span>
                      Line count differs: pasted{" "}
                      <span className="font-mono-tabular font-semibold">
                        {preview.parsed.entries.length}
                      </span>{" "}
                      {preview.parsed.entries.length === 1 ? "entry" : "entries"} for{" "}
                      <span className="font-mono-tabular font-semibold">
                        {subtitles.length}
                      </span>{" "}
                      existing subtitles. Review index alignment below before applying.
                    </span>
                  </div>
                )}
                {preview.warnings.map((w, wi) => (
                  <div key={wi} className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Index Alignment & Diff Preview List */}
            {subtitles.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md">
                Generate or add subtitles first before syncing an edited transcript.
              </div>
            ) : !rawText.trim() ? (
              <div className="py-6 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md">
                Paste edited text above to preview line-by-line index alignment and diffs.
              </div>
            ) : displayedRows.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md">
                No changed lines detected between pasted text and current subtitles.
              </div>
            ) : (
              <div className="border border-[#d2dcf0] dark:border-[#21284c] rounded-md divide-y divide-[#d2dcf0] dark:divide-[#21284c] max-h-64 overflow-y-auto studio-scrollbar bg-[#f3f5fc]/30 dark:bg-[#070814]/40">
                {displayedRows.map((row) => {
                  const startDisplay = formatClock(row.startTime / speed);
                  const endDisplay = formatClock(
                    Math.max(row.startTime / speed + 0.1, row.endTime / speed)
                  );
                  return (
                    <div
                      key={row.subtitleId}
                      className={`px-3 py-2 text-xs space-y-1.5 ${
                        row.changed
                          ? "bg-white dark:bg-[#0d1022]"
                          : "bg-transparent opacity-80"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 font-mono-tabular text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                          <span className="font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                            [{String(row.lineNumber).padStart(2, "0")}]
                          </span>
                          <span>
                            {startDisplay} – {endDisplay}
                          </span>
                        </div>

                        {row.changed ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                            <Check className="w-3 h-3" />
                            <span>
                              Updated ({row.changedFields.join(", ")})
                            </span>
                          </span>
                        ) : row.matched ? (
                          <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                            Unchanged
                          </span>
                        ) : (
                          <span className="text-[11px] text-amber-700 dark:text-amber-300">
                            Not in paste (kept)
                          </span>
                        )}
                      </div>

                      {row.changed ? (
                        <div className="space-y-1 text-[11px]">
                          {row.changedFields.includes("thaiPhonetic") && (
                            <div className="grid grid-cols-[64px_1fr] gap-2">
                              <span className="text-[#4d597d] dark:text-[#919ec4]">Phonetic</span>
                              <div className="min-w-0 space-y-0.5">
                                <p className="text-[#4d597d] dark:text-[#919ec4] line-through truncate">
                                  {row.before.thaiPhonetic || "—"}
                                </p>
                                <p className="text-[#0c1026] dark:text-[#f3f5fc] font-medium break-words">
                                  {row.after.thaiPhonetic}
                                </p>
                              </div>
                            </div>
                          )}
                          {row.changedFields.includes("thaiScript") && (
                            <div className="grid grid-cols-[64px_1fr] gap-2">
                              <span className="text-[#4d597d] dark:text-[#919ec4]">Thai</span>
                              <div className="min-w-0 space-y-0.5">
                                <p className="text-[#4d597d] dark:text-[#919ec4] line-through truncate">
                                  {row.before.thaiScript || "—"}
                                </p>
                                <p className="text-[#0c1026] dark:text-[#f3f5fc] font-medium break-words">
                                  {row.after.thaiScript}
                                </p>
                              </div>
                            </div>
                          )}
                          {row.changedFields.includes("burmese") && (
                            <div className="grid grid-cols-[64px_1fr] gap-2">
                              <span className="text-[#4d597d] dark:text-[#919ec4]">Burmese</span>
                              <div className="min-w-0 space-y-0.5">
                                <p className="font-myanmar text-[#4d597d] dark:text-[#919ec4] line-through truncate">
                                  {row.before.burmese || "—"}
                                </p>
                                <p className="font-myanmar text-[#0c1026] dark:text-[#f3f5fc] font-medium break-words">
                                  {row.after.burmese}
                                </p>
                              </div>
                            </div>
                          )}
                          {row.changedFields.includes("words") && (
                            <div className="grid grid-cols-[64px_1fr] gap-2">
                              <span className="text-[#4d597d] dark:text-[#919ec4]">Words</span>
                              <p className="text-[#0c1026] dark:text-[#f3f5fc] break-words">
                                {row.after.words
                                  .map((w) =>
                                    w.burmeseGloss
                                      ? `${w.phonetic} (${w.burmeseGloss})`
                                      : w.phonetic
                                  )
                                  .join(" · ")}
                              </p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] truncate font-myanmar">
                          {row.before.thaiPhonetic}
                          {row.before.burmese ? ` · ${row.before.burmese}` : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 border-t border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/80 flex items-center justify-between gap-3">
          <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
            Existing start/end times and word timing offsets stay locked.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer whitespace-nowrap transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={preview.changedCount === 0}
              onClick={() => {
                onApplySync(preview.nextSubtitles, preview.changedCount);
                onClose();
              }}
              className="h-8 px-4 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>
                {preview.changedCount > 0
                  ? `Apply Sync (${preview.changedCount})`
                  : "Apply Sync"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
