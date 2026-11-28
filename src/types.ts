export type YouTubeLicenseFilter = "all" | "creative_commons" | "standard";

export interface YouTubeVideo {
  videoId: string;
  title: string;
  channel: string;
  durationText: string;
  durationSec: number;
  thumbnail: string;
  viewCountText: string;
  publishedTimeText: string;
  license?: "creative_commons" | "standard";
}

export interface SceneSelection {
  id: string;
  startSec: number;
  endSec: number;
}

export type SubtitleProgressStage =
  | "uploading"
  | "extracting"
  | "detecting"
  | "generating"
  | "compiling";

export interface SubtitleGenerationProgress {
  stage: SubtitleProgressStage;
  label: string;
  percent: number;
  clipIndex?: number;
  totalClips?: number;
}

export interface SpeakingScene {
  id?: string;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  summary: string;
  mediaType?: "video" | "image";
  mediaUrl?: string;
  mediaFile?: File;
  uploadId?: string;
  sourceDurationSec?: number;
}

export interface SubtitleWord {
  phonetic: string;
  thai: string;
  burmeseGloss?: string;
  startOffsetSec: number;
  endOffsetSec: number;
}

export interface SubtitleSourceSegment {
  sceneId?: string;
  mediaUrl?: string;
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface SubtitleItem {
  id: string;
  sceneIndex: number;
  sceneId?: string;
  mediaUrl?: string;
  startTime: number;
  endTime: number;
  sourceStartSec: number;
  sourceEndSec: number;
  sourceSegments?: SubtitleSourceSegment[];
  aiSourceStartSec?: number;
  aiSourceEndSec?: number;
  aiSourceSegments?: SubtitleSourceSegment[];
  originalSpokenText: string;
  thaiPhonetic: string;
  thaiScript: string;
  burmese: string;
  words: SubtitleWord[];
  isManuallyEdited?: boolean;
}

export interface LocalStudioMedia {
  sourceType: "local";
  localUrl?: string;
  localFile?: File;
  uploadId?: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnail?: string;
}

export interface YouTubeSourcePreview {
  sourceType: "youtube";
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnail?: string;
}

export interface SpeechRegion {
  sourceStartSec: number;
  sourceEndSec: number;
  mediaUrl?: string;
  sceneId?: string;
}

export interface VideoProject {
  isDraft?: boolean;
  localUrl?: string;
  localFile?: File;
  uploadId?: string;
  title: string;
  channel: string;
  sourceDurationSec: number;
  targetDurationSec: number;
  scenes: SpeakingScene[];
  subtitles: SubtitleItem[];
  speechRegions?: SpeechRegion[];
  keyframeUrls: string[];
}

export type VoicePresetId =
  | "original"
  | "deep"
  | "cute"
  | "cartoon"
  | "robot"
  | "echo"
  | "radio"
  | "calm";

export interface VoiceSettings {
  presetId: VoicePresetId | "custom";
  pitchSemitones: number;
  speed: number;
  tone: number;
  echo: number;
  robot: number;
  adversarialNoise: boolean;
  adversarialStrength: number;
  spectralPhaseShift: boolean;
  spectralPhaseStrength: number;
  vocalIsolation: boolean;
  vocalIsolationStrength: number;
}

export type VideoFilterPresetId =
  | "normal"
  | "vivid"
  | "bw"
  | "warm"
  | "cool"
  | "vintage"
  | "dramatic"
  | "soft";

export type TranslationTone = "casual" | "formal" | "dramatic" | "literal";
export type SubtitleGenTone = TranslationTone | "concise" | "poetic";
export type SubtitleSourceLanguage =
  | "auto"
  | "th"
  | "my"
  | "en"
  | "zh"
  | "ja"
  | "ko"
  | "vi"
  | "lo"
  | "km"
  | "id"
  | "hi"
  | "es"
  | "fr";
export type SubtitleTargetLanguage =
  | "my"
  | "en"
  | "th"
  | "zh"
  | "ja"
  | "ko"
  | "vi"
  | "id"
  | "hi"
  | "es"
  | "fr"
  | "none";
export type SubtitleOutputFormat =
  | "bilingual_phonetic"
  | "bilingual_native"
  | "translation_only"
  | "original_only";
export type SubtitlePhoneticStyle =
  | "latin"
  | "burmese_phonetic"
  | "ipa_tones"
  | "native_only";
export type SubtitleContentGenre =
  | "general"
  | "movie_drama"
  | "vlog_social"
  | "education"
  | "news_doc"
  | "music_lyrics";
export type SubtitlePacingMode = "balanced" | "short_reels" | "full_sentence";

export interface SubtitleGenerationConfig {
  sourceLanguage: SubtitleSourceLanguage;
  targetLanguage: SubtitleTargetLanguage;
  subtitleFormat: SubtitleOutputFormat;
  phoneticStyle: SubtitlePhoneticStyle;
  translationTone: SubtitleGenTone;
  contentGenre: SubtitleContentGenre;
  pacingMode: SubtitlePacingMode;
  includeWordGloss: boolean;
  includeNativeScript: boolean;
  includeNonSpeech: boolean;
  customInstructions: string;
}

export type SubtitleFontScale = "sm" | "md" | "lg";
export type SubtitleTheme = "auto" | "light" | "dark" | "warm";
export type SubtitleHighlightColor = "amber" | "emerald" | "indigo" | "rose";
export type SubtitleCardStyle = "card" | "minimal" | "outline" | "glass";
export type SubtitleWordStyle = "fill" | "underline" | "glow" | "text";
export type SubtitleFontFamily = "sans" | "display" | "serif" | "mono";
export type SubtitleAlign = "left" | "center";
export type SubtitleTextWeight = "normal" | "semibold" | "bold";
export type SubtitleLineSpacing = "compact" | "normal" | "relaxed";
export type VideoAspectRatio =
  | "original"
  | "9:16"
  | "9:16-overlay"
  | "4:5"
  | "4:5-overlay"
  | "1:1"
  | "16:9";

export interface VideoEditSettings {
  filterPreset: VideoFilterPresetId | "custom";
  playbackSpeed: number;
  aspectRatio: VideoAspectRatio;
  zoom: number;
  panX: number;
  panY: number;
  rotateDeg: number;
  flipH: boolean;
  flipV: boolean;
  fitMode: "cover" | "contain";
  videoHeightPct: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hueDeg: number;
  sepia: number;
  grayscale: number;
  blurPx: number;
  vignette: number;
  adversarialNoise: boolean;
  adversarialStrength: number;
  showThaiScript: boolean;
  translationTone: TranslationTone;
  subtitleFontScale: SubtitleFontScale;
  subtitleTheme: SubtitleTheme;
  subtitleHighlightColor: SubtitleHighlightColor;
  showWordGloss: boolean;
  showBurmeseLine: boolean;
  subtitleCardStyle?: SubtitleCardStyle;
  subtitleWordStyle?: SubtitleWordStyle;
  subtitleFontFamily?: SubtitleFontFamily;
  subtitleAlign?: SubtitleAlign;
  subtitleSizePct?: number;
  subtitleCardRadius?: number;
  subtitleTextWeight?: SubtitleTextWeight;
  subtitleLineSpacing?: SubtitleLineSpacing;
  subtitleOverlayX?: number;
  subtitleOverlayY?: number;
}

export interface SavedProjectRecord {
  id: string;
  title: string;
  sourceType: "youtube" | "local";
  videoId?: string;
  channel: string;
  thumbnail?: string;
  sourceDurationSec: number;
  targetDurationSec: number;
  selectedScenes: SceneSelection[];
  scenes: SpeakingScene[];
  subtitles: SubtitleItem[];
  speechRegions?: SpeechRegion[];
  keyframeUrls: string[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  transcriptResult?: TranscriptResult;
  hasLocalVideoBlob: boolean;
  localFileName?: string;
  localFileType?: string;
  localFileSize?: number;
  createdAt: number;
  updatedAt: number;
}

export type TranscriptModelId =
  | "whisper-tiny"
  | "whisper-base"
  | "whisper-small"
  | "whisper-medium"
  | "whisper-large-v3-turbo"
  | "whisper-tiny-en"
  | "gemini-cloud";

export type TranscriptExportFormat =
  | "txt_plain"
  | "txt_timed"
  | "srt"
  | "vtt"
  | "csv"
  | "json"
  | "md"
  | "lrc";

export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface TranscriptSegment {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptResult {
  id: string;
  title: string;
  modelId: TranscriptModelId;
  modelLabel: string;
  language: SubtitleSourceLanguage;
  detectedLanguage?: string;
  durationSec: number;
  text: string;
  segments: TranscriptSegment[];
  audioScenes?: Array<{
    id?: string;
    startSec: number;
    endSec: number;
  }>;
  createdAt: number;
}

export interface TranscriptProgress {
  phase: "extracting" | "downloading" | "loading" | "transcribing" | "translating";
  label: string;
  percent: number;
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
  chunkIndex?: number;
  totalChunks?: number;
  partialText?: string;
  detectedLanguage?: string;
}



