import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { SubtitleItem, TranslationTone } from "../types";

interface SubtitleClipEditorProps {
  subtitle: SubtitleItem;
  subtitleIndex: number;
  totalSubtitles: number;
  isPlaying: boolean;
  defaultTone: TranslationTone;
  isRegenerating: boolean;
  regenError?: string | null;
  onClearRegenError?: () => void;
  onPlayClip: () => void;
  onPause: () => void;
  onUpdateField: (
    id: string,
    field: "thaiPhonetic" | "burmese" | "thaiScript",
    value: string
  ) => void;
  onUpdateWordGloss: (subId: string, wordIndex: number, burmeseGloss: string) => void;
  onRegenerate: (
    id: string,
    customHint?: string,
    toneOverride?: TranslationTone
  ) => void;
  onCancelRegenerate?: (id: string) => void;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  onClose: () => void;
}

const TONE_OPTIONS: { id: TranslationTone; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "formal", label: "Formal" },
  { id: "dramatic", label: "Dramatic" },
  { id: "literal", label: "Literal" },
];

const QUICK_AI_SUGGESTIONS: { label: string; prompt: string }[] = [
  {
    label: "More natural",
    prompt: "Make the Burmese translation sound more natural and conversational.",
  },
  {
    label: "Shorter",
    prompt: "Keep the Burmese translation concise and punchy for fast reading.",
  },
  {
    label: "Fix pronunciation",
    prompt: "Re-check the spoken Thai syllables and fix the phonetic reading accurately.",
  },
  {
    label: "Re-listen audio",
    prompt: "Listen closely to the spoken audio again and re-transcribe from scratch.",
  },
];

function formatClipTime(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${mins}:${whole.toString().padStart(2, "0")}.${tenths}`;
}

export function SubtitleClipEditor({
  subtitle,
  subtitleIndex,
  totalSubtitles,
  isPlaying,
  defaultTone,
  isRegenerating,
  regenError = null,
  onClearRegenError,
  onPlayClip,
  onPause,
  onUpdateField,
  onUpdateWordGloss,
  onRegenerate,
  onCancelRegenerate,
  onNavigatePrev,
  onNavigateNext,
  onClose,
}: SubtitleClipEditorProps) {
  const [aiSuggestion, setAiSuggestion] = useState("");
  const [tone, setTone] = useState<TranslationTone>(defaultTone);
  const [showWordGlosses, setShowWordGlosses] = useState(false);

  useEffect(() => {
    setAiSuggestion("");
  }, [subtitle.id]);

  useEffect(() => {
    setTone(defaultTone);
  }, [defaultTone]);

  const handleApplyQuickSuggestion = (prompt: string) => {
    setAiSuggestion((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return prompt;
      if (trimmed.toLowerCase().includes(prompt.toLowerCase())) return trimmed;
      return `${trimmed} ${prompt}`;
    });
  };

  const handleRunRegenerate = () => {
    if (isRegenerating) return;
    onClearRegenError?.();
    onRegenerate(subtitle.id, aiSuggestion.trim() || undefined, tone);
  };

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
            <div className="flex items-center gap-1 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
              <span className="font-mono-tabular text-[#1c3db8] dark:text-[#7ca3fb]">
                S{subtitleIndex + 1}
              </span>
              <span className="text-[#6d7a9e] dark:text-[#7c89b2] font-normal">
                / {totalSubtitles}
              </span>
              {totalSubtitles > 1 && (
                <div className="inline-flex items-center ml-0.5">
                  <button
                    type="button"
                    disabled={!onNavigatePrev}
                    onClick={onNavigatePrev}
                    aria-label="Previous subtitle clip"
                    className="h-6 w-6 rounded flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:bg-[#edf1fb] dark:hover:bg-[#1a2142] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={!onNavigateNext}
                    onClick={onNavigateNext}
                    aria-label="Next subtitle clip"
                    className="h-6 w-6 rounded flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:bg-[#edf1fb] dark:hover:bg-[#1a2142] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
            <span className="text-[10.5px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] leading-tight">
              {formatClipTime(subtitle.startTime)} – {formatClipTime(subtitle.endTime)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (isPlaying) {
                onPause();
              } else {
                onPlayClip();
              }
            }}
            aria-label={isPlaying ? "Pause clip preview" : "Play clip preview"}
            className="h-9 px-2.5 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-teal-600/50 dark:hover:border-teal-400/50 text-[#0c1026] dark:text-[#f3f5fc] text-xs font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <Check className="w-3.5 h-3.5 shrink-0" />
            <span>Done</span>
          </button>
        </div>
      </div>

      {/* Scrollable Editor Body */}
      <div className="px-3.5 py-3.5 flex flex-col gap-4 pb-8">
        {/* 1. Manual Text Editing */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
            Manual Text Edit
          </p>

          <div className="space-y-1.5">
            <label
              htmlFor={`sub-edit-burmese-${subtitle.id}`}
              className="block text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]"
            >
              Burmese Translation
            </label>
            <textarea
              id={`sub-edit-burmese-${subtitle.id}`}
              rows={2}
              value={subtitle.burmese}
              onChange={(e) => onUpdateField(subtitle.id, "burmese", e.target.value)}
              placeholder="မြန်မာဘာသာပြန် ရိုက်ထည့်ပါ..."
              className="w-full rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0a0d1d] px-3 py-2 text-sm font-myanmar leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#5b678f] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 focus:ring-2 focus:ring-teal-500/20 resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`sub-edit-phonetic-${subtitle.id}`}
              className="block text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]"
            >
              Thai Phonetic (Pronunciation)
            </label>
            <textarea
              id={`sub-edit-phonetic-${subtitle.id}`}
              rows={2}
              value={subtitle.thaiPhonetic}
              onChange={(e) => onUpdateField(subtitle.id, "thaiPhonetic", e.target.value)}
              placeholder="e.g. sà-wàt-dii khráp"
              className="w-full rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0a0d1d] px-3 py-2 text-xs leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#5b678f] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 focus:ring-2 focus:ring-teal-500/20 resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`sub-edit-thai-${subtitle.id}`}
              className="block text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]"
            >
              Original Thai Script
            </label>
            <input
              id={`sub-edit-thai-${subtitle.id}`}
              type="text"
              value={subtitle.thaiScript}
              onChange={(e) => onUpdateField(subtitle.id, "thaiScript", e.target.value)}
              placeholder="สวัสดีครับ"
              style={{ fontFamily: "'Noto Sans Thai', 'DM Sans', sans-serif" }}
              className="w-full h-10 rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0a0d1d] px-3 text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#5b678f] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 focus:ring-2 focus:ring-teal-500/20"
            />
          </div>

          {/* Word-by-Word Burmese Glosses (Expandable) */}
          {subtitle.words.length > 0 && (
            <div className="rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff]/70 dark:bg-[#0a0d1d]/70 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowWordGlosses((v) => !v)}
                className="w-full min-h-[42px] px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-[#edf1fb]/80 dark:hover:bg-[#141933] cursor-pointer transition-colors"
              >
                <span className="text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                  Word-by-Word Burmese Glosses
                  <span className="ml-1.5 text-[11px] font-mono-tabular text-[#6d7a9e] dark:text-[#7c89b2]">
                    · {subtitle.words.length}
                  </span>
                </span>
                {showWordGlosses ? (
                  <ChevronUp className="w-4 h-4 text-[#4d597d] dark:text-[#919ec4] shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-[#4d597d] dark:text-[#919ec4] shrink-0" />
                )}
              </button>

              {showWordGlosses && (
                <div className="p-2.5 pt-1 grid grid-cols-2 gap-2 border-t border-[#d2dcf0]/70 dark:border-[#21284c]">
                  {subtitle.words.map((word, wIdx) => (
                    <div
                      key={`${subtitle.id}-w-${wIdx}`}
                      className="space-y-1 rounded-lg border border-[#d2dcf0]/80 dark:border-[#21284c] bg-white dark:bg-[#0d1022] p-2"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-semibold text-[#1c3db8] dark:text-[#7ca3fb] truncate">
                          {word.phonetic}
                        </span>
                        {word.thai && word.thai !== word.phonetic && (
                          <span className="text-[10px] text-[#6d7a9e] dark:text-[#7c89b2] truncate">
                            {word.thai}
                          </span>
                        )}
                      </div>
                      <input
                        type="text"
                        value={word.burmeseGloss || ""}
                        onChange={(e) =>
                          onUpdateWordGloss(subtitle.id, wIdx, e.target.value)
                        }
                        placeholder="အဓိပ္ပာယ်..."
                        aria-label={`Burmese gloss for ${word.phonetic}`}
                        className="w-full h-8 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0a0d1d] text-[11px] font-myanmar text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#5b678f] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2. AI Suggest & Single-Clip Regenerate */}
        <section className="space-y-3 pt-3.5 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#1c3db8] dark:text-[#7ca3fb] shrink-0" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
                AI Regenerate This Clip
              </span>
            </div>
            {aiSuggestion.trim().length > 0 && !isRegenerating && (
              <button
                type="button"
                onClick={() => setAiSuggestion("")}
                className="text-[11px] font-medium text-[#6d7a9e] dark:text-[#7c89b2] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={`sub-ai-hint-${subtitle.id}`}
              className="block text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]"
            >
              Suggestion for AI (Optional)
            </label>
            <textarea
              id={`sub-ai-hint-${subtitle.id}`}
              rows={2}
              value={aiSuggestion}
              disabled={isRegenerating}
              onChange={(e) => setAiSuggestion(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleRunRegenerate();
                }
              }}
              placeholder="AI ကို ညွှန်ကြားချက်ပေးပါ (ဥပမာ - ပိုပြီး သဘာဝကျအောင် ပြန်ပေးပါ / ကျွန်တော် လို့သုံးပါ)..."
              className="w-full rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8faff] dark:bg-[#0a0d1d] px-3 py-2 text-xs font-myanmar leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#5b678f] focus:outline-none focus:border-[#2952d6] dark:focus:border-[#5b85f7] focus:ring-2 focus:ring-[#2952d6]/20 disabled:opacity-55 resize-y"
            />
          </div>

          {/* Quick Suggestion Buttons */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_AI_SUGGESTIONS.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={isRegenerating}
                onClick={() => handleApplyQuickSuggestion(item.prompt)}
                className="h-8 px-2.5 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:border-[#5d82f0] dark:hover:border-[#5b85f7] hover:text-[#1c3db8] dark:hover:text-[#93b5fa] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] whitespace-nowrap cursor-pointer disabled:opacity-45 transition-colors"
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Translation Tone Selector */}
          <div className="space-y-1.5">
            <span className="block text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Translation Tone
            </span>
            <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[#edf1fb] dark:bg-[#11162e]">
              {TONE_OPTIONS.map((opt) => {
                const active = tone === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isRegenerating}
                    onClick={() => setTone(opt.id)}
                    className={`h-9 rounded-md text-[11px] font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors ${
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

          {/* Error Feedback */}
          {regenError && (
            <div className="rounded-xl border border-red-300 dark:border-red-800/80 bg-red-50/90 dark:bg-red-950/40 px-3 py-2 flex items-start justify-between gap-2 text-xs text-red-700 dark:text-red-300">
              <div className="flex items-start gap-2 min-w-0">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="min-w-0 break-words leading-snug">{regenError}</span>
              </div>
              {onClearRegenError && (
                <button
                  type="button"
                  onClick={onClearRegenError}
                  aria-label="Dismiss error"
                  className="h-6 w-6 rounded flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900/50 shrink-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Primary AI Regenerate Action */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isRegenerating}
              onClick={handleRunRegenerate}
              className="flex-1 h-11 px-4 rounded-xl bg-[#1c3db8] hover:bg-[#16329a] dark:bg-[#2952d6] dark:hover:bg-[#3560e8] text-white text-xs font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-65 disabled:cursor-not-allowed transition-colors shadow-xs"
            >
              {isRegenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>Regenerating Clip…</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 shrink-0" />
                  <span>Regenerate Clip with AI</span>
                </>
              )}
            </button>

            {isRegenerating && onCancelRegenerate && (
              <button
                type="button"
                onClick={() => onCancelRegenerate(subtitle.id)}
                className="h-11 px-3.5 rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/50 hover:bg-red-100 dark:hover:bg-red-900/60 text-red-700 dark:text-red-300 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                <Square className="w-3 h-3 fill-current shrink-0" />
                <span>Stop</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
