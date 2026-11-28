import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Eye,
  FileText,
  History,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { SubtitleItem } from "../types";
import type { SubtitleExportOptions } from "../utils/exportSubtitles";
import {
  buildAiChatFormatGuidePrompt,
  buildAiChatTranscriptContent,
  buildFullTranscriptContent,
} from "../utils/exportSubtitles";
import {
  computeTranscriptSyncPreview,
  type ParsedTranscriptMode,
} from "../utils/pasteTranscriptSync";
import {
  clearTranscriptVersions,
  copyTextToClipboard,
  deleteTranscriptVersion,
  loadTranscriptVersions,
  renameTranscriptVersion,
  saveTranscriptVersion,
  type TranscriptVersion,
} from "../utils/transcriptHistory";

interface PasteTranscriptModalProps {
  isOpen: boolean;
  projectKey?: string;
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

function formatTimestamp(ms: number): string {
  try {
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function getPreviewSnippet(subtitles: SubtitleItem[]): string {
  const first = subtitles.find(
    (s) => s.burmese.trim() || s.thaiPhonetic.trim() || s.thaiScript.trim()
  );
  if (!first) return "Empty transcript";
  const parts = [first.thaiPhonetic.trim(), first.burmese.trim()].filter(Boolean);
  const joined = parts.join(" · ");
  return joined.length > 96 ? `${joined.slice(0, 95)}…` : joined;
}

export function PasteTranscriptModal({
  isOpen,
  projectKey,
  projectTitle,
  subtitles,
  exportOpts,
  onClose,
  onApplySync,
}: PasteTranscriptModalProps) {
  const [activeTab, setActiveTab] = useState<"compare" | "versions">("compare");
  const [rawText, setRawText] = useState("");
  const [showOldPreview, setShowOldPreview] = useState(false);
  const [excludedSubtitleIds, setExcludedSubtitleIds] = useState<Set<string>>(
    () => new Set()
  );
  const [filterMode, setFilterMode] = useState<"all" | "changed">("all");
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<TranscriptVersion[]>([]);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [versionNotice, setVersionNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const effectiveProjectKey = projectKey || projectTitle || "default-project";
  const speed = Math.max(0.25, exportOpts.speed ?? 1);

  const currentTranscriptText = useMemo(
    () => buildFullTranscriptContent(projectTitle, subtitles, exportOpts),
    [projectTitle, subtitles, exportOpts]
  );

  const preview = useMemo(
    () => computeTranscriptSyncPreview(subtitles, rawText),
    [subtitles, rawText]
  );

  const changedRows = useMemo(
    () => preview.rows.filter((r) => r.changed),
    [preview.rows]
  );

  const selectedChangedCount = useMemo(
    () =>
      changedRows.filter((r) => !excludedSubtitleIds.has(r.subtitleId)).length,
    [changedRows, excludedSubtitleIds]
  );

  const keptOldCount = changedRows.length - selectedChangedCount;

  useEffect(() => {
    if (!isOpen) return;
    setClipboardError(null);
    setCopiedKey(null);
    setConfirmRestoreId(null);
    setConfirmClearHistory(false);
    setEditingVersionId(null);
    setVersionNotice(null);
    setVersions(loadTranscriptVersions(effectiveProjectKey));

    const raf = requestAnimationFrame(() => {
      if (activeTab === "compare") {
        textareaRef.current?.focus();
      }
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
  }, [isOpen, effectiveProjectKey, onClose, activeTab]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const flashCopied = (key: string) => {
    setCopiedKey(key);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const flashVersionNotice = (msg: string) => {
    setVersionNotice(msg);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setVersionNotice(null);
    }, 2400);
  };

  const handleCopyText = async (text: string, key: string) => {
    setClipboardError(null);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      flashCopied(key);
    } else {
      setClipboardError("Could not copy to clipboard in this browser.");
    }
  };

  const handlePasteClipboard = async () => {
    setClipboardError(null);
    try {
      if (
        !navigator.clipboard ||
        typeof navigator.clipboard.readText !== "function"
      ) {
        setClipboardError(
          "Clipboard read is not supported in this browser. Press Ctrl/Cmd+V inside the box."
        );
        textareaRef.current?.focus();
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardError("Clipboard is empty.");
        return;
      }
      setRawText(text);
      setExcludedSubtitleIds(new Set());
    } catch {
      setClipboardError(
        "Clipboard access was blocked. Press Ctrl/Cmd+V directly inside the text box."
      );
      textareaRef.current?.focus();
    }
  };

  const handleLoadOldIntoEditor = () => {
    if (!currentTranscriptText) return;
    setClipboardError(null);
    setRawText(currentTranscriptText);
    setExcludedSubtitleIds(new Set());
    setActiveTab("compare");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const toggleRowSelection = (subtitleId: string) => {
    setExcludedSubtitleIds((prev) => {
      const next = new Set(prev);
      if (next.has(subtitleId)) {
        next.delete(subtitleId);
      } else {
        next.add(subtitleId);
      }
      return next;
    });
  };

  const handleSelectAllNew = () => {
    setExcludedSubtitleIds(new Set());
  };

  const handleKeepAllOld = () => {
    setExcludedSubtitleIds(new Set(changedRows.map((r) => r.subtitleId)));
  };

  const handleApplySelected = () => {
    if (selectedChangedCount <= 0) return;

    const finalSubtitles = preview.rows.map((row) =>
      row.changed && !excludedSubtitleIds.has(row.subtitleId)
        ? row.after
        : row.before
    );

    // Automatically save Old transcript before applying, and save the New applied version
    if (currentTranscriptText.trim()) {
      saveTranscriptVersion(effectiveProjectKey, {
        label: "Old · Before Update",
        kind: "old",
        lineCount: subtitles.length,
        text: currentTranscriptText,
        previewLine: getPreviewSnippet(subtitles),
      });
    }

    const nextText = buildFullTranscriptContent(
      projectTitle,
      finalSubtitles,
      exportOpts
    );
    const updatedList = saveTranscriptVersion(effectiveProjectKey, {
      label: `New · Applied (${selectedChangedCount} updated)`,
      kind: "new",
      lineCount: finalSubtitles.length,
      changedCount: selectedChangedCount,
      text: nextText,
      previewLine: getPreviewSnippet(finalSubtitles),
    });
    setVersions(updatedList);

    onApplySync(finalSubtitles, selectedChangedCount);
    onClose();
  };

  const handleSaveManualBackup = () => {
    if (!currentTranscriptText.trim()) return;
    const next = saveTranscriptVersion(effectiveProjectKey, {
      label: "Saved Snapshot",
      kind: "backup",
      lineCount: subtitles.length,
      text: currentTranscriptText,
      previewLine: getPreviewSnippet(subtitles),
    });
    setVersions(next);
    flashVersionNotice("Saved current transcript snapshot.");
  };

  const handleCompareVersion = (version: TranscriptVersion) => {
    setRawText(version.text);
    setExcludedSubtitleIds(new Set());
    setFilterMode("changed");
    setActiveTab("compare");
    setConfirmRestoreId(null);
  };

  const handleRestoreVersion = (version: TranscriptVersion) => {
    const restorePreview = computeTranscriptSyncPreview(subtitles, version.text);
    if (restorePreview.changedCount === 0) {
      setConfirmRestoreId(null);
      flashVersionNotice("This version already matches the current live transcript.");
      return;
    }

    if (confirmRestoreId !== version.id) {
      setConfirmRestoreId(version.id);
      return;
    }

    if (currentTranscriptText.trim()) {
      const updated = saveTranscriptVersion(effectiveProjectKey, {
        label: "Old · Before Restore",
        kind: "old",
        lineCount: subtitles.length,
        text: currentTranscriptText,
        previewLine: getPreviewSnippet(subtitles),
      });
      setVersions(updated);
    }

    setConfirmRestoreId(null);
    onApplySync(restorePreview.nextSubtitles, restorePreview.changedCount);
    onClose();
  };

  const handleCommitRename = (versionId: string) => {
    const updated = renameTranscriptVersion(
      effectiveProjectKey,
      versionId,
      editingLabel
    );
    setVersions(updated);
    setEditingVersionId(null);
    setEditingLabel("");
  };

  const handleDeleteVersion = (versionId: string) => {
    const updated = deleteTranscriptVersion(effectiveProjectKey, versionId);
    setVersions(updated);
    if (confirmRestoreId === versionId) setConfirmRestoreId(null);
    if (expandedVersionId === versionId) setExpandedVersionId(null);
  };

  const handleClearAllVersions = () => {
    if (!confirmClearHistory) {
      setConfirmClearHistory(true);
      return;
    }
    setVersions(clearTranscriptVersions(effectiveProjectKey));
    setConfirmClearHistory(false);
    flashVersionNotice("Cleared saved transcript history.");
  };

  const displayedRows =
    filterMode === "changed" ? changedRows : preview.rows;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-2.5 sm:p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-sync-modal-title"
    >
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-2xl overflow-hidden text-[#0c1026] dark:text-[#f3f5fc]">
        {/* Header */}
        <div className="shrink-0 px-4 sm:px-5 pt-3.5 pb-3 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/85 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="paste-sync-modal-title"
                className="font-display text-sm sm:text-base font-semibold tracking-tight truncate"
              >
                Transcript Manager
              </h2>
              <p className="text-[11px] sm:text-xs text-[#4d597d] dark:text-[#919ec4] mt-0.5">
                Compare old &amp; new transcripts, pick lines to update, or restore previous versions while keeping timing locked.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Transcript Manager dialog"
              className="h-8 w-8 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center shrink-0 cursor-pointer transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Mode Tabs */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-md bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]">
            <button
              type="button"
              onClick={() => setActiveTab("compare")}
              className={`h-8 px-3 rounded-sm text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                activeTab === "compare"
                  ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 shadow-xs"
                  : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
              <span>New vs Old</span>
              {preview.changedCount > 0 && (
                <span className="font-mono-tabular text-[10px] px-1.5 py-0.5 rounded-xs bg-teal-600/15 dark:bg-teal-400/20 text-teal-800 dark:text-teal-200">
                  {preview.changedCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("versions")}
              className={`h-8 px-3 rounded-sm text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                activeTab === "versions"
                  ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 shadow-xs"
                  : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
              }`}
            >
              <History className="w-3.5 h-3.5 shrink-0" />
              <span>Saved Versions</span>
              <span className="font-mono-tabular text-[10px] px-1.5 py-0.5 rounded-xs bg-[#d2dcf0]/70 dark:bg-[#21284c] text-[#4d597d] dark:text-[#919ec4]">
                {versions.length}
              </span>
            </button>
          </div>
        </div>

        {/* Body */}
        {activeTab === "compare" ? (
          <div className="flex-1 min-h-0 overflow-y-auto studio-scrollbar p-4 sm:p-5 space-y-4">
            {/* New Transcript Editor */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <label
                    htmlFor="paste-sync-textarea"
                    className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]"
                  >
                    New Transcript
                  </label>
                  <button
                    type="button"
                    disabled={subtitles.length === 0}
                    onClick={() => setShowOldPreview((prev) => !prev)}
                    className={`h-6 px-2 rounded-xs border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 transition-colors ${
                      showOldPreview
                        ? "border-indigo-500/60 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-200"
                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    <span>{showOldPreview ? "Hide Old" : "View Old"}</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handlePasteClipboard}
                    className="h-7 px-2.5 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/75 dark:bg-teal-950/45 hover:bg-teal-100/80 dark:hover:bg-teal-900/55 text-[11px] font-medium text-teal-800 dark:text-teal-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    <ClipboardPaste className="w-3 h-3" />
                    <span>Paste</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleLoadOldIntoEditor}
                    disabled={subtitles.length === 0}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    <FileText className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                    <span>Load Old</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleCopyText(currentTranscriptText, "old")}
                    disabled={subtitles.length === 0}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    {copiedKey === "old" ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-emerald-700 dark:text-emerald-300">
                          Copied Old
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                        <span>Copy Old</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        buildAiChatTranscriptContent(
                          projectTitle,
                          subtitles,
                          exportOpts
                        ),
                        "ai"
                      )
                    }
                    disabled={subtitles.length === 0}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    {copiedKey === "ai" ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-emerald-700 dark:text-emerald-300">
                          Copied AI Prompt
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy for AI</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(buildAiChatFormatGuidePrompt(), "format-guide")
                    }
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    {copiedKey === "format-guide" ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-emerald-700 dark:text-emerald-300">
                          Copied Format
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy AI Format</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setRawText("");
                      setExcludedSubtitleIds(new Set());
                      setClipboardError(null);
                      textareaRef.current?.focus();
                    }}
                    disabled={!rawText}
                    className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Eraser className="w-3 h-3" />
                    <span>Clear</span>
                  </button>
                </div>
              </div>

              {/* Optional Collapsible Current (Old) Transcript Reference */}
              {showOldPreview && (
                <div className="rounded-md border border-indigo-200/80 dark:border-indigo-800/60 bg-indigo-50/40 dark:bg-indigo-950/25 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-indigo-900 dark:text-indigo-200">
                      Current (Old) Transcript · {subtitles.length} lines
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyText(currentTranscriptText, "old-preview")
                      }
                      className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300 hover:underline inline-flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === "old-preview" ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="max-h-36 overflow-y-auto studio-scrollbar text-[11px] font-mono-tabular leading-relaxed text-[#2c3556] dark:text-[#c7d1ef] whitespace-pre-wrap break-words bg-white/80 dark:bg-[#070814]/80 p-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c]">
                    {currentTranscriptText || "No current subtitles."}
                  </pre>
                </div>
              )}

              <textarea
                ref={textareaRef}
                id="paste-sync-textarea"
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  if (clipboardError) setClipboardError(null);
                }}
                rows={6}
                spellCheck={false}
                placeholder={`Paste edited transcript here:\n[01] 00:01 – 00:04\nPhonetic: sa-wat-dee khrap\nThai:     สวัสดีครับ\nBurmese:  မင်္ဂလာပါခင်ဗျာ\nWords:    sa-wat-dee (မင်္ဂလာပါ) · khrap (ခင်ဗျာ)\n\nOr numbered / plain lines:\n[1] မင်္ဂလာပါခင်ဗျာ`}
                className="w-full p-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/50 dark:bg-[#070814] text-xs font-mono-tabular leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d]/70 dark:placeholder:text-[#919ec4]/60 focus:outline-none focus:border-teal-700 dark:focus:border-teal-400 resize-y"
              />

              {clipboardError && (
                <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{clipboardError}</span>
                </p>
              )}
            </div>

            {/* Old vs New Diff Summary & Per-Line Controls */}
            <div className="pt-2.5 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#4d597d] dark:text-[#919ec4]">
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
                  {preview.changedCount > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono-tabular text-teal-700 dark:text-teal-300 font-medium">
                        {selectedChangedCount} using new
                      </span>
                      {keptOldCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono-tabular text-amber-700 dark:text-amber-300">
                            {keptOldCount} keeping old
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>

                {rawText.trim() && subtitles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {preview.changedCount > 0 && (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleSelectAllNew}
                          disabled={selectedChangedCount === changedRows.length}
                          className="h-6 px-2 rounded-xs border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer disabled:opacity-40 transition-colors"
                        >
                          Use All New
                        </button>
                        <button
                          type="button"
                          onClick={handleKeepAllOld}
                          disabled={selectedChangedCount === 0}
                          className="h-6 px-2 rounded-xs border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-amber-600/50 dark:hover:border-amber-400/50 text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] cursor-pointer disabled:opacity-40 transition-colors"
                        >
                          Keep All Old
                        </button>
                      </div>
                    )}

                    <div className="inline-flex items-center p-0.5 rounded-sm bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]">
                      <button
                        type="button"
                        onClick={() => setFilterMode("all")}
                        className={`px-2 py-0.5 rounded-xs text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
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
                        className={`px-2 py-0.5 rounded-xs text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                          filterMode === "changed"
                            ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 shadow-xs"
                            : "text-[#4d597d] dark:text-[#919ec4]"
                        }`}
                      >
                        Changed ({preview.changedCount})
                      </button>
                    </div>
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
                        {preview.parsed.entries.length === 1
                          ? "entry"
                          : "entries"}{" "}
                        for{" "}
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

              {/* Diff Preview List */}
              {subtitles.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md">
                  Generate or add subtitles first before managing transcripts.
                </div>
              ) : !rawText.trim() ? (
                <div className="py-6 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md px-4">
                  Paste a new transcript above or click <span className="font-medium text-[#0c1026] dark:text-[#f3f5fc]">Load Old</span> to edit and compare line-by-line against your current transcript.
                </div>
              ) : displayedRows.length === 0 ? (
                <div className="py-6 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md">
                  No differences detected between the new transcript and the current old transcript.
                </div>
              ) : (
                <div className="border border-[#d2dcf0] dark:border-[#21284c] rounded-md divide-y divide-[#d2dcf0] dark:divide-[#21284c] max-h-72 overflow-y-auto studio-scrollbar bg-[#f3f5fc]/30 dark:bg-[#070814]/40">
                  {displayedRows.map((row) => {
                    const startDisplay = formatClock(row.startTime / speed);
                    const endDisplay = formatClock(
                      Math.max(row.startTime / speed + 0.1, row.endTime / speed)
                    );
                    const isUsingNew =
                      row.changed && !excludedSubtitleIds.has(row.subtitleId);

                    return (
                      <div
                        key={row.subtitleId}
                        className={`px-3 py-2.5 text-xs space-y-1.5 transition-colors ${
                          row.changed
                            ? isUsingNew
                              ? "bg-white dark:bg-[#0d1022]"
                              : "bg-amber-50/40 dark:bg-amber-950/15"
                            : "bg-transparent opacity-75"
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
                            {row.changed && (
                              <span className="hidden sm:inline text-[10px] text-[#4d597d] dark:text-[#919ec4] truncate">
                                ({row.changedFields.join(", ")})
                              </span>
                            )}
                          </div>

                          {row.changed ? (
                            <div className="inline-flex items-center p-0.5 rounded-xs bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c] shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  if (isUsingNew) toggleRowSelection(row.subtitleId);
                                }}
                                className={`px-2 py-0.5 rounded-xs text-[10.5px] font-semibold cursor-pointer transition-colors ${
                                  !isUsingNew
                                    ? "bg-amber-600 text-white dark:bg-amber-500 dark:text-[#070814]"
                                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                }`}
                              >
                                Keep Old
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isUsingNew) toggleRowSelection(row.subtitleId);
                                }}
                                className={`px-2 py-0.5 rounded-xs text-[10.5px] font-semibold cursor-pointer transition-colors ${
                                  isUsingNew
                                    ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                }`}
                              >
                                Use New
                              </button>
                            </div>
                          ) : row.matched ? (
                            <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                              Unchanged
                            </span>
                          ) : (
                            <span className="text-[11px] text-amber-700 dark:text-amber-300">
                              Kept (old)
                            </span>
                          )}
                        </div>

                        {row.changed ? (
                          <div className="space-y-1.5 text-[11px]">
                            {row.changedFields.includes("thaiPhonetic") && (
                              <div className="grid grid-cols-[58px_1fr] gap-2">
                                <span className="text-[#4d597d] dark:text-[#919ec4]">
                                  Phonetic
                                </span>
                                <div className="min-w-0 space-y-0.5">
                                  <p
                                    className={`break-words ${
                                      isUsingNew
                                        ? "text-[#4d597d] dark:text-[#919ec4] line-through opacity-75"
                                        : "text-amber-900 dark:text-amber-200 font-medium"
                                    }`}
                                  >
                                    <span className="text-[9.5px] uppercase tracking-wider mr-1.5 opacity-70">
                                      Old
                                    </span>
                                    {row.before.thaiPhonetic || "—"}
                                  </p>
                                  <p
                                    className={`break-words ${
                                      isUsingNew
                                        ? "text-[#0c1026] dark:text-[#f3f5fc] font-medium"
                                        : "text-[#4d597d] dark:text-[#919ec4] line-through opacity-60"
                                    }`}
                                  >
                                    <span className="text-[9.5px] uppercase tracking-wider mr-1.5 text-teal-700 dark:text-teal-300">
                                      New
                                    </span>
                                    {row.after.thaiPhonetic}
                                  </p>
                                </div>
                              </div>
                            )}
                            {row.changedFields.includes("thaiScript") && (
                              <div className="grid grid-cols-[58px_1fr] gap-2">
                                <span className="text-[#4d597d] dark:text-[#919ec4]">
                                  Thai
                                </span>
                                <div className="min-w-0 space-y-0.5">
                                  <p
                                    className={`break-words ${
                                      isUsingNew
                                        ? "text-[#4d597d] dark:text-[#919ec4] line-through opacity-75"
                                        : "text-amber-900 dark:text-amber-200 font-medium"
                                    }`}
                                  >
                                    <span className="text-[9.5px] uppercase tracking-wider mr-1.5 opacity-70">
                                      Old
                                    </span>
                                    {row.before.thaiScript || "—"}
                                  </p>
                                  <p
                                    className={`break-words ${
                                      isUsingNew
                                        ? "text-[#0c1026] dark:text-[#f3f5fc] font-medium"
                                        : "text-[#4d597d] dark:text-[#919ec4] line-through opacity-60"
                                    }`}
                                  >
                                    <span className="text-[9.5px] uppercase tracking-wider mr-1.5 text-teal-700 dark:text-teal-300">
                                      New
                                    </span>
                                    {row.after.thaiScript}
                                  </p>
                                </div>
                              </div>
                            )}
                            {row.changedFields.includes("burmese") && (
                              <div className="grid grid-cols-[58px_1fr] gap-2">
                                <span className="text-[#4d597d] dark:text-[#919ec4]">
                                  Burmese
                                </span>
                                <div className="min-w-0 space-y-0.5">
                                  <p
                                    className={`font-myanmar break-words ${
                                      isUsingNew
                                        ? "text-[#4d597d] dark:text-[#919ec4] line-through opacity-75"
                                        : "text-amber-900 dark:text-amber-200 font-medium"
                                    }`}
                                  >
                                    <span className="font-sans text-[9.5px] uppercase tracking-wider mr-1.5 opacity-70">
                                      Old
                                    </span>
                                    {row.before.burmese || "—"}
                                  </p>
                                  <p
                                    className={`font-myanmar break-words ${
                                      isUsingNew
                                        ? "text-[#0c1026] dark:text-[#f3f5fc] font-medium"
                                        : "text-[#4d597d] dark:text-[#919ec4] line-through opacity-60"
                                    }`}
                                  >
                                    <span className="font-sans text-[9.5px] uppercase tracking-wider mr-1.5 text-teal-700 dark:text-teal-300">
                                      New
                                    </span>
                                    {row.after.burmese}
                                  </p>
                                </div>
                              </div>
                            )}
                            {row.changedFields.includes("words") && (
                              <div className="grid grid-cols-[58px_1fr] gap-2">
                                <span className="text-[#4d597d] dark:text-[#919ec4]">
                                  Words
                                </span>
                                <p
                                  className={`break-words ${
                                    isUsingNew
                                      ? "text-[#0c1026] dark:text-[#f3f5fc]"
                                      : "text-[#4d597d] dark:text-[#919ec4] line-through opacity-65"
                                  }`}
                                >
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
        ) : (
          /* Saved Versions (Old / New History) Tab */
          <div className="flex-1 min-h-0 overflow-y-auto studio-scrollbar p-4 sm:p-5 space-y-4">
            {/* Current Live Transcript Card */}
            <div className="rounded-md border border-teal-500/45 dark:border-teal-400/40 bg-teal-50/45 dark:bg-teal-950/25 p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-xs bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]">
                      Current Live
                    </span>
                    <span className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular">
                      {subtitles.length} lines
                    </span>
                  </div>
                  <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] mt-1 truncate font-myanmar">
                    {getPreviewSnippet(subtitles)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={subtitles.length === 0}
                    onClick={handleSaveManualBackup}
                    className="h-7 px-2.5 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-white dark:bg-[#141933] hover:bg-teal-50 dark:hover:bg-teal-950/60 text-[11px] font-medium text-teal-800 dark:text-teal-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    <BookmarkPlus className="w-3 h-3" />
                    <span>Save Snapshot</span>
                  </button>
                  <button
                    type="button"
                    disabled={subtitles.length === 0}
                    onClick={() => handleCopyText(currentTranscriptText, "live")}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    {copiedKey === "live" ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-emerald-700 dark:text-emerald-300">
                          Copied
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={subtitles.length === 0}
                    onClick={handleLoadOldIntoEditor}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
                  >
                    <Pencil className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                    <span>Edit</span>
                  </button>
                </div>
              </div>
            </div>

            {versionNotice && (
              <div className="px-3 py-2 rounded-md border border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/75 dark:bg-emerald-950/35 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>{versionNotice}</span>
              </div>
            )}

            {/* Saved History Header */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                Old &amp; New Transcript History ({versions.length})
              </p>
              {versions.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAllVersions}
                  onMouseLeave={() => {
                    if (confirmClearHistory) setConfirmClearHistory(false);
                  }}
                  className={`h-6 px-2 rounded-xs border text-[11px] font-medium cursor-pointer transition-colors ${
                    confirmClearHistory
                      ? "border-rose-500 bg-rose-600 text-white"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-rose-600 dark:hover:text-rose-400"
                  }`}
                >
                  {confirmClearHistory ? "Confirm Clear All" : "Clear History"}
                </button>
              )}
            </div>

            {versions.length === 0 ? (
              <div className="py-8 px-4 text-center text-xs text-[#4d597d] dark:text-[#919ec4] border border-dashed border-[#d2dcf0] dark:border-[#21284c] rounded-md space-y-1">
                <p className="font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                  No saved transcript versions yet
                </p>
                <p>
                  Whenever you apply a new transcript, your old transcript is backed up here automatically. You can also tap <span className="font-medium">Save Snapshot</span> above anytime.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {versions.map((ver) => {
                  const isExpanded = expandedVersionId === ver.id;
                  const isEditing = editingVersionId === ver.id;
                  const isConfirmingRestore = confirmRestoreId === ver.id;
                  const kindBadgeClass =
                    ver.kind === "old"
                      ? "bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200 border border-amber-300/70 dark:border-amber-700/60"
                      : ver.kind === "new"
                        ? "bg-teal-100 text-teal-900 dark:bg-teal-950/70 dark:text-teal-200 border border-teal-300/70 dark:border-teal-700/60"
                        : "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/70 dark:text-indigo-200 border border-indigo-300/70 dark:border-indigo-700/60";

                  return (
                    <div
                      key={ver.id}
                      className="rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#090c1c] p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-xs ${kindBadgeClass}`}
                            >
                              {ver.kind}
                            </span>

                            {isEditing ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleCommitRename(ver.id);
                                }}
                                className="inline-flex items-center gap-1"
                              >
                                <input
                                  type="text"
                                  value={editingLabel}
                                  onChange={(e) => setEditingLabel(e.target.value)}
                                  autoFocus
                                  className="h-6 px-2 rounded-xs border border-teal-600 bg-white dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none"
                                />
                                <button
                                  type="submit"
                                  className="h-6 px-2 rounded-xs bg-teal-700 text-white text-[11px] font-medium cursor-pointer"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingVersionId(null)}
                                  className="h-6 px-1.5 rounded-xs border border-[#d2dcf0] dark:border-[#21284c] text-[11px] cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingVersionId(ver.id);
                                  setEditingLabel(ver.label);
                                }}
                                title="Rename version"
                                className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] hover:text-teal-700 dark:hover:text-teal-300 inline-flex items-center gap-1 cursor-pointer truncate"
                              >
                                <span className="truncate">{ver.label}</span>
                                <Pencil className="w-2.5 h-2.5 opacity-60 shrink-0" />
                              </button>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#4d597d] dark:text-[#919ec4] font-mono-tabular">
                            <span>{formatTimestamp(ver.createdAt)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{ver.lineCount} lines</span>
                          </div>
                          <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] truncate font-myanmar">
                            {ver.previewLine}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCompareVersion(ver)}
                            className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 cursor-pointer transition-colors"
                          >
                            <ArrowLeftRight className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4]" />
                            <span>Compare</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRestoreVersion(ver)}
                            className={`h-7 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                              isConfirmingRestore
                                ? "border-teal-700 bg-teal-700 text-white dark:border-teal-400 dark:bg-teal-400 dark:text-[#060918]"
                                : "border-teal-600/45 dark:border-teal-400/45 bg-teal-50/70 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200 hover:bg-teal-100/80 dark:hover:bg-teal-900/50"
                            }`}
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>
                              {isConfirmingRestore ? "Confirm Restore" : "Restore"}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleCopyText(ver.text, ver.id)}
                            className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] inline-flex items-center gap-1 cursor-pointer transition-colors"
                            title="Copy this version"
                          >
                            {copiedKey === ver.id ? (
                              <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setExpandedVersionId(isExpanded ? null : ver.id)
                            }
                            className="h-7 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] inline-flex items-center cursor-pointer transition-colors"
                            aria-label={isExpanded ? "Hide transcript text" : "Preview transcript text"}
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteVersion(ver.id)}
                            className="h-7 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-rose-500/60 hover:text-rose-600 dark:hover:text-rose-400 text-[#4d597d] dark:text-[#919ec4] inline-flex items-center cursor-pointer transition-colors"
                            aria-label="Delete saved version"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <pre className="max-h-44 overflow-y-auto studio-scrollbar text-[11px] font-mono-tabular leading-relaxed text-[#2c3556] dark:text-[#c7d1ef] whitespace-pre-wrap break-words bg-white dark:bg-[#070814] p-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c]">
                          {ver.text}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="shrink-0 px-4 sm:px-5 py-3 border-t border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/85 flex flex-wrap items-center justify-between gap-2.5">
          <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
            {activeTab === "compare"
              ? selectedChangedCount > 0
                ? `Applying ${selectedChangedCount} of ${preview.changedCount} changed lines (old transcript auto-saved).`
                : "Existing start/end times and word timing offsets stay locked."
              : "Restoring a version automatically backs up the current transcript."}
          </span>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer whitespace-nowrap transition-colors"
            >
              Close
            </button>
            {activeTab === "compare" && (
              <button
                type="button"
                disabled={selectedChangedCount === 0}
                onClick={handleApplySelected}
                className="h-8 px-4 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {selectedChangedCount > 0
                    ? `Apply Selected (${selectedChangedCount})`
                    : "Apply Selected"}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
