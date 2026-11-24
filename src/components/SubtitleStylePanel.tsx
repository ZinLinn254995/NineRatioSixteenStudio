import { useEffect, useState } from "react";
import { RotateCcw, Sparkles, X } from "lucide-react";
import type {
  SubtitleFontScale,
  SubtitleHighlightColor,
  SubtitleTheme,
  VideoEditSettings,
} from "../types";
import { DEFAULT_VIDEO_EDIT } from "../utils/videoFilters";

export interface SubtitleStylePreset {
  id: "study_pro" | "clean_social" | "minimal_phonetic";
  label: string;
  description: string;
  values: Pick<
    VideoEditSettings,
    | "subtitleTheme"
    | "subtitleHighlightColor"
    | "subtitleFontScale"
    | "showThaiScript"
    | "showWordGloss"
    | "showBurmeseLine"
  >;
}

export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: "study_pro",
    label: "Study Pro",
    description: "Warm card, Thai script, gloss & Burmese",
    values: {
      subtitleTheme: "warm",
      subtitleHighlightColor: "amber",
      subtitleFontScale: "md",
      showThaiScript: true,
      showWordGloss: true,
      showBurmeseLine: true,
    },
  },
  {
    id: "clean_social",
    label: "Clean Social",
    description: "Dark large phonetic + Burmese",
    values: {
      subtitleTheme: "dark",
      subtitleHighlightColor: "emerald",
      subtitleFontScale: "lg",
      showThaiScript: false,
      showWordGloss: false,
      showBurmeseLine: true,
    },
  },
  {
    id: "minimal_phonetic",
    label: "Minimal Phonetic",
    description: "Light card, phonetic & word gloss",
    values: {
      subtitleTheme: "light",
      subtitleHighlightColor: "indigo",
      subtitleFontScale: "md",
      showThaiScript: false,
      showWordGloss: true,
      showBurmeseLine: false,
    },
  },
];

export function extractStyleSettingsSnapshot(
  settings: VideoEditSettings
): Pick<
  VideoEditSettings,
  | "subtitleTheme"
  | "subtitleHighlightColor"
  | "subtitleFontScale"
  | "showThaiScript"
  | "showWordGloss"
  | "showBurmeseLine"
  | "videoHeightPct"
> {
  return {
    subtitleTheme: settings.subtitleTheme,
    subtitleHighlightColor: settings.subtitleHighlightColor,
    subtitleFontScale: settings.subtitleFontScale,
    showThaiScript: settings.showThaiScript,
    showWordGloss: settings.showWordGloss,
    showBurmeseLine: settings.showBurmeseLine,
    videoHeightPct: settings.videoHeightPct,
  };
}

interface SubtitleStylePanelProps {
  editSettings: VideoEditSettings;
  onChangeEditSettings: (next: VideoEditSettings) => void;
}

export function SubtitleStylePanel({
  editSettings,
  onChangeEditSettings,
}: SubtitleStylePanelProps) {
  const [presetToast, setPresetToast] = useState<{
    presetLabel: string;
    previousSettings: VideoEditSettings;
  } | null>(null);

  useEffect(() => {
    if (!presetToast) return;
    const timer = window.setTimeout(() => {
      setPresetToast(null);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [presetToast]);

  const applyPreset = (preset: SubtitleStylePreset) => {
    const previousSnapshot: VideoEditSettings = { ...editSettings };
    onChangeEditSettings({
      ...editSettings,
      ...preset.values,
    });
    setPresetToast({
      presetLabel: preset.label,
      previousSettings: previousSnapshot,
    });
  };

  const handleUndoPreset = () => {
    if (!presetToast) return;
    const prev = presetToast.previousSettings;
    onChangeEditSettings({
      ...editSettings,
      subtitleTheme: prev.subtitleTheme,
      subtitleHighlightColor: prev.subtitleHighlightColor,
      subtitleFontScale: prev.subtitleFontScale,
      showThaiScript: prev.showThaiScript,
      showWordGloss: prev.showWordGloss,
      showBurmeseLine: prev.showBurmeseLine,
    });
    setPresetToast(null);
  };

  const styleCustomized =
    editSettings.subtitleFontScale !== DEFAULT_VIDEO_EDIT.subtitleFontScale ||
    editSettings.subtitleTheme !== DEFAULT_VIDEO_EDIT.subtitleTheme ||
    editSettings.subtitleHighlightColor !== DEFAULT_VIDEO_EDIT.subtitleHighlightColor ||
    editSettings.showThaiScript !== DEFAULT_VIDEO_EDIT.showThaiScript ||
    editSettings.showWordGloss !== DEFAULT_VIDEO_EDIT.showWordGloss ||
    editSettings.showBurmeseLine !== DEFAULT_VIDEO_EDIT.showBurmeseLine ||
    editSettings.videoHeightPct !== DEFAULT_VIDEO_EDIT.videoHeightPct;

  const isPresetActive = (preset: SubtitleStylePreset) =>
    editSettings.subtitleTheme === preset.values.subtitleTheme &&
    editSettings.subtitleHighlightColor === preset.values.subtitleHighlightColor &&
    editSettings.subtitleFontScale === preset.values.subtitleFontScale &&
    editSettings.showThaiScript === preset.values.showThaiScript &&
    editSettings.showWordGloss === preset.values.showWordGloss &&
    editSettings.showBurmeseLine === preset.values.showBurmeseLine;

  return (
    <div className="px-3.5 py-3 space-y-4">
      {/* Non-blocking Preset Undo Toast */}
      {presetToast && (
        <div
          role="status"
          aria-live="polite"
          className="px-3 py-2 rounded-sm border border-teal-600/40 dark:border-teal-400/40 bg-teal-50/90 dark:bg-teal-950/60 flex items-center justify-between gap-2 text-xs text-teal-900 dark:text-teal-100"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
            <span className="truncate font-medium">
              Applied {presetToast.presetLabel}
            </span>
            <span aria-hidden="true" className="text-teal-700/60 dark:text-teal-300/60">
              ·
            </span>
            <button
              type="button"
              onClick={handleUndoPreset}
              className="font-semibold underline text-teal-700 dark:text-teal-300 hover:text-teal-900 dark:hover:text-white cursor-pointer shrink-0"
            >
              Undo preset
            </button>
          </div>
          <button
            type="button"
            onClick={() => setPresetToast(null)}
            aria-label="Dismiss preset notification"
            className="p-0.5 text-teal-700/70 dark:text-teal-300/70 hover:text-teal-900 dark:hover:text-white cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 1-Click Style Presets */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
            Style Presets
          </span>
          {styleCustomized && (
            <button
              type="button"
              onClick={() =>
                onChangeEditSettings({
                  ...editSettings,
                  subtitleFontScale: DEFAULT_VIDEO_EDIT.subtitleFontScale,
                  subtitleTheme: DEFAULT_VIDEO_EDIT.subtitleTheme,
                  subtitleHighlightColor: DEFAULT_VIDEO_EDIT.subtitleHighlightColor,
                  showThaiScript: DEFAULT_VIDEO_EDIT.showThaiScript,
                  showWordGloss: DEFAULT_VIDEO_EDIT.showWordGloss,
                  showBurmeseLine: DEFAULT_VIDEO_EDIT.showBurmeseLine,
                  videoHeightPct: DEFAULT_VIDEO_EDIT.videoHeightPct,
                })
              }
              className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-teal-700 dark:hover:text-teal-400 inline-flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
          {SUBTITLE_STYLE_PRESETS.map((preset) => {
            const active = isPresetActive(preset);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`px-2.5 py-2 rounded-sm border text-left transition-colors cursor-pointer ${
                  active
                    ? "border-teal-600 bg-teal-50/90 dark:border-teal-400 dark:bg-teal-950/60"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50"
                }`}
              >
                <span
                  className={`block text-xs font-semibold ${
                    active
                      ? "text-teal-800 dark:text-teal-200"
                      : "text-[#0c1026] dark:text-[#f3f5fc]"
                  }`}
                >
                  {preset.label}
                </span>
                <span className="block text-[10px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                  {preset.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Visibility Toggles */}
      <div className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2">
        <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
          Visible Lines
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
          {(
            [
              { key: "showThaiScript", label: "Thai Script" },
              { key: "showWordGloss", label: "Word Gloss" },
              { key: "showBurmeseLine", label: "Burmese Line" },
            ] as const
          ).map((item) => {
            const checked = editSettings[item.key];
            return (
              <button
                key={item.key}
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() =>
                  onChangeEditSettings({
                    ...editSettings,
                    [item.key]: !checked,
                  })
                }
                className={`h-8 px-2.5 rounded-sm border text-xs font-medium flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                  checked
                    ? "border-teal-600/70 bg-teal-50/80 text-teal-800 dark:border-teal-400/70 dark:bg-teal-950/50 dark:text-teal-200"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                <span className="truncate">{item.label}</span>
                <span
                  aria-hidden="true"
                  className={`w-6 h-3.5 rounded-full p-0.5 transition-colors flex items-center shrink-0 ${
                    checked
                      ? "bg-teal-700 dark:bg-teal-400 justify-end"
                      : "bg-[#bcc9e6] dark:bg-[#2e3644] justify-start"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-white shadow-xs" />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Theme, Size, Highlight */}
      <div className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#4d597d] dark:text-[#919ec4]">
            Card Theme
          </span>
          <div className="inline-flex items-center p-0.5 rounded-sm bg-[#f3f5fc] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]">
            {(
              [
                { id: "auto", label: "Auto" },
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
                { id: "warm", label: "Warm" },
              ] as { id: SubtitleTheme; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  onChangeEditSettings({ ...editSettings, subtitleTheme: t.id })
                }
                className={`px-2.5 py-1 rounded-xs text-[11px] font-medium cursor-pointer transition-colors ${
                  editSettings.subtitleTheme === t.id
                    ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 font-semibold shadow-xs"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#4d597d] dark:text-[#919ec4]">
            Font Scale
          </span>
          <div className="inline-flex items-center p-0.5 rounded-sm bg-[#f3f5fc] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]">
            {(
              [
                { id: "sm", label: "S" },
                { id: "md", label: "M" },
                { id: "lg", label: "L" },
              ] as { id: SubtitleFontScale; label: string }[]
            ).map((sz) => (
              <button
                key={sz.id}
                type="button"
                onClick={() =>
                  onChangeEditSettings({
                    ...editSettings,
                    subtitleFontScale: sz.id,
                  })
                }
                className={`px-3 py-1 rounded-xs text-[11px] font-semibold cursor-pointer transition-colors ${
                  editSettings.subtitleFontScale === sz.id
                    ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 shadow-xs"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                {sz.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#4d597d] dark:text-[#919ec4]">
            Active Word Highlight
          </span>
          <div className="flex items-center gap-2">
            {(
              [
                { id: "indigo", swatch: "bg-[#1c3db8]", label: "Blue" },
                { id: "rose", swatch: "bg-[#8b2574]", label: "Orchid" },
                { id: "amber", swatch: "bg-[#b86310]", label: "Amber" },
                { id: "emerald", swatch: "bg-[#0f7d5d]", label: "Emerald" },
              ] as { id: SubtitleHighlightColor; swatch: string; label: string }[]
            ).map((c) => {
              const selected = editSettings.subtitleHighlightColor === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  title={c.label}
                  aria-label={`Highlight color ${c.label}`}
                  onClick={() =>
                    onChangeEditSettings({
                      ...editSettings,
                      subtitleHighlightColor: c.id,
                    })
                  }
                  className={`w-5 h-5 rounded-full ${c.swatch} cursor-pointer transition-transform ${
                    selected
                      ? "ring-2 ring-offset-2 ring-teal-700 dark:ring-teal-400 dark:ring-offset-[#0d1022] scale-110"
                      : "opacity-75 hover:opacity-100"
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Stage Split (Video Height %) */}
      <div className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-[#4d597d] dark:text-[#919ec4]">
            Stage Split (Video Height)
          </span>
          <span className="font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
            {editSettings.videoHeightPct}%
          </span>
        </div>
        <input
          type="range"
          min={26}
          max={52}
          step={1}
          value={editSettings.videoHeightPct}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            if (Number.isFinite(next)) {
              onChangeEditSettings({
                ...editSettings,
                videoHeightPct: Math.max(26, Math.min(52, next)),
              });
            }
          }}
          aria-label="Top video height percentage"
          className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
        />
        <div className="flex items-center justify-between text-[10px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
          <span>26% Compact video</span>
          <span>52% Tall video</span>
        </div>
      </div>
    </div>
  );
}
