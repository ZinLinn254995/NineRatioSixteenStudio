import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  FileUp,
  Globe2,
  Languages,
  Loader2,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
} from "lucide-react";
import type {
  SubtitleGenerationConfig,
  SubtitleGenerationProgress,
  SubtitleSourceLanguage,
  SubtitleTargetLanguage,
} from "../types";
import {
  CONTENT_GENRE_OPTIONS,
  DEFAULT_SUBTITLE_GEN_CONFIG,
  isPresetMatchingConfig,
  PACING_MODE_OPTIONS,
  PHONETIC_STYLE_OPTIONS,
  QUICK_GEN_INSTRUCTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  SUBTITLE_FORMAT_OPTIONS,
  SUBTITLE_GEN_PRESETS,
  SUBTITLE_GEN_TONE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from "../utils/subtitleGenerationConfig";

interface SubtitleGeneratePanelProps {
  config: SubtitleGenerationConfig;
  hasExistingSubtitles: boolean;
  existingSubtitleCount: number;
  clipCount: number;
  totalDurationSec: number;
  canGenerate: boolean;
  missingMediaReason?: string | null;
  isGenerating: boolean;
  generationProgress?: SubtitleGenerationProgress | null;
  processError?: string | null;
  onChangeConfig: (next: SubtitleGenerationConfig) => void;
  onStartGenerate: (config: SubtitleGenerationConfig) => void;
  onOpenImportSrt?: () => void;
  onCancelGenerate?: () => void;
  onClose: () => void;
}

function formatTotalDuration(sec: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}:${rem.toString().padStart(2, "0")}`;
}

function isConfigModified(config: SubtitleGenerationConfig): boolean {
  return (
    config.sourceLanguage !== DEFAULT_SUBTITLE_GEN_CONFIG.sourceLanguage ||
    config.targetLanguage !== DEFAULT_SUBTITLE_GEN_CONFIG.targetLanguage ||
    config.subtitleFormat !== DEFAULT_SUBTITLE_GEN_CONFIG.subtitleFormat ||
    config.phoneticStyle !== DEFAULT_SUBTITLE_GEN_CONFIG.phoneticStyle ||
    config.translationTone !== DEFAULT_SUBTITLE_GEN_CONFIG.translationTone ||
    config.contentGenre !== DEFAULT_SUBTITLE_GEN_CONFIG.contentGenre ||
    config.pacingMode !== DEFAULT_SUBTITLE_GEN_CONFIG.pacingMode ||
    config.includeWordGloss !== DEFAULT_SUBTITLE_GEN_CONFIG.includeWordGloss ||
    config.includeNativeScript !== DEFAULT_SUBTITLE_GEN_CONFIG.includeNativeScript ||
    config.includeNonSpeech !== DEFAULT_SUBTITLE_GEN_CONFIG.includeNonSpeech ||
    config.customInstructions.trim() !== ""
  );
}

export function SubtitleGeneratePanel({
  config,
  hasExistingSubtitles,
  existingSubtitleCount,
  clipCount,
  totalDurationSec,
  canGenerate,
  missingMediaReason,
  isGenerating,
  generationProgress = null,
  processError = null,
  onChangeConfig,
  onStartGenerate,
  onOpenImportSrt,
  onCancelGenerate,
  onClose,
}: SubtitleGeneratePanelProps) {
  const update = (patch: Partial<SubtitleGenerationConfig>) => {
    onChangeConfig({ ...config, ...patch });
  };

  const canSwapLanguages =
    config.sourceLanguage !== "auto" &&
    config.targetLanguage !== "none" &&
    SOURCE_LANGUAGE_OPTIONS.some((o) => o.id === config.targetLanguage) &&
    TARGET_LANGUAGE_OPTIONS.some((o) => o.id === config.sourceLanguage);

  const handleSwapLanguages = () => {
    if (!canSwapLanguages) return;
    update({
      sourceLanguage: config.targetLanguage as SubtitleSourceLanguage,
      targetLanguage: config.sourceLanguage as SubtitleTargetLanguage,
    });
  };

  const handleSourceChange = (nextSource: SubtitleSourceLanguage) => {
    const patch: Partial<SubtitleGenerationConfig> = { sourceLanguage: nextSource };
    if (nextSource !== "auto" && nextSource === config.targetLanguage) {
      patch.targetLanguage = nextSource === "my" ? "en" : "my";
    }
    update(patch);
  };

  const handleTargetChange = (nextTarget: SubtitleTargetLanguage) => {
    const patch: Partial<SubtitleGenerationConfig> = { targetLanguage: nextTarget };
    if (nextTarget === "none") {
      patch.subtitleFormat = "original_only";
      patch.includeWordGloss = false;
    } else if (config.subtitleFormat === "original_only") {
      patch.subtitleFormat = "bilingual_phonetic";
    }
    update(patch);
  };

  const handleFormatChange = (nextFormat: SubtitleGenerationConfig["subtitleFormat"]) => {
    const patch: Partial<SubtitleGenerationConfig> = { subtitleFormat: nextFormat };
    if (nextFormat === "original_only") {
      patch.includeWordGloss = false;
    } else if (nextFormat === "translation_only") {
      patch.includeWordGloss = false;
      if (config.targetLanguage === "none") {
        patch.targetLanguage = "my";
      }
    } else {
      if (config.targetLanguage === "none") {
        patch.targetLanguage = "my";
      }
    }
    update(patch);
  };

  const handleAppendInstruction = (snippet: string) => {
    const trimmed = config.customInstructions.trim();
    if (!trimmed) {
      update({ customInstructions: snippet });
      return;
    }
    if (trimmed.toLowerCase().includes(snippet.toLowerCase())) return;
    update({ customInstructions: `${trimmed} ${snippet}`.slice(0, 600) });
  };

  const showPhoneticStyleSection =
    config.subtitleFormat === "bilingual_phonetic" ||
    config.subtitleFormat === "original_only";
  const showWordGlossToggle =
    (config.subtitleFormat === "bilingual_phonetic" ||
      config.subtitleFormat === "bilingual_native") &&
    config.targetLanguage !== "none";
  const showNativeScriptToggle = config.subtitleFormat !== "original_only";

  const modified = isConfigModified(config);
  const genPct = generationProgress
    ? Math.max(0, Math.min(100, Math.round(generationProgress.percent)))
    : null;

  return (
    <div className="flex flex-col min-h-full bg-white dark:bg-[#0d1022]">
      {/* Sticky Top Action Bar */}
      <div className="sticky top-0 z-20 flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95 backdrop-blur-md">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to timeline"
            className="h-9 px-2.5 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] text-xs font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
            <span>Back</span>
          </button>

          <div className="min-w-0 flex flex-col">
            <h3 className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
              {hasExistingSubtitles
                ? "Regenerate Subtitle Settings"
                : "Generate Subtitle Settings"}
            </h3>
            <span className="text-[10.5px] font-mono-tabular text-[#6d7a9e] dark:text-[#8e9cc4] truncate">
              {clipCount} {clipCount === 1 ? "clip" : "clips"} · {formatTotalDuration(totalDurationSec)}
              {hasExistingSubtitles ? ` · replacing ${existingSubtitleCount}` : ""}
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled={!modified || isGenerating}
          onClick={() => onChangeConfig({ ...DEFAULT_SUBTITLE_GEN_CONFIG })}
          className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 hover:text-teal-700 dark:hover:text-teal-300 text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw className="w-3 h-3 shrink-0" />
          <span>Reset</span>
        </button>
      </div>

      {/* Scrollable Advanced Settings Body */}
      <div className="flex-1 px-3.5 py-3.5 space-y-4 pb-6">
        {processError && (
          <div className="px-3 py-2.5 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/80 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-words">{processError}</span>
          </div>
        )}

        {!canGenerate && missingMediaReason && (
          <div className="px-3 py-2.5 rounded-md border border-amber-300 dark:border-amber-700/70 bg-amber-50/80 dark:bg-amber-950/35 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{missingMediaReason}</span>
          </div>
        )}

        {onOpenImportSrt && (
          <div className="px-3 py-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/85 dark:bg-[#11162e] flex items-center justify-between gap-2.5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                Have a transcript or .SRT / .VTT?
              </p>
              <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] leading-snug">
                Paste a formatted AI transcript directly or import exact .SRT/.VTT timings.
              </p>
            </div>
            <button
              type="button"
              disabled={!canGenerate || isGenerating}
              onClick={onOpenImportSrt}
              className="h-8 px-3 rounded-md border border-teal-600/50 dark:border-teal-400/50 bg-white dark:bg-[#141933] hover:bg-teal-50 dark:hover:bg-teal-950/45 text-teal-800 dark:text-teal-200 text-[11px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
            >
              <FileUp className="w-3.5 h-3.5 shrink-0" />
              <span>Import / Paste</span>
            </button>
          </div>
        )}

        {/* 1. Quick Templates */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-teal-600 dark:text-teal-400" />
              <span>Quick Presets</span>
            </p>
            <span className="text-[10px] text-[#6d7a9e] dark:text-[#8e9cc4]">
              One-tap setup
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {SUBTITLE_GEN_PRESETS.map((preset) => {
              const active = isPresetMatchingConfig(config, preset);
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={isGenerating}
                  onClick={() => update(preset.patch)}
                  className={`px-2.5 py-2 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45 text-teal-900 dark:text-teal-100"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#11162e] hover:border-teal-600/45 dark:hover:border-teal-400/45 text-[#0c1026] dark:text-[#f3f5fc]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] font-mono-tabular font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
                      {preset.badge}
                    </span>
                  </div>
                  <p className="text-[11.5px] font-medium mt-0.5 leading-snug truncate font-myanmar">
                    {preset.label}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* 2. Languages (Source -> Target) */}
        <section className="space-y-2.5 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5">
            <Globe2 className="w-3 h-3 text-teal-600 dark:text-teal-400" />
            <span>Languages</span>
          </p>

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="space-y-1 min-w-0">
              <label
                htmlFor="subgen-source-lang"
                className="block text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4]"
              >
                Spoken Audio
              </label>
              <select
                id="subgen-source-lang"
                disabled={isGenerating}
                value={config.sourceLanguage}
                onChange={(e) =>
                  handleSourceChange(e.target.value as SubtitleSourceLanguage)
                }
                className="w-full h-9 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 cursor-pointer disabled:opacity-50"
              >
                {SOURCE_LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.label} ({lang.nativeLabel})
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={!canSwapLanguages || isGenerating}
              onClick={handleSwapLanguages}
              title="Swap spoken & translation languages"
              aria-label="Swap spoken and translation languages"
              className="h-9 w-9 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </button>

            <div className="space-y-1 min-w-0">
              <label
                htmlFor="subgen-target-lang"
                className="block text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4]"
              >
                Translate To
              </label>
              <select
                id="subgen-target-lang"
                disabled={isGenerating}
                value={config.targetLanguage}
                onChange={(e) =>
                  handleTargetChange(e.target.value as SubtitleTargetLanguage)
                }
                className="w-full h-9 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 cursor-pointer disabled:opacity-50"
              >
                {TARGET_LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.label} ({lang.nativeLabel})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* 3. Subtitle Format & Reading Style */}
        <section className="space-y-2.5 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5">
            <Languages className="w-3 h-3 text-teal-600 dark:text-teal-400" />
            <span>Subtitle Format</span>
          </p>

          <div className="grid grid-cols-2 gap-1.5">
            {SUBTITLE_FORMAT_OPTIONS.map((opt) => {
              const active = config.subtitleFormat === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isGenerating}
                  onClick={() => handleFormatChange(opt.id)}
                  className={`px-2.5 py-2 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45 text-teal-900 dark:text-teal-100"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45 dark:hover:border-teal-400/45 text-[#0c1026] dark:text-[#f3f5fc]"
                  }`}
                >
                  <p className="text-xs font-semibold leading-tight">{opt.label}</p>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                    {opt.desc}
                  </p>
                </button>
              );
            })}
          </div>

          {showPhoneticStyleSection && (
            <div className="space-y-1.5 pt-1">
              <p className="text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                Pronunciation / Reading Guide
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {PHONETIC_STYLE_OPTIONS.map((opt) => {
                  const active = config.phoneticStyle === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={isGenerating}
                      onClick={() => update({ phoneticStyle: opt.id })}
                      className={`px-2.5 py-1.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                        active
                          ? "border-indigo-600 dark:border-indigo-400 bg-indigo-50/75 dark:bg-indigo-950/45 text-indigo-950 dark:text-indigo-100"
                          : "border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/60 dark:bg-[#11162e] hover:border-indigo-500/45 text-[#0c1026] dark:text-[#f3f5fc]"
                      }`}
                    >
                      <p className="text-[11px] font-semibold leading-tight">
                        {opt.label}
                      </p>
                      <p className="text-[10px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 truncate font-myanmar">
                        {opt.example}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 4. Tone & Content Style */}
        <section className="space-y-2.5 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <p className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5">
            <SlidersHorizontal className="w-3 h-3 text-teal-600 dark:text-teal-400" />
            <span>Translation Tone &amp; Style</span>
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {SUBTITLE_GEN_TONE_OPTIONS.map((opt) => {
              const active = config.translationTone === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isGenerating}
                  onClick={() => update({ translationTone: opt.id })}
                  className={`px-2.5 py-1.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45 text-teal-900 dark:text-teal-100"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] hover:border-teal-600/45 dark:hover:border-teal-400/45 text-[#0c1026] dark:text-[#f3f5fc]"
                  }`}
                >
                  <p className="text-[11.5px] font-semibold leading-tight">
                    {opt.label}
                  </p>
                  <p className="text-[10px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                    {opt.desc}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Content Genre */}
          <div className="space-y-1.5 pt-1">
            <p className="text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Video Context / Genre
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {CONTENT_GENRE_OPTIONS.map((opt) => {
                const active = config.contentGenre === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isGenerating}
                    onClick={() => update({ contentGenre: opt.id })}
                    className={`h-8 px-2 rounded-md border text-[11px] font-medium transition-colors cursor-pointer truncate disabled:opacity-50 ${
                      active
                        ? "border-indigo-600 dark:border-indigo-400 bg-indigo-50/75 dark:bg-indigo-950/45 text-indigo-900 dark:text-indigo-100 font-semibold"
                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Line Pacing */}
          <div className="space-y-1.5 pt-1">
            <p className="text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Line Length &amp; Pacing
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {PACING_MODE_OPTIONS.map((opt) => {
                const active = config.pacingMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isGenerating}
                    onClick={() => update({ pacingMode: opt.id })}
                    className={`px-2 py-1.5 rounded-md border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                      active
                        ? "border-teal-600 dark:border-teal-400 bg-teal-50/75 dark:bg-teal-950/45 text-teal-900 dark:text-teal-100"
                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#11162e] text-[#0c1026] dark:text-[#f3f5fc]"
                    }`}
                  >
                    <p className="text-[11px] font-semibold leading-tight">
                      {opt.label}
                    </p>
                    <p className="text-[9.5px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                      {opt.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Extra Toggles */}
          <div className="space-y-1.5 pt-1">
            {showWordGlossToggle && (
              <label className="flex items-center justify-between gap-3 px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/60 dark:bg-[#11162e] cursor-pointer">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                    Word-by-Word Gloss
                  </p>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                    Add short meaning under each key word for learners
                  </p>
                </div>
                <input
                  type="checkbox"
                  disabled={isGenerating}
                  checked={config.includeWordGloss}
                  onChange={(e) =>
                    update({ includeWordGloss: e.target.checked })
                  }
                  className="h-4 w-4 accent-teal-600 dark:accent-teal-400 cursor-pointer shrink-0"
                />
              </label>
            )}

            {showNativeScriptToggle && (
              <label className="flex items-center justify-between gap-3 px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/60 dark:bg-[#11162e] cursor-pointer">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                    Include Native Script Line
                  </p>
                  <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                    Include original spoken script alongside phonetic/translation
                  </p>
                </div>
                <input
                  type="checkbox"
                  disabled={isGenerating}
                  checked={config.includeNativeScript}
                  onChange={(e) =>
                    update({ includeNativeScript: e.target.checked })
                  }
                  className="h-4 w-4 accent-teal-600 dark:accent-teal-400 cursor-pointer shrink-0"
                />
              </label>
            )}

            <label className="flex items-center justify-between gap-3 px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/60 dark:bg-[#11162e] cursor-pointer">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                  Non-Speech Cues
                </p>
                <p className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                  Include subtle cues like [laughter] or [sigh] when clear
                </p>
              </div>
              <input
                type="checkbox"
                disabled={isGenerating}
                checked={config.includeNonSpeech}
                onChange={(e) =>
                  update({ includeNonSpeech: e.target.checked })
                }
                className="h-4 w-4 accent-teal-600 dark:accent-teal-400 cursor-pointer shrink-0"
              />
            </label>
          </div>
        </section>

        {/* 5. Custom AI Prompt / Glossary */}
        <section className="space-y-2 pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="subgen-custom-instructions"
              className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] flex items-center gap-1.5"
            >
              <MessageSquareText className="w-3 h-3 text-teal-600 dark:text-teal-400" />
              <span>Custom AI Instructions (Optional)</span>
            </label>
            {config.customInstructions.trim() && (
              <button
                type="button"
                disabled={isGenerating}
                onClick={() => update({ customInstructions: "" })}
                className="text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          <textarea
            id="subgen-custom-instructions"
            disabled={isGenerating}
            rows={2}
            maxLength={600}
            value={config.customInstructions}
            onChange={(e) => update({ customInstructions: e.target.value })}
            placeholder="e.g. Speaker names, pronouns (ငါ/နင် vs ကျွန်တော်/ရှင်), slang, or glossary notes..."
            className="w-full px-2.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#070814] text-xs font-myanmar text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#6d7a9e]/75 dark:placeholder:text-[#7c89b2]/70 focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 resize-y disabled:opacity-50"
          />

          <div className="flex flex-wrap gap-1.5">
            {QUICK_GEN_INSTRUCTIONS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                disabled={isGenerating}
                onClick={() => handleAppendInstruction(chip.text)}
                className="h-6 px-2 rounded-xs border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[10.5px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer disabled:opacity-40 transition-colors"
              >
                + {chip.label}
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Sticky Footer Action Bar */}
      <div className="sticky bottom-0 z-20 px-3.5 py-3 border-t border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95 backdrop-blur-md space-y-2">
        {isGenerating ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 truncate">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-600 dark:text-teal-400 shrink-0" />
                <span className="truncate">
                  {generationProgress?.label || "Generating subtitles..."}
                </span>
              </span>
              {genPct !== null && (
                <span className="font-mono-tabular font-semibold text-teal-700 dark:text-teal-300 shrink-0">
                  {genPct}%
                </span>
              )}
            </div>
            <div className="h-1.5 w-full rounded-xs bg-[#e7ecf8] dark:bg-[#1a2142] overflow-hidden">
              <div
                className="h-full bg-teal-600 dark:bg-teal-400 transition-all duration-300"
                style={{ width: `${genPct ?? 12}%` }}
              />
            </div>
            {onCancelGenerate && (
              <button
                type="button"
                onClick={onCancelGenerate}
                className="w-full h-9 rounded-md border border-red-300 dark:border-red-800/70 bg-red-50/75 dark:bg-red-950/35 hover:bg-red-100/80 dark:hover:bg-red-900/50 text-xs font-semibold text-red-700 dark:text-red-300 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Cancel Generation</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-3.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer whitespace-nowrap transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={() => onStartGenerate(config)}
              className="flex-1 h-10 px-4 rounded-md bg-[#1c3db8] hover:bg-[#16319a] dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
            >
              {hasExistingSubtitles ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                  <span>Regenerate Subtitle</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span>Generate Subtitle</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
