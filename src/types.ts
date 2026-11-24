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
}

export interface SubtitleWord {
  phonetic: string;
  thai: string;
  burmeseGloss?: string;
  startOffsetSec: number;
  endOffsetSec: number;
}

export interface SubtitleItem {
  id: string;
  sceneIndex: number;
  startTime: number;
  endTime: number;
  sourceStartSec: number;
  sourceEndSec: number;
  originalSpokenText: string;
  thaiPhonetic: string;
  thaiScript: string;
  burmese: string;
  words: SubtitleWord[];
  isManuallyEdited?: boolean;
}

export interface ActiveMediaSource {
  sourceType: "youtube" | "local";
  videoId?: string;
  localUrl?: string;
  localFile?: File;
  uploadId?: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnail?: string;
}

export interface SpeechRegion {
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface VideoProject {
  sourceType: "youtube" | "local";
  videoId?: string;
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
export type SubtitleFontScale = "sm" | "md" | "lg";
export type SubtitleTheme = "auto" | "light" | "dark" | "warm";
export type SubtitleHighlightColor = "amber" | "emerald" | "indigo" | "rose";

export interface VideoEditSettings {
  filterPreset: VideoFilterPresetId | "custom";
  playbackSpeed: number;
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
  hasLocalVideoBlob: boolean;
  localFileName?: string;
  localFileType?: string;
  localFileSize?: number;
  createdAt: number;
  updatedAt: number;
}


