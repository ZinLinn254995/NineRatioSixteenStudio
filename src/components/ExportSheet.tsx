import { useEffect } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Film,
  Music,
  RefreshCw,
  RotateCcw,
  Share2,
  X,
} from "lucide-react";
import type {
  ExportedVideoResult,
  ExportFormat,
  ExportProgress,
} from "../utils/exportVideo";

interface ExportSheetProps {
  open: boolean;
  format: ExportFormat;
  progress: ExportProgress | null;
  result: ExportedVideoResult | null;
  hasSaved: boolean;
  isStale?: boolean;
  error: string | null;
  canShare: boolean;
  hasMp4Ready?: boolean;
  hasMp3Ready?: boolean;
  onSelectFormat: (format: ExportFormat) => void;
  onMinimize: () => void;
  onCancel: () => void;
  onSave: (item: ExportedVideoResult) => void;
  onShare: (item: ExportedVideoResult) => void;
  onRetry: () => void;
  onDiscardResult: () => void;
}

const MP4_STEPS: { key: ExportProgress["phase"]; label: string }[] = [
  { key: "uploading", label: "Upload" },
  { key: "rendering", label: "Subtitles" },
  { key: "muxing", label: "Encode" },
  { key: "downloading", label: "Transfer" },
];

const MP3_STEPS: { key: ExportProgress["phase"]; label: string }[] = [
  { key: "uploading", label: "Upload" },
  { key: "muxing", label: "Audio" },
  { key: "downloading", label: "Transfer" },
];

function getPhaseIndex(phase: ExportProgress["phase"], format: ExportFormat): number {
  if (format === "mp3") {
    switch (phase) {
      case "preparing":
      case "uploading":
        return 0;
      case "rendering":
      case "muxing":
        return 1;
      case "downloading":
        return 2;
      default:
        return 0;
    }
  }
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

function getPhaseHeadline(phase: ExportProgress["phase"], format: ExportFormat): string {
  const isMp3 = format === "mp3";
  switch (phase) {
    case "uploading":
      return "Uploading source media";
    case "rendering":
      return "Rendering subtitle track";
    case "muxing":
      return isMp3 ? "Encoding MP3 audio" : "Encoding 9:16 MP4";
    case "downloading":
      return isMp3 ? "Transferring MP3" : "Transferring MP4";
    default:
      return isMp3 ? "Preparing audio export" : "Preparing export";
  }
}

export function ExportSheet({
  open,
  format,
  progress,
  result,
  hasSaved,
  isStale = false,
  error,
  canShare,
  hasMp4Ready = false,
  hasMp3Ready = false,
  onSelectFormat,
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
  const activeFormat: ExportFormat =
    result?.format ??
    (result?.fileName?.toLowerCase().endsWith(".mp3") ? "mp3" : format);
  const isMp3 = activeFormat === "mp3";
  const formatLabel = isMp3 ? "MP3" : "MP4";
  const steps = format === "mp3" ? MP3_STEPS : MP4_STEPS;
  const activeStepIdx = progress ? getPhaseIndex(progress.phase, format) : 0;
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
      <div className="w-full sm:max-w-md max-h-[90dvh] flex flex-col rounded-t-2xl sm:rounded-xl border-t sm:border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] shadow-2xl overflow-hidden">
        {/* Mobile drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden shrink-0" aria-hidden="true">
          <div className="w-10 h-1 rounded-full bg-[#bcc9e6] dark:bg-[#2f3866]" />
        </div>

        {/* Sheet Header */}
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-center justify-between gap-3 border-b border-[#d2dcf0] dark:border-[#21284c]">
          <div className="min-w-0">
            <h2
              id="export-sheet-title"
              className="font-display text-base font-semibold tracking-tight text-[#0c1026] dark:text-[#f3f5fc] truncate"
            >
              {isExporting
                ? format === "mp3"
                  ? "Exporting Audio"
                  : "Exporting Video"
                : result
                  ? isStale
                    ? `Previous ${formatLabel} Export`
                    : hasSaved
                      ? "Saved to Device"
                      : `${formatLabel} Ready`
                  : error
                    ? "Export Failed"
                    : `Export ${format === "mp3" ? "MP3 Audio" : "9:16 MP4"}`}
            </h2>
            {result && !isExporting && (
              <p className="text-xs text-[#4d597d] dark:text-[#919ec4] mt-0.5 truncate font-mono-tabular">
                {result.fileName}
                <span aria-hidden="true"> · </span>
                {(result.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                <span aria-hidden="true"> · </span>
                {isMp3 ? "MP3 Audio" : "9:16 MP4"}
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

        {/* Format Switcher (available when idle) */}
        {!isExporting && (
          <div className="shrink-0 px-5 pt-4">
            <div
              role="tablist"
              aria-label="Export format"
              className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-[#f3f5fc] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={format === "mp4"}
                onClick={() => onSelectFormat("mp4")}
                className={`h-8 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  format === "mp4"
                    ? "bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] shadow-xs"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                <Film className="w-3.5 h-3.5 shrink-0" />
                <span>MP4 Video</span>
                {hasMp4Ready && (
                  <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={format === "mp3"}
                onClick={() => onSelectFormat("mp3")}
                className={`h-8 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  format === "mp3"
                    ? "bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] shadow-xs"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                <Music className="w-3.5 h-3.5 shrink-0" />
                <span>MP3 Audio</span>
                {hasMp3Ready && (
                  <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Sheet Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-5 space-y-5">
          {isExporting && progress && (
            <>
              {/* Numeric progress + active phase */}
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] truncate">
                    {getPhaseHeadline(progress.phase, format)}
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

              {/* Pipeline indicator */}
              <div
                className={`grid gap-2 pt-1 ${
                  steps.length === 3 ? "grid-cols-3" : "grid-cols-4"
                }`}
              >
                {steps.map((step, idx) => {
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
              {isStale && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800/70 bg-amber-50/80 dark:bg-amber-950/35 text-xs text-amber-900 dark:text-amber-200">
                  <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>You edited the project after this export. Re-export to include your latest changes.</span>
                </div>
              )}

              {/* Built-in verification player (MP3 audio or 9:16 MP4 video) */}
              {isMp3 ? (
                <div className="rounded-lg bg-[#f3f5fc] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c] p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-teal-700/10 dark:bg-teal-400/15 text-teal-700 dark:text-teal-400 flex items-center justify-center shrink-0">
                      <Music className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                        {result.fileName}
                      </p>
                      <p className="text-xs text-[#4d597d] dark:text-[#919ec4] font-mono-tabular">
                        {(result.sizeBytes / (1024 * 1024)).toFixed(2)} MB · 192 kbps MP3
                      </p>
                    </div>
                  </div>
                  <audio
                    src={result.blobUrl}
                    controls
                    preload="metadata"
                    className="w-full h-10"
                  />
                </div>
              ) : (
                <div className="rounded-lg bg-[#04050e] border border-[#d2dcf0] dark:border-[#21284c] overflow-hidden flex items-center justify-center">
                  <video
                    src={result.blobUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full max-h-[260px] object-contain"
                  />
                </div>
              )}

              {/* Explicit single-save & clear Re-export controls */}
              <div className="space-y-2.5">
                {isStale ? (
                  <>
                    <button
                      type="button"
                      onClick={onRetry}
                      className="w-full h-11 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-xs"
                    >
                      <RefreshCw className="w-4 h-4" />
                      <span>Re-export Updated {formatLabel}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onSave(result)}
                      className="w-full h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      <span>Save Previous {formatLabel}</span>
                    </button>
                  </>
                ) : !hasSaved ? (
                  <button
                    type="button"
                    onClick={() => onSave(result)}
                    className="w-full h-11 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-sm font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-xs"
                  >
                    <Download className="w-4 h-4" />
                    <span>Save {formatLabel} to Device</span>
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

                <div
                  className={`grid gap-2.5 ${
                    !isStale && canShare
                      ? "grid-cols-3"
                      : !isStale || canShare
                        ? "grid-cols-2"
                        : "grid-cols-1"
                  }`}
                >
                  {!isStale && (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="h-10 px-3 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <RefreshCw className="w-4 h-4 shrink-0" />
                      <span>Re-export</span>
                    </button>
                  )}
                  {canShare && (
                    <button
                      type="button"
                      onClick={() => onShare(result)}
                      className="h-10 px-3 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Share2 className="w-4 h-4 shrink-0" />
                      <span>Share</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={hasSaved ? onDiscardResult : onMinimize}
                    className="h-10 px-3 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center transition-colors cursor-pointer"
                  >
                    {hasSaved ? "Done" : "Close"}
                  </button>
                </div>
              </div>
            </>
          )}

          {!isExporting && !result && error && (
            <>
              <div className="flex items-start gap-3 p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/75 dark:bg-red-950/35 max-h-48 overflow-y-auto overscroll-contain">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="min-w-0 text-sm text-[#0c1026] dark:text-[#f3f5fc] leading-relaxed break-words">
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

          {!isExporting && !result && !error && (
            <div className="space-y-4">
              <p className="text-sm text-[#4d597d] dark:text-[#919ec4] leading-relaxed">
                {format === "mp3"
                  ? "Export the audio track from your edited timeline clips, playback speed, and voice settings as a 192 kbps MP3 file."
                  : "Export your 9:16 portrait video with subtitles, visual adjustments, timeline edits, and voice settings as an MP4 file."}
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={onMinimize}
                  className="h-10 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-sm font-medium text-[#4d597d] dark:text-[#919ec4] transition-colors cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-10 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  {format === "mp3" ? (
                    <Music className="w-4 h-4 shrink-0" />
                  ) : (
                    <Film className="w-4 h-4 shrink-0" />
                  )}
                  <span>Export {format === "mp3" ? "MP3" : "MP4"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

