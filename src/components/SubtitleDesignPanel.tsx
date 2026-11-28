import {
  AlignCenter,
  AlignLeft,
  Captions,
  Check,
  RotateCcw,
} from "lucide-react";
import type {
  SubtitleAlign,
  SubtitleCardStyle,
  SubtitleFontFamily,
  SubtitleHighlightColor,
  SubtitleLineSpacing,
  SubtitleTextWeight,
  SubtitleTheme,
  SubtitleWordStyle,
  VideoEditSettings,
} from "../types";
import {
  DEFAULT_SUBTITLE_OVERLAY_X,
  DEFAULT_SUBTITLE_OVERLAY_Y,
  DEFAULT_VIDEO_EDIT,
  resolveStageCanvasGeometry,
  resolveSubtitleFontStack,
} from "../utils/videoFilters";
import {
  applySubtitlePresetValues,
  extractSubtitlePresetValues,
  isSubtitlePresetMatch,
} from "../utils/customPresets";
import { CustomPresetsBar } from "./CustomPresetsBar";

interface SubtitleDesignPanelProps {
  settings: VideoEditSettings;
  hasSubtitles: boolean;
  onChange: (next: VideoEditSettings) => void;
}

interface SubtitleDesignPreset {
  id: string;
  label: string;
  previewBg: string;
  previewBorder: string;
  previewText: string;
  previewAccent: string;
  patch: Partial<VideoEditSettings>;
}

const SUBTITLE_DESIGN_PRESETS: SubtitleDesignPreset[] = [
  {
    id: "studio-classic",
    label: "Studio",
    previewBg: "bg-[#f8faff] dark:bg-[#101633]",
    previewBorder: "border-[#8da2ea] dark:border-[#4e7ef7]/55",
    previewText: "text-[#0c1026] dark:text-[#f3f5fc]",
    previewAccent: "bg-[#1c3db8] text-white",
    patch: {
      subtitleTheme: "auto",
      subtitleHighlightColor: "indigo",
      subtitleCardStyle: "card",
      subtitleWordStyle: "fill",
      subtitleFontFamily: "sans",
      subtitleAlign: "left",
      subtitleSizePct: 100,
      subtitleFontScale: "md",
      subtitleCardRadius: 18,
      subtitleTextWeight: "semibold",
      subtitleLineSpacing: "normal",
    },
  },
  {
    id: "cinema-dark",
    label: "Cinema",
    previewBg: "bg-[#080b1a]",
    previewBorder: "border-[#fbbf24]/50",
    previewText: "text-white",
    previewAccent: "bg-amber-400/25 text-amber-200 ring-1 ring-amber-400/50",
    patch: {
      subtitleTheme: "dark",
      subtitleHighlightColor: "amber",
      subtitleCardStyle: "glass",
      subtitleWordStyle: "glow",
      subtitleFontFamily: "display",
      subtitleAlign: "center",
      subtitleSizePct: 108,
      subtitleFontScale: "md",
      subtitleCardRadius: 20,
      subtitleTextWeight: "semibold",
      subtitleLineSpacing: "normal",
    },
  },
  {
    id: "warm-editorial",
    label: "Editorial",
    previewBg: "bg-[#fbf7ef]",
    previewBorder: "border-[#dfae52]",
    previewText: "text-[#1c1917]",
    previewAccent: "text-[#b45309] border-b-2 border-[#d97706] rounded-none",
    patch: {
      subtitleTheme: "warm",
      subtitleHighlightColor: "amber",
      subtitleCardStyle: "minimal",
      subtitleWordStyle: "underline",
      subtitleFontFamily: "serif",
      subtitleAlign: "left",
      subtitleSizePct: 100,
      subtitleFontScale: "md",
      subtitleCardRadius: 8,
      subtitleTextWeight: "semibold",
      subtitleLineSpacing: "relaxed",
    },
  },
  {
    id: "bold-pop",
    label: "Bold Pop",
    previewBg: "bg-[#0c112b]",
    previewBorder: "border-white/85",
    previewText: "text-white",
    previewAccent: "bg-rose-500 text-white",
    patch: {
      subtitleTheme: "dark",
      subtitleHighlightColor: "rose",
      subtitleCardStyle: "outline",
      subtitleWordStyle: "fill",
      subtitleFontFamily: "display",
      subtitleAlign: "center",
      subtitleSizePct: 118,
      subtitleFontScale: "lg",
      subtitleCardRadius: 14,
      subtitleTextWeight: "bold",
      subtitleLineSpacing: "compact",
    },
  },
  {
    id: "crisp-light",
    label: "Crisp Light",
    previewBg: "bg-white",
    previewBorder: "border-[#cbd5e1]",
    previewText: "text-[#0f172a]",
    previewAccent: "bg-[#0d7456] text-white",
    patch: {
      subtitleTheme: "light",
      subtitleHighlightColor: "emerald",
      subtitleCardStyle: "card",
      subtitleWordStyle: "fill",
      subtitleFontFamily: "sans",
      subtitleAlign: "left",
      subtitleSizePct: 100,
      subtitleFontScale: "md",
      subtitleCardRadius: 16,
      subtitleTextWeight: "semibold",
      subtitleLineSpacing: "normal",
    },
  },
  {
    id: "clean-minimal",
    label: "Minimal",
    previewBg: "bg-[#eef2fc] dark:bg-[#0d1022]",
    previewBorder: "border-[#bcc9e6] dark:border-[#2a3466]",
    previewText: "text-[#0c1026] dark:text-[#f3f5fc]",
    previewAccent: "text-[#1c3db8] dark:text-[#7ca3fb]",
    patch: {
      subtitleTheme: "auto",
      subtitleHighlightColor: "indigo",
      subtitleCardStyle: "minimal",
      subtitleWordStyle: "text",
      subtitleFontFamily: "sans",
      subtitleAlign: "center",
      subtitleSizePct: 95,
      subtitleFontScale: "md",
      subtitleCardRadius: 0,
      subtitleTextWeight: "semibold",
      subtitleLineSpacing: "compact",
    },
  },
];

const THEME_OPTIONS: {
  id: SubtitleTheme;
  label: string;
  swatchClass: string;
}[] = [
  {
    id: "auto",
    label: "Auto",
    swatchClass: "bg-gradient-to-br from-white via-[#eef2ff] to-[#0d1022] border-[#94a3b8]",
  },
  {
    id: "light",
    label: "Light",
    swatchClass: "bg-white border-[#cbd5e1]",
  },
  {
    id: "dark",
    label: "Dark",
    swatchClass: "bg-[#080b1a] border-[#334155]",
  },
  {
    id: "warm",
    label: "Warm",
    swatchClass: "bg-[#fbf7ef] border-[#dfae52]",
  },
];

const HIGHLIGHT_COLORS: {
  id: SubtitleHighlightColor;
  label: string;
  dotClass: string;
}[] = [
  { id: "indigo", label: "Indigo", dotClass: "bg-[#2952d6]" },
  { id: "amber", label: "Amber", dotClass: "bg-[#d97706]" },
  { id: "emerald", label: "Emerald", dotClass: "bg-[#0d9468]" },
  { id: "rose", label: "Rose", dotClass: "bg-[#be185d]" },
];

const CARD_STYLE_OPTIONS: { id: SubtitleCardStyle; label: string }[] = [
  { id: "card", label: "Card" },
  { id: "minimal", label: "Minimal" },
  { id: "outline", label: "Outline" },
  { id: "glass", label: "Glass" },
];

const WORD_STYLE_OPTIONS: { id: SubtitleWordStyle; label: string }[] = [
  { id: "fill", label: "Fill" },
  { id: "underline", label: "Underline" },
  { id: "glow", label: "Glow" },
  { id: "text", label: "Text" },
];

const FONT_OPTIONS: { id: SubtitleFontFamily; label: string; sample: string }[] = [
  { id: "sans", label: "Sans", sample: "Aa" },
  { id: "display", label: "Display", sample: "Aa" },
  { id: "serif", label: "Serif", sample: "Aa" },
  { id: "mono", label: "Mono", sample: "Aa" },
];

const WEIGHT_OPTIONS: { id: SubtitleTextWeight; label: string }[] = [
  { id: "normal", label: "Regular" },
  { id: "semibold", label: "SemiBold" },
  { id: "bold", label: "Bold" },
];

const SPACING_OPTIONS: { id: SubtitleLineSpacing; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "normal", label: "Normal" },
  { id: "relaxed", label: "Relaxed" },
];

export function isSubtitleDesignModified(settings: VideoEditSettings): boolean {
  return (
    settings.subtitleTheme !== DEFAULT_VIDEO_EDIT.subtitleTheme ||
    settings.subtitleHighlightColor !== DEFAULT_VIDEO_EDIT.subtitleHighlightColor ||
    (settings.subtitleCardStyle ?? DEFAULT_VIDEO_EDIT.subtitleCardStyle) !==
      DEFAULT_VIDEO_EDIT.subtitleCardStyle ||
    (settings.subtitleWordStyle ?? DEFAULT_VIDEO_EDIT.subtitleWordStyle) !==
      DEFAULT_VIDEO_EDIT.subtitleWordStyle ||
    (settings.subtitleFontFamily ?? DEFAULT_VIDEO_EDIT.subtitleFontFamily) !==
      DEFAULT_VIDEO_EDIT.subtitleFontFamily ||
    (settings.subtitleAlign ?? DEFAULT_VIDEO_EDIT.subtitleAlign) !==
      DEFAULT_VIDEO_EDIT.subtitleAlign ||
    (settings.subtitleSizePct ?? DEFAULT_VIDEO_EDIT.subtitleSizePct ?? 100) !==
      (DEFAULT_VIDEO_EDIT.subtitleSizePct ?? 100) ||
    (settings.subtitleCardRadius ?? DEFAULT_VIDEO_EDIT.subtitleCardRadius ?? 18) !==
      (DEFAULT_VIDEO_EDIT.subtitleCardRadius ?? 18) ||
    (settings.subtitleTextWeight ?? DEFAULT_VIDEO_EDIT.subtitleTextWeight) !==
      DEFAULT_VIDEO_EDIT.subtitleTextWeight ||
    (settings.subtitleLineSpacing ?? DEFAULT_VIDEO_EDIT.subtitleLineSpacing) !==
      DEFAULT_VIDEO_EDIT.subtitleLineSpacing ||
    settings.showThaiScript !== DEFAULT_VIDEO_EDIT.showThaiScript ||
    settings.showWordGloss !== DEFAULT_VIDEO_EDIT.showWordGloss ||
    settings.showBurmeseLine !== DEFAULT_VIDEO_EDIT.showBurmeseLine ||
    (settings.subtitleOverlayX ?? DEFAULT_SUBTITLE_OVERLAY_X) !==
      DEFAULT_SUBTITLE_OVERLAY_X ||
    (settings.subtitleOverlayY ?? DEFAULT_SUBTITLE_OVERLAY_Y) !==
      DEFAULT_SUBTITLE_OVERLAY_Y
  );
}

export function SubtitleDesignPanel({
  settings,
  hasSubtitles,
  onChange,
}: SubtitleDesignPanelProps) {
  const theme = settings.subtitleTheme || "auto";
  const highlight = settings.subtitleHighlightColor || "indigo";
  const cardStyle = settings.subtitleCardStyle || "card";
  const wordStyle = settings.subtitleWordStyle || "fill";
  const fontFamily = settings.subtitleFontFamily || "sans";
  const align: SubtitleAlign = settings.subtitleAlign || "left";
  const sizePct =
    typeof settings.subtitleSizePct === "number" && Number.isFinite(settings.subtitleSizePct)
      ? Math.round(settings.subtitleSizePct)
      : settings.subtitleFontScale === "sm"
        ? 86
        : settings.subtitleFontScale === "lg"
          ? 116
          : 100;
  const cardRadius =
    typeof settings.subtitleCardRadius === "number" && Number.isFinite(settings.subtitleCardRadius)
      ? Math.round(settings.subtitleCardRadius)
      : 18;
  const textWeight = settings.subtitleTextWeight || "semibold";
  const lineSpacing = settings.subtitleLineSpacing || "normal";
  const showWordGloss = settings.showWordGloss !== false;
  const showBurmeseLine = settings.showBurmeseLine !== false;
  const showThaiScript = Boolean(settings.showThaiScript);
  const videoHeightPct = Math.round(settings.videoHeightPct ?? 35);
  const overlayX =
    typeof settings.subtitleOverlayX === "number" && Number.isFinite(settings.subtitleOverlayX)
      ? Math.max(-50, Math.min(50, Math.round(settings.subtitleOverlayX)))
      : DEFAULT_SUBTITLE_OVERLAY_X;
  const overlayY =
    typeof settings.subtitleOverlayY === "number" && Number.isFinite(settings.subtitleOverlayY)
      ? Math.max(0, Math.min(100, Math.round(settings.subtitleOverlayY)))
      : DEFAULT_SUBTITLE_OVERLAY_Y;
  const isOverlayLayout = !resolveStageCanvasGeometry(settings.aspectRatio).isPortraitSplitFriendly;
  const overlayModified =
    overlayX !== DEFAULT_SUBTITLE_OVERLAY_X || overlayY !== DEFAULT_SUBTITLE_OVERLAY_Y;

  const modified = isSubtitleDesignModified(settings);

  const update = (patch: Partial<VideoEditSettings>) => {
    onChange({
      ...settings,
      ...patch,
    });
  };

  const updateSizePct = (nextPct: number) => {
    const clamped = Math.max(75, Math.min(140, Math.round(nextPct)));
    const nextScale = clamped <= 90 ? "sm" : clamped >= 112 ? "lg" : "md";
    update({
      subtitleSizePct: clamped,
      subtitleFontScale: nextScale,
    });
  };

  const handleResetSubtitleDesign = () => {
    update({
      subtitleTheme: DEFAULT_VIDEO_EDIT.subtitleTheme,
      subtitleHighlightColor: DEFAULT_VIDEO_EDIT.subtitleHighlightColor,
      subtitleFontScale: DEFAULT_VIDEO_EDIT.subtitleFontScale,
      subtitleCardStyle: DEFAULT_VIDEO_EDIT.subtitleCardStyle,
      subtitleWordStyle: DEFAULT_VIDEO_EDIT.subtitleWordStyle,
      subtitleFontFamily: DEFAULT_VIDEO_EDIT.subtitleFontFamily,
      subtitleAlign: DEFAULT_VIDEO_EDIT.subtitleAlign,
      subtitleSizePct: DEFAULT_VIDEO_EDIT.subtitleSizePct,
      subtitleCardRadius: DEFAULT_VIDEO_EDIT.subtitleCardRadius,
      subtitleTextWeight: DEFAULT_VIDEO_EDIT.subtitleTextWeight,
      subtitleLineSpacing: DEFAULT_VIDEO_EDIT.subtitleLineSpacing,
      showThaiScript: DEFAULT_VIDEO_EDIT.showThaiScript,
      showWordGloss: DEFAULT_VIDEO_EDIT.showWordGloss,
      showBurmeseLine: DEFAULT_VIDEO_EDIT.showBurmeseLine,
      videoHeightPct: DEFAULT_VIDEO_EDIT.videoHeightPct,
      subtitleOverlayX: DEFAULT_SUBTITLE_OVERLAY_X,
      subtitleOverlayY: DEFAULT_SUBTITLE_OVERLAY_Y,
    });
  };

  // Live miniature sample styles so users can preview design even before generating subtitles
  const sampleContainerClass =
    theme === "light"
      ? "bg-[#f8faff] border-[#d2dcf0]"
      : theme === "dark"
        ? "bg-[#080b1a] border-[#21284c]"
        : theme === "warm"
          ? "bg-[#fbf7ef] border-[#e7dcc8]"
          : "bg-[#f8faff] dark:bg-[#080b1a] border-[#d2dcf0] dark:border-[#21284c]";

  const sampleCardClass = (() => {
    if (cardStyle === "minimal") return "bg-transparent border-b border-current/20";
    if (cardStyle === "outline") {
      if (theme === "light") return "bg-white border-2 border-[#0c1026]";
      if (theme === "dark") return "bg-[#0c112b] border-2 border-white/85";
      if (theme === "warm") return "bg-[#fffdf8] border-2 border-[#92400e]";
      return "bg-white dark:bg-[#0c112b] border-2 border-[#0c1026] dark:border-white/85";
    }
    if (cardStyle === "glass") {
      if (theme === "light") return "bg-white/75 border border-white shadow-xs";
      if (theme === "dark") return "bg-[#17214d]/75 border border-[#6e96ff]/40";
      if (theme === "warm") return "bg-[#fffaf0]/80 border border-[#dfae52]/65";
      return "bg-white/75 dark:bg-[#17214d]/75 border border-white dark:border-[#6e96ff]/40";
    }
    if (theme === "light") return "bg-white border border-[#8da2ea]";
    if (theme === "dark") return "bg-[#12183a] border border-[#4e7ef7]/50";
    if (theme === "warm") return "bg-[#fffdf8] border border-[#dfae52]";
    return "bg-white dark:bg-[#12183a] border border-[#8da2ea] dark:border-[#4e7ef7]/50";
  })();

  const sampleActiveWordClass = (() => {
    if (wordStyle === "underline") {
      if (highlight === "emerald") return "text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-500 rounded-none";
      if (highlight === "rose") return "text-rose-600 dark:text-rose-400 border-b-2 border-rose-500 rounded-none";
      if (highlight === "amber") return "text-amber-600 dark:text-amber-400 border-b-2 border-amber-500 rounded-none";
      return "text-[#1c3db8] dark:text-[#7ca3fb] border-b-2 border-[#264cd6] dark:border-[#5b85f7] rounded-none";
    }
    if (wordStyle === "glow") {
      if (highlight === "emerald") return "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200 ring-1 ring-emerald-500/45";
      if (highlight === "rose") return "bg-rose-500/20 text-rose-700 dark:text-rose-200 ring-1 ring-rose-500/45";
      if (highlight === "amber") return "bg-amber-500/20 text-amber-800 dark:text-amber-200 ring-1 ring-amber-500/45";
      return "bg-[#355feb]/20 text-[#1c3db8] dark:text-[#a8c3fa] ring-1 ring-[#4e7ef7]/45";
    }
    if (wordStyle === "text") {
      if (highlight === "emerald") return "text-emerald-600 dark:text-emerald-400";
      if (highlight === "rose") return "text-rose-600 dark:text-rose-400";
      if (highlight === "amber") return "text-amber-600 dark:text-amber-400";
      return "text-[#1c3db8] dark:text-[#7ca3fb]";
    }
    if (highlight === "emerald") return "bg-[#0d7456] text-white";
    if (highlight === "rose") return "bg-[#a12f88] text-white";
    if (highlight === "amber") return "bg-[#cc801a] text-white";
    return "bg-[#1c3db8] dark:bg-[#2952d6] text-white";
  })();

  const sampleTextClass =
    theme === "dark"
      ? "text-[#e2e8f0]"
      : theme === "warm"
        ? "text-[#292524]"
        : theme === "light"
          ? "text-[#1e293b]"
          : "text-[#1e293b] dark:text-[#e2e8f0]";

  const sampleMutedClass =
    theme === "dark"
      ? "text-[#94a3b8]"
      : theme === "warm"
        ? "text-[#78716c]"
        : theme === "light"
          ? "text-[#4d597d]"
          : "text-[#4d597d] dark:text-[#94a3b8]";

  const sampleWeightClass =
    textWeight === "bold"
      ? "font-bold"
      : textWeight === "normal"
        ? "font-normal"
        : "font-semibold";

  const canResetSubtitle =
    modified || videoHeightPct !== DEFAULT_VIDEO_EDIT.videoHeightPct;

  return (
    <div className="px-3.5 py-3 flex flex-col gap-3.5 pb-8">
      {/* Unified Tab Header with per-tab Reset */}
      <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#d2dcf0] dark:border-[#21284c]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Captions className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
          <h3 className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
            Subtitle
          </h3>
        </div>
        <button
          type="button"
          disabled={!canResetSubtitle}
          onClick={handleResetSubtitleDesign}
          className="h-7 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-teal-600/50 dark:hover:border-teal-400/50 hover:text-teal-700 dark:hover:text-teal-300 text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[#d2dcf0] dark:disabled:hover:border-[#21284c] disabled:hover:text-[#4d597d] dark:disabled:hover:text-[#919ec4] transition-colors"
        >
          <RotateCcw className="w-3 h-3 shrink-0" />
          <span>Reset Subtitle</span>
        </button>
      </div>

      {/* Live Style Sample Card (always visible when no subtitles exist yet, compact reference otherwise) */}
      {!hasSubtitles && (
        <div
          className={`rounded-xl border p-3 transition-colors ${sampleContainerClass}`}
          style={{ fontFamily: resolveSubtitleFontStack(fontFamily) }}
        >
          <div
            style={{
              borderRadius: cardStyle === "minimal" ? "0px" : `${Math.round(cardRadius * 0.7)}px`,
            }}
            className={`px-3 py-2.5 transition-colors ${sampleCardClass} ${
              align === "center" ? "text-center" : "text-left"
            }`}
          >
            <div
              className={`flex flex-wrap items-start gap-1.5 ${
                align === "center" ? "justify-center" : "justify-start"
              }`}
            >
              <span className={`inline-flex flex-col ${align === "center" ? "items-center" : "items-start"}`}>
                <span
                  style={{ fontSize: `${Math.round(13 * (sizePct / 100))}px` }}
                  className={`${sampleWeightClass} px-1.5 py-0.5 rounded-md leading-tight ${sampleActiveWordClass}`}
                >
                  sà-wàt-dii
                </span>
                {showWordGloss && (
                  <span className={`font-myanmar text-[9.5px] mt-0.5 px-1 ${sampleMutedClass}`}>
                    မင်္ဂလာပါ
                  </span>
                )}
              </span>
              <span className={`inline-flex flex-col ${align === "center" ? "items-center" : "items-start"}`}>
                <span
                  style={{ fontSize: `${Math.round(13 * (sizePct / 100))}px` }}
                  className={`${sampleWeightClass} px-1 py-0.5 leading-tight ${sampleTextClass}`}
                >
                  khráp
                </span>
                {showWordGloss && (
                  <span className={`font-myanmar text-[9.5px] mt-0.5 px-1 ${sampleMutedClass}`}>
                    ခင်ဗျာ
                  </span>
                )}
              </span>
            </div>
            {showThaiScript && (
              <p
                style={{ fontFamily: "'Noto Sans Thai', 'DM Sans', sans-serif" }}
                className={`text-[11px] mt-1.5 ${sampleMutedClass}`}
              >
                สวัสดีครับ
              </p>
            )}
            {showBurmeseLine && (
              <p
                style={{ fontSize: `${Math.round(12 * (sizePct / 100))}px` }}
                className={`font-myanmar mt-1.5 pt-1.5 border-t border-current/10 font-medium ${sampleTextClass}`}
              >
                မင်္ဂလာပါ ခင်ဗျာ
              </p>
            )}
          </div>
        </div>
      )}

      {/* 1. One-Tap Style Presets */}
      <section className="space-y-2">
        <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
          Style Presets
        </p>
        <div className="grid grid-cols-3 gap-2">
          {SUBTITLE_DESIGN_PRESETS.map((preset) => {
            const isSelected =
              theme === preset.patch.subtitleTheme &&
              highlight === preset.patch.subtitleHighlightColor &&
              cardStyle === preset.patch.subtitleCardStyle &&
              wordStyle === preset.patch.subtitleWordStyle &&
              fontFamily === preset.patch.subtitleFontFamily;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => update(preset.patch)}
                className={`group rounded-xl border p-2 text-left flex flex-col gap-1.5 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500 ${
                  isSelected
                    ? "border-teal-600 dark:border-teal-400 bg-teal-50/70 dark:bg-teal-950/35"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-[#9eb1de] dark:hover:border-[#364378]"
                }`}
              >
                <div
                  className={`h-9 w-full rounded-lg border flex items-center justify-center gap-1 px-1.5 ${preset.previewBg} ${preset.previewBorder}`}
                >
                  <span
                    className={`text-[10px] font-bold px-1 py-0.5 rounded leading-none ${preset.previewAccent}`}
                  >
                    Aa
                  </span>
                  <span className={`text-[10px] font-medium leading-none opacity-80 ${preset.previewText}`}>
                    စာ
                  </span>
                </div>
                <div className="flex items-center justify-between gap-1 px-0.5">
                  <span className="text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] truncate">
                    {preset.label}
                  </span>
                  {isSelected && (
                    <Check className="w-3 h-3 text-teal-700 dark:text-teal-400 shrink-0" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 2. Theme & Active Word Highlight */}
      <section className="space-y-3 pt-3 border-t border-[#d2dcf0]/80 dark:border-[#21284c]">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Theme
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {THEME_OPTIONS.map((opt) => {
              const active = theme === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update({ subtitleTheme: opt.id })}
                  className={`h-10 px-2 rounded-lg border flex items-center justify-center gap-1.5 text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/80 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200 font-semibold"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#f3f5fc] dark:hover:bg-[#141933]"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 rounded-full border shrink-0 ${opt.swatchClass}`}
                  />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Active Word Color
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {HIGHLIGHT_COLORS.map((c) => {
              const active = highlight === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => update({ subtitleHighlightColor: c.id })}
                  className={`h-10 px-2 rounded-lg border flex items-center justify-center gap-1.5 text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/80 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200 font-semibold"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#f3f5fc] dark:hover:bg-[#141933]"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ${c.dotClass}`}
                  />
                  <span>{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Active Word Effect
          </p>
          <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
            {WORD_STYLE_OPTIONS.map((opt) => {
              const active = wordStyle === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update({ subtitleWordStyle: opt.id })}
                  className={`h-9 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* 3. Typography */}
      <section className="space-y-3 pt-3 border-t border-[#d2dcf0]/80 dark:border-[#21284c]">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Font Style
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {FONT_OPTIONS.map((f) => {
              const active = fontFamily === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => update({ subtitleFontFamily: f.id })}
                  className={`h-12 px-2 rounded-lg border flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
                    active
                      ? "border-teal-600 dark:border-teal-400 bg-teal-50/80 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200"
                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#f3f5fc] dark:hover:bg-[#141933]"
                  }`}
                >
                  <span
                    style={{ fontFamily: resolveSubtitleFontStack(f.id) }}
                    className="text-sm font-semibold leading-none"
                  >
                    {f.sample}
                  </span>
                  <span className="text-[10px] font-medium leading-none opacity-80">
                    {f.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Font Size Slider + Quick S / M / L */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Text Size
            </span>
            <div className="flex items-center gap-1">
              {[
                { label: "S", val: 86 },
                { label: "M", val: 100 },
                { label: "L", val: 118 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => updateSizePct(preset.val)}
                  className={`h-6 px-2 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                    Math.abs(sizePct - preset.val) <= 2
                      ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                      : "bg-[#edf1fb] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <span className="ml-1 text-[11px] font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc] min-w-[36px] text-right">
                {sizePct}%
              </span>
            </div>
          </div>
          <input
            type="range"
            min={75}
            max={140}
            step={1}
            value={sizePct}
            aria-label="Subtitle text size percentage"
            onChange={(e) => updateSizePct(Number(e.target.value))}
            className="w-full h-1.5 cursor-pointer"
          />
        </div>

        {/* Weight & Alignment Row */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Weight
            </p>
            <div className="grid grid-cols-3 gap-0.5 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
              {WEIGHT_OPTIONS.map((w) => {
                const active = textWeight === w.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => update({ subtitleTextWeight: w.id })}
                    className={`h-8 rounded-md text-[10.5px] whitespace-nowrap cursor-pointer transition-colors ${
                      active
                        ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                        : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                    }`}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Alignment
            </p>
            <div className="grid grid-cols-2 gap-0.5 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
              <button
                type="button"
                onClick={() => update({ subtitleAlign: "left" })}
                className={`h-8 rounded-md flex items-center justify-center gap-1 text-[11px] whitespace-nowrap cursor-pointer transition-colors ${
                  align === "left"
                    ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                }`}
              >
                <AlignLeft className="w-3.5 h-3.5" />
                <span>Left</span>
              </button>
              <button
                type="button"
                onClick={() => update({ subtitleAlign: "center" })}
                className={`h-8 rounded-md flex items-center justify-center gap-1 text-[11px] whitespace-nowrap cursor-pointer transition-colors ${
                  align === "center"
                    ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                }`}
              >
                <AlignCenter className="w-3.5 h-3.5" />
                <span>Center</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Card Box & Layout */}
      <section className="space-y-3 pt-3 border-t border-[#d2dcf0]/80 dark:border-[#21284c]">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Box Style
          </p>
          <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
            {CARD_STYLE_OPTIONS.map((opt) => {
              const active = cardStyle === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update({ subtitleCardStyle: opt.id })}
                  className={`h-9 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
          {/* Corner Radius */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                Corner Radius
              </span>
              <span className="text-[11px] font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                {cardRadius}px
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={28}
              step={2}
              value={cardRadius}
              disabled={cardStyle === "minimal"}
              aria-label="Subtitle box corner radius"
              onChange={(e) => update({ subtitleCardRadius: Number(e.target.value) })}
              className="w-full h-1.5 cursor-pointer disabled:opacity-40"
            />
          </div>

          {/* Portrait Video/Subtitle Split Height */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                Video / Subtitle Split
              </span>
              <button
                type="button"
                onClick={() => update({ videoHeightPct: 35 })}
                title="Reset to 35%"
                className="text-[11px] font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc] hover:text-teal-700 dark:hover:text-teal-300 cursor-pointer"
              >
                {videoHeightPct}%
              </button>
            </div>
            <input
              type="range"
              min={26}
              max={52}
              step={1}
              value={videoHeightPct}
              aria-label="Top video split percentage"
              onChange={(e) => update({ videoHeightPct: Number(e.target.value) })}
              className="w-full h-1.5 cursor-pointer"
            />
          </div>
        </div>

        {/* Overlay Subtitle X / Y Position */}
        <div className="p-2.5 rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0d1022]/80 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                Overlay Subtitle Position (X / Y)
              </p>
              <p className="text-[10px] text-[#4d597d] dark:text-[#919ec4]">
                {isOverlayLayout
                  ? "Drag subtitle on preview or fine-tune X/Y"
                  : "Used in Overlay aspect ratios (e.g. 9:16 Overlay)"}
              </p>
            </div>
            {overlayModified && (
              <button
                type="button"
                onClick={() =>
                  update({
                    subtitleOverlayX: DEFAULT_SUBTITLE_OVERLAY_X,
                    subtitleOverlayY: DEFAULT_SUBTITLE_OVERLAY_Y,
                  })
                }
                className="h-6 px-2 rounded border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-teal-700 dark:hover:text-teal-300 inline-flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                <span>Reset</span>
              </button>
            )}
          </div>

          {!isOverlayLayout && (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-[#edf1fb] dark:bg-[#141933] border border-[#d2dcf0]/80 dark:border-[#21284c]">
              <span className="text-[10.5px] text-[#4d597d] dark:text-[#919ec4]">
                Currently using Scroll layout
              </span>
              <button
                type="button"
                onClick={() => update({ aspectRatio: "9:16-overlay" })}
                className="h-6 px-2 rounded bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-[10.5px] font-semibold whitespace-nowrap cursor-pointer transition-colors"
              >
                Use 9:16 Overlay
              </button>
            </div>
          )}

          {/* Quick Position Presets */}
          <div className="grid grid-cols-4 gap-1">
            {[
              {
                label: "Top",
                active: overlayX === 0 && overlayY <= 12,
                onClick: () => update({ subtitleOverlayX: 0, subtitleOverlayY: 8 }),
              },
              {
                label: "Middle",
                active: overlayX === 0 && Math.abs(overlayY - 50) <= 2,
                onClick: () => update({ subtitleOverlayX: 0, subtitleOverlayY: 50 }),
              },
              {
                label: "Bottom",
                active: overlayX === 0 && overlayY >= 92,
                onClick: () =>
                  update({
                    subtitleOverlayX: 0,
                    subtitleOverlayY: DEFAULT_SUBTITLE_OVERLAY_Y,
                  }),
              },
              {
                label: "Center X",
                active: overlayX === 0,
                onClick: () => update({ subtitleOverlayX: 0 }),
              },
            ].map((btn) => (
              <button
                key={btn.label}
                type="button"
                onClick={btn.onClick}
                className={`h-7 px-1.5 rounded-md border text-[10.5px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  btn.active
                    ? "border-teal-600 dark:border-teal-400 bg-teal-50/80 dark:bg-teal-950/45 text-teal-800 dark:text-teal-200 font-semibold"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                  Horizontal (X)
                </span>
                <button
                  type="button"
                  onClick={() => update({ subtitleOverlayX: DEFAULT_SUBTITLE_OVERLAY_X })}
                  title="Center X (0%)"
                  className="text-[11px] font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc] hover:text-teal-700 dark:hover:text-teal-300 cursor-pointer"
                >
                  {overlayX > 0 ? `+${overlayX}%` : overlayX === 0 ? "0% (Center)" : `${overlayX}%`}
                </button>
              </div>
              <input
                type="range"
                min={-50}
                max={50}
                step={1}
                value={overlayX}
                aria-label="Overlay subtitle horizontal X position"
                onChange={(e) => update({ subtitleOverlayX: Number(e.target.value) })}
                className="w-full h-1.5 cursor-pointer"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                  Vertical (Y)
                </span>
                <button
                  type="button"
                  onClick={() => update({ subtitleOverlayY: DEFAULT_SUBTITLE_OVERLAY_Y })}
                  title="Reset Y to 96%"
                  className="text-[11px] font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc] hover:text-teal-700 dark:hover:text-teal-300 cursor-pointer"
                >
                  {overlayY}%
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={overlayY}
                aria-label="Overlay subtitle vertical Y position"
                onChange={(e) => update({ subtitleOverlayY: Number(e.target.value) })}
                className="w-full h-1.5 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Spacing */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
            Line Spacing
          </p>
          <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
            {SPACING_OPTIONS.map((opt) => {
              const active = lineSpacing === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update({ subtitleLineSpacing: opt.id })}
                  className={`h-9 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    active
                      ? "bg-white dark:bg-[#1c2550] text-[#0c1026] dark:text-white shadow-xs font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* 5. Visible Subtitle Lines */}
      <section className="space-y-2 pt-3 border-t border-[#d2dcf0]/80 dark:border-[#21284c]">
        <p className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
          Visible Lines
        </p>
        <div className="divide-y divide-[#d2dcf0]/70 dark:divide-[#21284c] rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden">
          {[
            {
              key: "gloss",
              label: "Word-by-Word Burmese Gloss",
              checked: showWordGloss,
              toggle: () => update({ showWordGloss: !showWordGloss }),
            },
            {
              key: "burmese",
              label: "Burmese Sentence Line",
              checked: showBurmeseLine,
              toggle: () => update({ showBurmeseLine: !showBurmeseLine }),
            },
            {
              key: "thai",
              label: "Original Thai Script",
              checked: showThaiScript,
              toggle: () => update({ showThaiScript: !showThaiScript }),
            },
          ].map((row) => (
            <button
              key={row.key}
              type="button"
              role="switch"
              aria-checked={row.checked}
              onClick={row.toggle}
              className="w-full min-h-[44px] px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-[#f3f5fc] dark:hover:bg-[#141933] cursor-pointer transition-colors"
            >
              <span className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                {row.label}
              </span>
              <span
                aria-hidden="true"
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                  row.checked
                    ? "bg-teal-700 dark:bg-teal-400"
                    : "bg-[#cbd5e1] dark:bg-[#2a3461]"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-[#080b1a] shadow-xs transform transition-transform mt-0.5 ${
                    row.checked ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 6. Manual Saved Subtitle Presets (Bottom) */}
      <section className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c]">
        <CustomPresetsBar
          category="subtitle"
          currentValues={extractSubtitlePresetValues(settings)}
          isMatch={(vals) => isSubtitlePresetMatch(settings, vals)}
          onApply={(vals) => onChange(applySubtitlePresetValues(settings, vals))}
          getSummary={(vals) =>
            `${vals.subtitleTheme} · ${vals.subtitleCardStyle} · ${vals.subtitleSizePct}%`
          }
          getAccentDotClass={(vals) => {
            if (vals.subtitleHighlightColor === "amber") return "bg-[#d97706]";
            if (vals.subtitleHighlightColor === "emerald") return "bg-[#0d9468]";
            if (vals.subtitleHighlightColor === "rose") return "bg-[#be185d]";
            return "bg-[#2952d6]";
          }}
          placeholder="e.g. My TikTok Dark, Warm Large..."
        />
      </section>
    </div>
  );
}
