import { useEffect } from "react";
import { AlertCircle, Check, Download, RotateCcw, Share2, X } from "lucide-react";
import type { ExportedVideoResult, ExportProgress } from "../utils/exportVideo";

interface ExportSheetProps {
  open: boolean;
  progress: ExportProgress | null;
  result: ExportedVideoResult | null;
  hasSaved: boolean;
  error: string | null;
  canShare: boolean;
  onMinimize: () => void;
  onCancel: () => void;
  onSave: (item: ExportedVideoResult) => void;
  onShare: (item: ExportedVideoResult) => void;
  onRetry: () => void;
  onDiscardResult: () => void;
}

const STEPS: { key: ExportProgress["phase"]; label: string }[] = [
  { key: "uploading", label: "Upload" },
  { key: "rendering", label: "Subtitles" },
  { key: "muxing", label: "Encode" },
  { key: "downloading", label: "Transfer" },
];

function getPhaseIndex(phase: ExportProgress["phase"]): number {
  switch (phase) {
    case "preparing":
    case "uploading":
      return 0;
    case "rendering":
      return 1;
    case "muxing":
      return 2;
    case "downloading":
      return 3;
    default:
      return 0;
  }
}

function getPhaseHeadline(phase: ExportProgress["phase"]): string {
  switch (phase) {
    case "uploading":
      return "Uploading source video";
    case "rendering":
      return "Rendering subtitle track";
    case "muxing":
      return "Encoding 9:16 MP4";
    case "downloading":
      return "Transferring MP4";
    default:
      return "Preparing export";
  }
}

export function ExportSheet({
  open,
  progress,
  result,
  hasSaved,
  error,
  canShare,
  onMinimize,
  onCancel,
  onSave,
  onShare,
  onRetry,
  onDiscardResult,
}: ExportSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onMinimize();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onMinimize]);

  if (!open) return null;

  const isExporting = Boolean(progress);
  const activeStepIdx = progress ? getPhaseIndex(progress.phase) : 0;
  const percent = progress ? Math.max(0, Math.min(100, progress.percent)) : 0;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onMinimize();
        }
      }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-sheet-title"
    >
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl border-t sm:border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] shadow-2xl overflow-hidden">
        {/* Mobile drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden" aria-hidden="true">
          <div className="w-10 h-1 rounded-full bg-[#bcc9e6] dark:bg-[#2f3866]" />
        </div>

        {/* Sheet Header */}
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 border-b border-[#d2dcf0] dark:border-[#21284c]">
          <div className="min-w-0">
            <h2
              id="export-sheet-title"
              className="font-display text-base font-semibold tracking-tight text-[#0c1026] dark:text-[#f3f5fc] truncate"
            >
              {isExporting
                ? "Exporting Video"
                : result
                  ? hasSaved
                    ? "Saved to Device"
                    : "Export Ready"
                  : "Export Failed"}
            </h2>
            {result && !isExporting && (
              <p className="text-xs text-[#4d597d] dark:text-[#919ec4] mt-0.5 truncate font-mono-tabular">
                {result.fileName}
                <span aria-hidden="true"> · </span>
                {(result.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                <span aria-hidden="true"> · </span>
                9:16 MP4
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onMinimize}
            aria-label={isExporting ? "Hide export progress" : "Close export sheet"}
            title={isExporting ? "Hide (continues in background)" : "Close"}
            className="w-9 h-9 -mr-1.5 rounded-lg flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sheet Body */}
        <div className="px-5 py-5 space-y-5">
          {isExporting && progress && (
            <>
              {/* Numeric progress + active phase */}
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] truncate">
                    {getPhaseHeadline(progress.phase)}
                  </p>
                  <p className="text-xs text-[#4d597d] dark:text-[#919ec4] mt-0.5 font-mono-tabular truncate">
                    {progress.detail || "Running in background..."}
                  </p>
                </div>
                <span className="font-display text-2xl font-semibold tracking-tight font-mono-tabular text-teal-700 dark:text-teal-400 shrink-0">
                  {percent}%
                </span>
              </div>

              {/* Clean progress bar */}
              <div className="w-full h-2 rounded-sm bg-[#e7ecf8] dark:bg-[#141933] overflow-hidden">
                <div
                  className="h-full rounded-sm bg-teal-700 dark:bg-teal-400 transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(4, percent)}%` }}
                />
              </div>

              {/* 4-step quiet pipeline indicator */}
              <div className="grid grid-cols-4 gap-2 pt-1">
                {STEPS.map((step, idx) => {
                  const isDone = idx < activeStepIdx;
                  const isActive = idx === activeStepIdx;
                  return (
                    <div key={step.key} className="space-y-1.5">
                      <div
                        className={`h-1 rounded-sm transition-colors ${
                          isDone || isActive
                            ? "bg-teal-700 dark:bg-teal-400"
                            : "bg-[#d2dcf0] dark:bg-[#21284c]"
                        }`}
                      />
                      <div className="flex items-center gap-1 text-[11px] font-medium">
                        {isDone && (
                          <Check className="w-3 h-3 text-teal-700 dark:text-teal-400 shrink-0" />
                        )}
                        <span
                          className={`truncate ${
                            isActive
                              ? "text-[#0c1026] dark:text-[#f3f5fc]"
                              : isDone
                                ? "text-[#4d597d] dark:text-[#919ec4]"
                                : "text-[#4d597d]/50 dark:text-[#919ec4]/50"
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Ergonomic thumb-zone actions: Hide vs Cancel */}
              <div className="grid grid-cols-2 gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={onMinimize}
                  className="h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] transition-colors cursor-pointer"
                >
                  Hide
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="h-10 px-4 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50/70 dark:bg-red-950/35 hover:bg-red-100/80 dark:hover:bg-red-950/60 text-sm font-medium text-red-600 dark:text-red-400 transition-colors cursor-pointer"
                >
                  Cancel Export
                </button>
              </div>
            </>
          )}

          {!isExporting && result && (
            <>
              {/* Built-in 9:16 MP4 verification player */}
              <div className="rounded-lg bg-[#04050e] border border-[#d2dcf0] dark:border-[#21284c] overflow-hidden flex items-center justify-center">
                <video
                  src={result.blobUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full max-h-[260px] object-contain"
                />
              </div>

              {/* Explicit single-save controls (prevents accidental duplicate downloads) */}
              <div className="space-y-2.5">
                {!hasSaved ? (
                  <button
                    type="button"
                    onClick={() => onSave(result)}
                    className="w-full h-11 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-xs"
                  >
                    <Download className="w-4 h-4" />
                    <span>Save MP4 to Device</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div
                      role="status"
                      className="w-full h-11 px-4 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/75 dark:bg-emerald-950/35 text-emerald-800 dark:text-emerald-300 text-sm font-medium flex items-center justify-center gap-2"
                    >
                      <Check className="w-4 h-4 shrink-0" />
                      <span>Saved to Downloads</span>
                    </div>
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => onSave(result)}
                        className="h-9 px-3 rounded-lg text-xs font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Download another copy</span>
                      </button>
                    </div>
                  </div>
                )}

                <div className={`grid gap-2.5 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
                  {canShare && (
                    <button
                      type="button"
                      onClick={() => onShare(result)}
                      className="h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Share2 className="w-4 h-4" />
                      <span>Share</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={hasSaved ? onDiscardResult : onMinimize}
                    className="h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center transition-colors cursor-pointer"
                  >
                    {hasSaved ? "Done" : "Keep for Later"}
                  </button>
                </div>
              </div>
            </>
          )}

          {!isExporting && !result && error && (
            <>
              <div className="flex items-start gap-3 p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/75 dark:bg-red-950/35">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-[#0c1026] dark:text-[#f3f5fc] leading-relaxed">
                  {error}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={onDiscardResult}
                  className="h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#4d597d] dark:text-[#919ec4] transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-10 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-sm font-semibold transition-colors cursor-pointer"
                >
                  Try Again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
