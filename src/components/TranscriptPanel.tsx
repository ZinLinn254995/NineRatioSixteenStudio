import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Globe2,
  Loader2,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  SubtitleSourceLanguage,
  TranscriptExportFormat,
  TranscriptModelId,
  TranscriptProgress,
  TranscriptResult,
} from "../types";
import { SOURCE_LANGUAGE_OPTIONS } from "../utils/subtitleGenerationConfig";
import {
  deleteCachedWhisperModel,
  detectWebGpuSupport,
  downloadWhisperModel,
  getCachedWhisperModelIds,
  TRANSCRIPT_MODELS,
  type TranscriptModelSpec,
} from "../utils/whisperTranscriber";
import {
  buildTranscriptPlainText,
  buildTranscriptTimestampedText,
  downloadTranscriptExport,
  formatTranscriptClock,
  TRANSCRIPT_EXPORT_FORMATS,
} from "../utils/exportTranscript";
import { copyTextToClipboard } from "../utils/transcriptHistory";

interface TranscriptPanelProps {
  hasVideo: boolean;
  videoTitle: string;
  durationSec: number;
  selectedModelId: TranscriptModelId;
  selectedLanguage: SubtitleSourceLanguage;
  wordTimestamps: boolean;
  isTranscribing: boolean;
  progress: TranscriptProgress | null;
  error: string | null;
  result: TranscriptResult | null;
  onChangeModel: (modelId: TranscriptModelId) => void;
  onChangeLanguage: (lang: SubtitleSourceLanguage) => void;
  onChangeWordTimestamps: (enabled: boolean) => void;
  onStartTranscribe: () => void;
  onCancelTranscribe: () => void;
  onClearError: () => void;
  onUpdateSegmentText: (segmentId: string, text: string) => void;
  onSeek: (sec: number) => void;
}

function formatBytesMb(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TranscriptPanel({
  hasVideo,
  videoTitle,
  durationSec,
  selectedModelId,
  selectedLanguage,
  wordTimestamps,
  isTranscribing,
  progress,
  error,
  result,
  onChangeModel,
  onChangeLanguage,
  onChangeWordTimestamps,
  onStartTranscribe,
  onCancelTranscribe,
  onClearError,
  onUpdateSegmentText,
  onSeek,
}: TranscriptPanelProps) {
  const [cachedModels, setCachedModels] = useState<Set<TranscriptModelId>>(new Set());
  const [hasWebGpu, setHasWebGpu] = useState<boolean | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<TranscriptModelId | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<TranscriptProgress | null>(null);
  const [downloadAbortCtrl, setDownloadAbortCtrl] = useState<AbortController | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [modelsExpanded, setModelsExpanded] = useState<boolean>(() => !result);
  const [viewMode, setViewMode] = useState<"segments" | "paragraph">("segments");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedState, setCopiedState] = useState<"plain" | "timed" | null>(null);

  const selectedSpec = useMemo(
    () => TRANSCRIPT_MODELS.find((m) => m.id === selectedModelId) ?? TRANSCRIPT_MODELS[1],
    [selectedModelId]
  );

  const refreshCacheStatus = async () => {
    const ids = await getCachedWhisperModelIds();
    setCachedModels(ids);
  };

  useEffect(() => {
    void refreshCacheStatus();
    void detectWebGpuSupport().then(setHasWebGpu);
  }, []);

  useEffect(() => {
    if (!isTranscribing) {
      void refreshCacheStatus();
      if (result) {
        setModelsExpanded(false);
      }
    }
  }, [isTranscribing, result]);

  const handlePreDownloadModel = async (spec: TranscriptModelSpec) => {
    if (downloadingModelId || isTranscribing || spec.isCloud) return;
    setLocalError(null);
    const ctrl = new AbortController();
    setDownloadAbortCtrl(ctrl);
    setDownloadingModelId(spec.id);
    setDownloadProgress({
      phase: "downloading",
      label: `Downloading ${spec.label}...`,
      percent: 0,
    });

    try {
      await downloadWhisperModel(spec.id, {
        signal: ctrl.signal,
        onProgress: (p) => setDownloadProgress(p),
      });
      await refreshCacheStatus();
      onChangeModel(spec.id);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setLocalError(
          err instanceof Error ? err.message : `Failed to download ${spec.label}.`
        );
      }
    } finally {
      setDownloadingModelId(null);
      setDownloadProgress(null);
      setDownloadAbortCtrl(null);
    }
  };

  const handleCancelPreDownload = () => {
    downloadAbortCtrl?.abort();
  };

  const handleDeleteModel = async (spec: TranscriptModelSpec) => {
    if (downloadingModelId || isTranscribing) return;
    await deleteCachedWhisperModel(spec.id);
    await refreshCacheStatus();
  };

  const filteredSegments = useMemo(() => {
    if (!result) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return result.segments;
    return result.segments.filter((seg) => seg.text.toLowerCase().includes(q));
  }, [result, searchQuery]);

  const wordCount = useMemo(() => {
    if (!result) return 0;
    const combined = result.segments.map((s) => s.text).join(" ").trim();
    if (!combined) return 0;
    return combined.split(/\s+/).length;
  }, [result]);

  const handleCopy = async (mode: "plain" | "timed") => {
    if (!result) return;
    const text =
      mode === "plain"
        ? buildTranscriptPlainText(result)
        : buildTranscriptTimestampedText(result);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedState(mode);
      setTimeout(() => setCopiedState((cur) => (cur === mode ? null : cur)), 2000);
    }
  };

  const handleDownloadFormat = (format: TranscriptExportFormat) => {
    if (!result) return;
    downloadTranscriptExport(result, format);
  };

  const activeProgress = isTranscribing ? progress : downloadProgress;
  const activeError = error || localError;
  const effectiveLang = selectedSpec.isEnglishOnly ? "en" : selectedLanguage;

  return (
    <div className="flex flex-col min-h-full bg-white dark:bg-[#0d1022]">
      {/* Header Summary */}
      <div className="px-3.5 py-3 border-b border-[#d2dcf0] dark:border-[#21284c] space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
            {videoTitle || "Audio Transcript"}
          </h3>
          <span className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] whitespace-nowrap shrink-0">
            {formatTranscriptClock(durationSec)}
          </span>
        </div>
        <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] leading-snug">
          Standalone speech-to-text transcript &amp; multi-format export (kept separate from video subtitles).
        </p>
      </div>

      <div className="px-3.5 py-3 space-y-4 flex-1">
        {activeError && (
          <div className="px-3 py-2 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/80 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="break-words">{activeError}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                onClearError();
              }}
              aria-label="Dismiss transcript error"
              className="text-[11px] font-medium hover:underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Language & Timestamp Mode */}
        <section className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5 items-end">
          <div className="space-y-1 min-w-0">
            <label
              htmlFor="transcript-lang-select"
              className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5"
            >
              <Globe2 className="w-3 h-3 text-teal-600 dark:text-teal-400" />
              <span>Spoken Language</span>
            </label>
            <select
              id="transcript-lang-select"
              disabled={isTranscribing || Boolean(downloadingModelId) || Boolean(selectedSpec.isEnglishOnly)}
              value={effectiveLang}
              onChange={(e) => onChangeLanguage(e.target.value as SubtitleSourceLanguage)}
              className="w-full h-9 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 cursor-pointer disabled:opacity-50"
            >
              {SOURCE_LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label} ({opt.nativeLabel})
                </option>
              ))}
            </select>
          </div>

          {!selectedSpec.isCloud && (
            <div className="space-y-1 shrink-0">
              <span className="block text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]">
                Timing Mode
              </span>
              <div
                role="radiogroup"
                aria-label="Timestamp granularity"
                className="inline-flex h-9 p-0.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933]"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!wordTimestamps}
                  disabled={isTranscribing}
                  onClick={() => onChangeWordTimestamps(false)}
                  className={`px-2.5 rounded-sm text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 ${
                    !wordTimestamps
                      ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 font-semibold shadow-xs"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Segments
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={wordTimestamps}
                  disabled={isTranscribing}
                  onClick={() => onChangeWordTimestamps(true)}
                  className={`px-2.5 rounded-sm text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 ${
                    wordTimestamps
                      ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-300 font-semibold shadow-xs"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Word-level
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Model Selection */}
        <section className="space-y-2 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]">
                Transcript Model
              </p>
              <p className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] truncate">
                {selectedSpec.label}
                <span className="text-[#4d597d] dark:text-[#919ec4] font-normal">
                  {" "}· {selectedSpec.scopeLabel} · {selectedSpec.sizeLabel}
                  {cachedModels.has(selectedSpec.id) ? " · Cached" : ""}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModelsExpanded((v) => !v)}
              aria-expanded={modelsExpanded}
              className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <span>{modelsExpanded ? "Hide Models" : "Change Model"}</span>
              {modelsExpanded ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {modelsExpanded && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                <span>
                  Smaller models run faster; Base or Small is best on most browsers.
                </span>
                {hasWebGpu !== null && (
                  <span className="font-mono-tabular whitespace-nowrap shrink-0 ml-2">
                    {hasWebGpu ? "WebGPU Ready" : "WASM Mode"}
                  </span>
                )}
              </div>

              <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c] border border-[#d2dcf0] dark:border-[#21284c] rounded-md overflow-hidden">
                {TRANSCRIPT_MODELS.map((spec) => {
                  const isSelected = spec.id === selectedModelId;
                  const isCached = cachedModels.has(spec.id);
                  const isDownloadingThis = downloadingModelId === spec.id;
                  const disableRowActions =
                    isTranscribing || (Boolean(downloadingModelId) && !isDownloadingThis);

                  return (
                    <div
                      key={spec.id}
                      className={`px-3 py-2.5 transition-colors flex items-center justify-between gap-3 ${
                        isSelected
                          ? "bg-teal-50/70 dark:bg-teal-950/35"
                          : "bg-white dark:bg-[#0d1022] hover:bg-[#f8faff] dark:hover:bg-[#11162e]"
                      }`}
                    >
                      <button
                        type="button"
                        disabled={disableRowActions}
                        onClick={() => onChangeModel(spec.id)}
                        className="flex-1 min-w-0 text-left cursor-pointer disabled:opacity-60"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                            {spec.label}
                          </span>
                          {isSelected && (
                            <Check className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                          )}
                        </div>
                        <p className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] truncate mt-0.5">
                          {spec.scopeLabel} · {spec.sizeLabel}
                          {spec.recommended ? " · Recommended" : ""}
                          {isCached ? " · Cached" : ""}
                        </p>
                        <p className="text-[10.5px] text-[#6d7a9e] dark:text-[#8e9cc4] truncate mt-0.5">
                          {spec.description}
                        </p>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {!spec.isCloud && isCached && (
                          <button
                            type="button"
                            disabled={disableRowActions}
                            onClick={() => void handleDeleteModel(spec)}
                            title={`Delete cached ${spec.label} model`}
                            aria-label={`Delete cached ${spec.label} model`}
                            className="h-8 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-40 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Delete</span>
                          </button>
                        )}

                        {!spec.isCloud && !isCached && (
                          isDownloadingThis ? (
                            <button
                              type="button"
                              onClick={handleCancelPreDownload}
                              className="h-8 px-2.5 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/50 text-[11px] font-semibold text-red-700 dark:text-red-300 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                            >
                              <Square className="w-2.5 h-2.5 fill-current" />
                              <span>Cancel</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={disableRowActions}
                              onClick={() => void handlePreDownloadModel(spec)}
                              className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[11px] font-semibold text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-45 transition-colors"
                            >
                              <Download className="w-3 h-3" />
                              <span>Download</span>
                            </button>
                          )
                        )}

                        <button
                          type="button"
                          disabled={disableRowActions}
                          onClick={() => onChangeModel(spec.id)}
                          className={`h-8 px-2.5 rounded-md text-[11px] font-semibold whitespace-nowrap cursor-pointer disabled:opacity-45 transition-colors ${
                            isSelected
                              ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                              : "border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] hover:border-teal-600/50 dark:hover:border-teal-400/50"
                          }`}
                        >
                          {isSelected ? "Active" : "Use"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Active Progress + Generate CTA */}
        <section className="space-y-2">
          {activeProgress && (
            <div className="px-3 py-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 min-w-0 truncate">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-700 dark:text-teal-400 shrink-0" />
                  <span className="truncate">{activeProgress.label}</span>
                </span>
                <span className="font-mono-tabular text-[11px] font-semibold text-teal-700 dark:text-teal-300 whitespace-nowrap shrink-0">
                  {activeProgress.loadedBytes && activeProgress.totalBytes
                    ? `${formatBytesMb(activeProgress.loadedBytes)} / ${formatBytesMb(activeProgress.totalBytes)} · `
                    : ""}
                  {Math.round(activeProgress.percent)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-xs bg-[#d2dcf0] dark:bg-[#21284c] overflow-hidden">
                <div
                  className="h-full bg-teal-700 dark:bg-teal-400 transition-[width] duration-200"
                  style={{ width: `${Math.max(4, Math.min(100, activeProgress.percent))}%` }}
                />
              </div>
            </div>
          )}

          {isTranscribing ? (
            <button
              type="button"
              onClick={onCancelTranscribe}
              className="w-full h-10 px-4 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/80 dark:bg-red-950/35 hover:bg-red-100 dark:hover:bg-red-900/50 text-xs font-semibold text-red-700 dark:text-red-300 flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Stop Transcription</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!hasVideo || Boolean(downloadingModelId)}
              onClick={onStartTranscribe}
              className="w-full h-10 px-4 rounded-md bg-[#1c3db8] hover:bg-[#16319a] dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>
                {result
                  ? `Re-transcribe (${selectedSpec.label})`
                  : `Transcribe with ${selectedSpec.label}`}
              </span>
            </button>
          )}
        </section>

        {/* Transcript Result + Export */}
        {result && (
          <>
            {/* Export Formats Section */}
            <section className="space-y-2.5 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4]">
                  Export Transcript
                </p>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleCopy("plain")}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
                  >
                    {copiedState === "plain" ? (
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedState === "plain" ? "Copied" : "Copy Text"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopy("timed")}
                    className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
                  >
                    {copiedState === "timed" ? (
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedState === "timed" ? "Copied" : "Copy Timed"}</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {TRANSCRIPT_EXPORT_FORMATS.map((fmt) => (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => handleDownloadFormat(fmt.id)}
                    title={fmt.desc}
                    className="px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#11162e] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:bg-teal-50/60 dark:hover:bg-teal-950/35 text-left cursor-pointer transition-colors"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-mono-tabular font-semibold text-teal-700 dark:text-teal-300">
                        {fmt.ext}
                      </span>
                      <Download className="w-3 h-3 text-[#4d597d] dark:text-[#919ec4] shrink-0" />
                    </div>
                    <p className="text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] truncate mt-0.5">
                      {fmt.label}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            {/* Transcript Viewer & Editor */}
            <section className="space-y-2.5 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] truncate">
                  {result.segments.length} segments · {wordCount} words · {result.modelLabel}
                </div>

                <div
                  role="tablist"
                  aria-label="Transcript view mode"
                  className="inline-flex items-center p-0.5 rounded-sm bg-[#eef2fb] dark:bg-[#141933] shrink-0"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "segments"}
                    onClick={() => setViewMode("segments")}
                    className={`px-2 py-1 rounded-xs text-[11px] font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                      viewMode === "segments"
                        ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 shadow-xs"
                        : "text-[#4d597d] dark:text-[#919ec4]"
                    }`}
                  >
                    Segments
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "paragraph"}
                    onClick={() => setViewMode("paragraph")}
                    className={`px-2 py-1 rounded-xs text-[11px] font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                      viewMode === "paragraph"
                        ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 shadow-xs"
                        : "text-[#4d597d] dark:text-[#919ec4]"
                    }`}
                  >
                    Paragraph
                  </button>
                </div>
              </div>

              {viewMode === "segments" ? (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter transcript..."
                      aria-label="Filter transcript segments"
                      className="w-full h-8 pl-8 pr-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#6d7a9e] dark:placeholder:text-[#8e9cc4] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        aria-label="Clear filter"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[#4d597d] hover:text-[#0c1026] dark:text-[#919ec4] dark:hover:text-[#f3f5fc] cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {filteredSegments.length === 0 ? (
                    <div className="py-6 text-center text-xs text-[#4d597d] dark:text-[#919ec4]">
                      {result.segments.length === 0
                        ? "No speech was detected in this audio."
                        : "No matching transcript lines."}
                    </div>
                  ) : (
                    <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c] border border-[#d2dcf0] dark:border-[#21284c] rounded-md overflow-hidden">
                      {filteredSegments.map((seg) => (
                        <div
                          key={seg.id}
                          className="px-3 py-2 bg-white dark:bg-[#0d1022] hover:bg-[#f8faff]/70 dark:hover:bg-[#11162e] space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onSeek(seg.startSec)}
                              title="Jump video to this timestamp"
                              className="text-[11px] font-mono-tabular font-semibold text-teal-700 dark:text-teal-400 hover:underline cursor-pointer"
                            >
                              {formatTranscriptClock(seg.startSec)} – {formatTranscriptClock(seg.endSec)}
                            </button>
                            <span className="text-[10.5px] font-mono-tabular text-[#6d7a9e] dark:text-[#8e9cc4]">
                              #{seg.index}
                            </span>
                          </div>
                          <textarea
                            rows={Math.max(1, Math.min(4, Math.ceil(seg.text.length / 46)))}
                            value={seg.text}
                            onChange={(e) => onUpdateSegmentText(seg.id, e.target.value)}
                            aria-label={`Transcript segment ${seg.index}`}
                            className="w-full text-xs leading-relaxed font-myanmar text-[#0c1026] dark:text-[#f3f5fc] bg-transparent border-b border-transparent focus:border-teal-600 dark:focus:border-teal-400 focus:outline-none resize-none py-0.5"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#11162e]">
                  <p className="text-xs leading-relaxed font-myanmar text-[#0c1026] dark:text-[#f3f5fc] whitespace-pre-wrap select-text">
                    {buildTranscriptPlainText(result).trim() || "No speech was detected in this audio."}
                  </p>
                </div>
              )}
            </section>
          </>
        )}

        {!result && !isTranscribing && (
          <div className="py-5 px-3 rounded-md border border-dashed border-[#d2dcf0] dark:border-[#21284c] text-center space-y-1">
            <FileText className="w-5 h-5 mx-auto text-[#4d597d] dark:text-[#919ec4]" />
            <p className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
              Choose a model above and click Transcribe
            </p>
            <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
              Export to TXT, SRT, VTT, CSV, JSON, Markdown, or LRC without adding subtitles to your video.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
