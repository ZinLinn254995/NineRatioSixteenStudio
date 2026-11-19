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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-sheet-title"
    >
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border-t sm:border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-950 dark:text-neutral-50 shadow-2xl overflow-hidden">
        {/* Mobile drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden" aria-hidden="true">
          <div className="w-10 h-1 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>

        {/* Sheet Header */}
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 border-b border-neutral-100 dark:border-neutral-900">
          <div className="min-w-0">
            <h2
              id="export-sheet-title"
              className="text-base font-semibold tracking-tight text-neutral-950 dark:text-neutral-50 truncate"
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
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate tabular-nums">
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
            className="w-10 h-10 -mr-1.5 rounded-xl flex items-center justify-center text-neutral-500 hover:text-neutral-950 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors cursor-pointer shrink-0"
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
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                    {getPhaseHeadline(progress.phase)}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 tabular-nums truncate">
                    {progress.detail || "Running in background..."}
                  </p>
                </div>
                <span className="text-2xl font-semibold tracking-tight tabular-nums text-neutral-950 dark:text-white shrink-0">
                  {percent}%
                </span>
              </div>

              {/* Clean progress bar */}
              <div className="w-full h-2 rounded-full bg-neutral-100 dark:bg-neutral-900 overflow-hidden">
                <div
                  className="h-full rounded-full bg-neutral-950 dark:bg-white transition-[width] duration-300 ease-out"
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
                        className={`h-1 rounded-full transition-colors ${
                          isDone || isActive
                            ? "bg-neutral-950 dark:bg-white"
                            : "bg-neutral-200 dark:bg-neutral-800"
                        }`}
                      />
                      <div className="flex items-center gap-1 text-[11px] font-medium">
                        {isDone && (
                          <Check className="w-3 h-3 text-neutral-900 dark:text-neutral-100 shrink-0" />
                        )}
                        <span
                          className={`truncate ${
                            isActive
                              ? "text-neutral-950 dark:text-white"
                              : isDone
                                ? "text-neutral-600 dark:text-neutral-400"
                                : "text-neutral-400 dark:text-neutral-600"
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
                  className="h-11 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-sm font-medium text-neutral-900 dark:text-neutral-100 transition-colors cursor-pointer"
                >
                  Hide
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="h-11 px-4 rounded-xl border border-red-200 dark:border-red-900/70 bg-red-50/60 dark:bg-red-950/30 hover:bg-red-100/80 dark:hover:bg-red-950/60 text-sm font-medium text-red-600 dark:text-red-400 transition-colors cursor-pointer"
                >
                  Cancel Export
                </button>
              </div>
            </>
          )}

          {!isExporting && result && (
            <>
              {/* Built-in 9:16 MP4 verification player */}
              <div className="rounded-xl bg-neutral-950 border border-neutral-200 dark:border-neutral-800 overflow-hidden flex items-center justify-center">
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
                    className="w-full h-11 px-4 rounded-xl bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition-all cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    <span>Save MP4 to Device</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div
                      role="status"
                      className="w-full h-11 px-4 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 text-sm font-medium flex items-center justify-center gap-2"
                    >
                      <Check className="w-4 h-4 shrink-0" />
                      <span>Saved to Downloads</span>
                    </div>
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => onSave(result)}
                        className="h-9 px-3 rounded-lg text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white inline-flex items-center gap-1.5 transition-colors cursor-pointer"
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
                      className="h-11 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-sm font-medium text-neutral-900 dark:text-neutral-100 flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Share2 className="w-4 h-4" />
                      <span>Share</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={hasSaved ? onDiscardResult : onMinimize}
                    className="h-11 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-sm font-medium text-neutral-700 dark:text-neutral-300 flex items-center justify-center transition-colors cursor-pointer"
                  >
                    {hasSaved ? "Done" : "Keep for Later"}
                  </button>
                </div>
              </div>
            </>
          )}

          {!isExporting && !result && error && (
            <>
              <div className="flex items-start gap-3 p-3.5 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-neutral-800 dark:text-neutral-200 leading-relaxed">
                  {error}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={onDiscardResult}
                  className="h-11 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-sm font-medium text-neutral-700 dark:text-neutral-300 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-11 px-4 rounded-xl bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-sm font-semibold hover:opacity-90 transition-opacity cursor-pointer"
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
