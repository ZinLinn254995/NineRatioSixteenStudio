import type {
  SubtitleContentGenre,
  SubtitleGenerationConfig,
  SubtitleGenTone,
  SubtitleOutputFormat,
  SubtitlePacingMode,
  SubtitlePhoneticStyle,
  SubtitleSourceLanguage,
  SubtitleTargetLanguage,
} from "../types";

const STORAGE_KEY = "nine_ratio_subtitle_gen_config_v1";

export const DEFAULT_SUBTITLE_GEN_CONFIG: SubtitleGenerationConfig = {
  sourceLanguage: "th",
  targetLanguage: "my",
  subtitleFormat: "bilingual_phonetic",
  phoneticStyle: "latin",
  translationTone: "casual",
  contentGenre: "general",
  pacingMode: "balanced",
  includeWordGloss: true,
  includeNativeScript: true,
  includeNonSpeech: false,
  customInstructions: "",
};

export interface LanguageOption<T extends string> {
  id: T;
  label: string;
  nativeLabel: string;
}

export const SOURCE_LANGUAGE_OPTIONS: LanguageOption<SubtitleSourceLanguage>[] = [
  { id: "auto", label: "Auto-Detect", nativeLabel: "Any Language" },
  { id: "th", label: "Thai", nativeLabel: "ไทย" },
  { id: "my", label: "Burmese", nativeLabel: "မြန်မာ" },
  { id: "en", label: "English", nativeLabel: "English" },
  { id: "zh", label: "Chinese", nativeLabel: "中文" },
  { id: "ja", label: "Japanese", nativeLabel: "日本語" },
  { id: "ko", label: "Korean", nativeLabel: "한국어" },
  { id: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { id: "lo", label: "Lao", nativeLabel: "ລາວ" },
  { id: "km", label: "Khmer", nativeLabel: "ខ្មែរ" },
  { id: "id", label: "Indonesian / Malay", nativeLabel: "Bahasa" },
  { id: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { id: "es", label: "Spanish", nativeLabel: "Español" },
  { id: "fr", label: "French", nativeLabel: "Français" },
];

export const TARGET_LANGUAGE_OPTIONS: LanguageOption<SubtitleTargetLanguage>[] = [
  { id: "my", label: "Burmese", nativeLabel: "မြန်မာ" },
  { id: "en", label: "English", nativeLabel: "English" },
  { id: "th", label: "Thai", nativeLabel: "ไทย" },
  { id: "zh", label: "Chinese", nativeLabel: "中文" },
  { id: "ja", label: "Japanese", nativeLabel: "日本語" },
  { id: "ko", label: "Korean", nativeLabel: "한국어" },
  { id: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { id: "id", label: "Indonesian / Malay", nativeLabel: "Bahasa" },
  { id: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { id: "es", label: "Spanish", nativeLabel: "Español" },
  { id: "fr", label: "French", nativeLabel: "Français" },
  { id: "none", label: "No Translation", nativeLabel: "Transcribe Only" },
];

export const SUBTITLE_FORMAT_OPTIONS: {
  id: SubtitleOutputFormat;
  label: string;
  desc: string;
}[] = [
  {
    id: "bilingual_phonetic",
    label: "Phonetic + Translation",
    desc: "Pronunciation guide + word gloss + translation",
  },
  {
    id: "bilingual_native",
    label: "Native + Translation",
    desc: "Original script synced on top + translation below",
  },
  {
    id: "translation_only",
    label: "Translation Only",
    desc: "Clean single-language translated subtitles",
  },
  {
    id: "original_only",
    label: "Original Only",
    desc: "Verbatim spoken transcription only",
  },
];

export const PHONETIC_STYLE_OPTIONS: {
  id: SubtitlePhoneticStyle;
  label: string;
  example: string;
}[] = [
  { id: "latin", label: "Romanized (EN)", example: "Sa-wat-dee khrap" },
  { id: "burmese_phonetic", label: "Burmese Reading", example: "ဆဝါဒီ ခပ်" },
  { id: "ipa_tones", label: "Tone Marks", example: "sà-wàt-dii khráp" },
  { id: "native_only", label: "Native Script", example: "สวัสดีครับ" },
];

export const SUBTITLE_GEN_TONE_OPTIONS: {
  id: SubtitleGenTone;
  label: string;
  desc: string;
}[] = [
  { id: "casual", label: "Natural Spoken", desc: "Everyday conversational tone" },
  { id: "formal", label: "Polite / Teaching", desc: "Clear, courteous phrasing" },
  { id: "dramatic", label: "Drama / Expressive", desc: "Vivid emotion & punch" },
  { id: "literal", label: "Literal Study", desc: "Close word-for-word accuracy" },
  { id: "concise", label: "Short / Reels", desc: "Fast, punchy short lines" },
  { id: "poetic", label: "Lyrics / Story", desc: "Warm, rhythmic storytelling" },
];

export const CONTENT_GENRE_OPTIONS: {
  id: SubtitleContentGenre;
  label: string;
}[] = [
  { id: "general", label: "General" },
  { id: "movie_drama", label: "Movie / Drama" },
  { id: "vlog_social", label: "Vlog / Reels" },
  { id: "education", label: "Lesson / Study" },
  { id: "news_doc", label: "News / Doc" },
  { id: "music_lyrics", label: "Song / Lyrics" },
];

export const PACING_MODE_OPTIONS: {
  id: SubtitlePacingMode;
  label: string;
  desc: string;
}[] = [
  { id: "balanced", label: "Balanced", desc: "Natural spoken phrases" },
  { id: "short_reels", label: "Short Clips", desc: "2–5 words per card" },
  { id: "full_sentence", label: "Full Sentences", desc: "Complete study lines" },
];

export interface SubtitleGenPreset {
  id: string;
  label: string;
  badge: string;
  patch: Partial<SubtitleGenerationConfig>;
}

export const SUBTITLE_GEN_PRESETS: SubtitleGenPreset[] = [
  {
    id: "thai-mm-study",
    label: "Thai → Burmese Study",
    badge: "TH · MM",
    patch: {
      sourceLanguage: "th",
      targetLanguage: "my",
      subtitleFormat: "bilingual_phonetic",
      phoneticStyle: "latin",
      translationTone: "casual",
      contentGenre: "education",
      pacingMode: "balanced",
      includeWordGloss: true,
      includeNativeScript: true,
      includeNonSpeech: false,
    },
  },
  {
    id: "thai-mm-phonetic",
    label: "Thai (မြန်မာအသံထွက်)",
    badge: "အသံထွက်",
    patch: {
      sourceLanguage: "th",
      targetLanguage: "my",
      subtitleFormat: "bilingual_phonetic",
      phoneticStyle: "burmese_phonetic",
      translationTone: "casual",
      contentGenre: "education",
      pacingMode: "balanced",
      includeWordGloss: true,
      includeNativeScript: true,
      includeNonSpeech: false,
    },
  },
  {
    id: "auto-mm-drama",
    label: "Movie / Drama → MM",
    badge: "Drama",
    patch: {
      sourceLanguage: "auto",
      targetLanguage: "my",
      subtitleFormat: "translation_only",
      phoneticStyle: "native_only",
      translationTone: "dramatic",
      contentGenre: "movie_drama",
      pacingMode: "short_reels",
      includeWordGloss: false,
      includeNativeScript: false,
      includeNonSpeech: false,
    },
  },
  {
    id: "en-mm-bilingual",
    label: "English → Burmese",
    badge: "EN · MM",
    patch: {
      sourceLanguage: "en",
      targetLanguage: "my",
      subtitleFormat: "bilingual_native",
      phoneticStyle: "native_only",
      translationTone: "casual",
      contentGenre: "general",
      pacingMode: "balanced",
      includeWordGloss: true,
      includeNativeScript: false,
      includeNonSpeech: false,
    },
  },
  {
    id: "kr-jp-mm",
    label: "Korean / JP → MM",
    badge: "KR/JP",
    patch: {
      sourceLanguage: "ko",
      targetLanguage: "my",
      subtitleFormat: "bilingual_phonetic",
      phoneticStyle: "latin",
      translationTone: "dramatic",
      contentGenre: "movie_drama",
      pacingMode: "balanced",
      includeWordGloss: true,
      includeNativeScript: true,
      includeNonSpeech: false,
    },
  },
  {
    id: "th-en-study",
    label: "Thai → English",
    badge: "TH · EN",
    patch: {
      sourceLanguage: "th",
      targetLanguage: "en",
      subtitleFormat: "bilingual_phonetic",
      phoneticStyle: "latin",
      translationTone: "casual",
      contentGenre: "general",
      pacingMode: "balanced",
      includeWordGloss: true,
      includeNativeScript: true,
      includeNonSpeech: false,
    },
  },
];

export const QUICK_GEN_INSTRUCTIONS: { label: string; text: string }[] = [
  {
    label: "Natural Burmese slang",
    text: "Use natural everyday Yangon spoken Burmese phrasing rather than stiff literary words.",
  },
  {
    label: "Keep names untranslated",
    text: "Keep speaker names and brand names accurately transliterated without altering them.",
  },
  {
    label: "Short mobile lines",
    text: "Split long utterances into concise, easy-to-read phrases for mobile portrait viewing.",
  },
  {
    label: "Extra clear phonetics",
    text: "Separate syllables clearly with hyphens in phonetic spelling for beginner learners.",
  },
];

export function sanitizeSubtitleGenConfig(
  raw?: Partial<SubtitleGenerationConfig> | null
): SubtitleGenerationConfig {
  const base = DEFAULT_SUBTITLE_GEN_CONFIG;
  if (!raw || typeof raw !== "object") return { ...base };

  const validSource = SOURCE_LANGUAGE_OPTIONS.some((o) => o.id === raw.sourceLanguage)
    ? (raw.sourceLanguage as SubtitleSourceLanguage)
    : base.sourceLanguage;
  const validTarget = TARGET_LANGUAGE_OPTIONS.some((o) => o.id === raw.targetLanguage)
    ? (raw.targetLanguage as SubtitleTargetLanguage)
    : base.targetLanguage;
  const validFormat = SUBTITLE_FORMAT_OPTIONS.some((o) => o.id === raw.subtitleFormat)
    ? (raw.subtitleFormat as SubtitleOutputFormat)
    : base.subtitleFormat;
  const validPhonetic = PHONETIC_STYLE_OPTIONS.some((o) => o.id === raw.phoneticStyle)
    ? (raw.phoneticStyle as SubtitlePhoneticStyle)
    : base.phoneticStyle;
  const validTone = SUBTITLE_GEN_TONE_OPTIONS.some((o) => o.id === raw.translationTone)
    ? (raw.translationTone as SubtitleGenTone)
    : base.translationTone;
  const validGenre = CONTENT_GENRE_OPTIONS.some((o) => o.id === raw.contentGenre)
    ? (raw.contentGenre as SubtitleContentGenre)
    : base.contentGenre;
  const validPacing = PACING_MODE_OPTIONS.some((o) => o.id === raw.pacingMode)
    ? (raw.pacingMode as SubtitlePacingMode)
    : base.pacingMode;

  return {
    sourceLanguage: validSource,
    targetLanguage: validTarget,
    subtitleFormat: validFormat,
    phoneticStyle: validPhonetic,
    translationTone: validTone,
    contentGenre: validGenre,
    pacingMode: validPacing,
    includeWordGloss:
      typeof raw.includeWordGloss === "boolean"
        ? raw.includeWordGloss
        : base.includeWordGloss,
    includeNativeScript:
      typeof raw.includeNativeScript === "boolean"
        ? raw.includeNativeScript
        : base.includeNativeScript,
    includeNonSpeech:
      typeof raw.includeNonSpeech === "boolean"
        ? raw.includeNonSpeech
        : base.includeNonSpeech,
    customInstructions:
      typeof raw.customInstructions === "string"
        ? raw.customInstructions.slice(0, 600)
        : "",
  };
}

export function loadSavedSubtitleGenConfig(): SubtitleGenerationConfig {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...DEFAULT_SUBTITLE_GEN_CONFIG };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUBTITLE_GEN_CONFIG };
    return sanitizeSubtitleGenConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SUBTITLE_GEN_CONFIG };
  }
}

export function saveSubtitleGenConfig(config: SubtitleGenerationConfig): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

export function isPresetMatchingConfig(
  config: SubtitleGenerationConfig,
  preset: SubtitleGenPreset
): boolean {
  for (const [k, v] of Object.entries(preset.patch)) {
    if (config[k as keyof SubtitleGenerationConfig] !== v) {
      return false;
    }
  }
  return true;
}

export function getLanguageDisplayLabel(code: string): string {
  const fromSource = SOURCE_LANGUAGE_OPTIONS.find((o) => o.id === code);
  if (fromSource) return fromSource.label;
  const fromTarget = TARGET_LANGUAGE_OPTIONS.find((o) => o.id === code);
  if (fromTarget) return fromTarget.label;
  return code;
}
