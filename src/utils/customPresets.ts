import type {
  SubtitleAlign,
  SubtitleCardStyle,
  SubtitleFontFamily,
  SubtitleFontScale,
  SubtitleHighlightColor,
  SubtitleLineSpacing,
  SubtitleTextWeight,
  SubtitleTheme,
  SubtitleWordStyle,
  VideoAspectRatio,
  VideoEditSettings,
  VideoFilterPresetId,
  VoiceSettings,
} from "../types";
import { DEFAULT_VIDEO_EDIT } from "./videoFilters";
import { DEFAULT_VOICE_SETTINGS } from "./voicePresets";

export type CustomPresetCategory = "visual" | "audio" | "subtitle";

export interface VisualPresetValues {
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
}

export type AudioPresetValues = VoiceSettings;

export interface SubtitlePresetValues {
  subtitleTheme: SubtitleTheme;
  subtitleHighlightColor: SubtitleHighlightColor;
  subtitleFontScale: SubtitleFontScale;
  subtitleCardStyle: SubtitleCardStyle;
  subtitleWordStyle: SubtitleWordStyle;
  subtitleFontFamily: SubtitleFontFamily;
  subtitleAlign: SubtitleAlign;
  subtitleSizePct: number;
  subtitleCardRadius: number;
  subtitleTextWeight: SubtitleTextWeight;
  subtitleLineSpacing: SubtitleLineSpacing;
  showThaiScript: boolean;
  showWordGloss: boolean;
  showBurmeseLine: boolean;
  videoHeightPct: number;
}

export interface CustomPresetValueMap {
  visual: VisualPresetValues;
  audio: AudioPresetValues;
  subtitle: SubtitlePresetValues;
}

export interface CustomPresetRecord<C extends CustomPresetCategory = CustomPresetCategory> {
  id: string;
  category: C;
  name: string;
  values: CustomPresetValueMap[C];
  createdAt: number;
  updatedAt: number;
}

interface StoredPresetsPayload {
  version: 1;
  visual: CustomPresetRecord<"visual">[];
  audio: CustomPresetRecord<"audio">[];
  subtitle: CustomPresetRecord<"subtitle">[];
}

const STORAGE_KEY = "thai-studio-custom-presets-v1";
const CHANGE_EVENT = "thai-studio-custom-presets-changed";

function emptyStore(): StoredPresetsPayload {
  return {
    version: 1,
    visual: [],
    audio: [],
    subtitle: [],
  };
}

function readStore(): StoredPresetsPayload {
  if (typeof window === "undefined") return emptyStore();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<StoredPresetsPayload> | null;
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return {
      version: 1,
      visual: Array.isArray(parsed.visual) ? parsed.visual : [],
      audio: Array.isArray(parsed.audio) ? parsed.audio : [],
      subtitle: Array.isArray(parsed.subtitle) ? parsed.subtitle : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(payload: StoredPresetsPayload): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    return true;
  } catch {
    return false;
  }
}

function createPresetId(category: CustomPresetCategory): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${category}_${Date.now()}_${rand}`;
}

export function subscribeCustomPresets(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function listCustomPresets<C extends CustomPresetCategory>(
  category: C
): CustomPresetRecord<C>[] {
  const store = readStore();
  return [...store[category]] as CustomPresetRecord<C>[];
}

export function saveCustomPreset<C extends CustomPresetCategory>(
  category: C,
  name: string,
  values: CustomPresetValueMap[C]
): CustomPresetRecord<C> {
  const store = readStore();
  const trimmed = name.trim();
  const fallbackPrefix =
    category === "visual" ? "Look" : category === "audio" ? "Voice" : "Subtitle";
  const finalName = trimmed || `${fallbackPrefix} ${store[category].length + 1}`;
  const now = Date.now();
  const record: CustomPresetRecord<C> = {
    id: createPresetId(category),
    category,
    name: finalName,
    values: { ...values },
    createdAt: now,
    updatedAt: now,
  };
  const nextList = [record, ...(store[category] as CustomPresetRecord<C>[])];
  writeStore({
    ...store,
    [category]: nextList,
  });
  return record;
}

export function updateCustomPresetValues<C extends CustomPresetCategory>(
  category: C,
  id: string,
  values: CustomPresetValueMap[C]
): CustomPresetRecord<C> | null {
  const store = readStore();
  let updated: CustomPresetRecord<C> | null = null;
  const nextList = (store[category] as CustomPresetRecord<C>[]).map((item) => {
    if (item.id !== id) return item;
    updated = {
      ...item,
      values: { ...values },
      updatedAt: Date.now(),
    };
    return updated;
  });
  if (!updated) return null;
  writeStore({
    ...store,
    [category]: nextList,
  });
  return updated;
}

export function deleteCustomPreset(
  category: CustomPresetCategory,
  id: string
): void {
  const store = readStore();
  const nextList = store[category].filter((item) => item.id !== id);
  writeStore({
    ...store,
    [category]: nextList,
  });
}

// --- Field extractors & applicators ---

export function extractVisualPresetValues(
  settings: VideoEditSettings
): VisualPresetValues {
  return {
    filterPreset: settings.filterPreset ?? DEFAULT_VIDEO_EDIT.filterPreset,
    playbackSpeed: settings.playbackSpeed ?? DEFAULT_VIDEO_EDIT.playbackSpeed,
    aspectRatio: settings.aspectRatio ?? DEFAULT_VIDEO_EDIT.aspectRatio,
    zoom: settings.zoom ?? DEFAULT_VIDEO_EDIT.zoom,
    panX: settings.panX ?? DEFAULT_VIDEO_EDIT.panX,
    panY: settings.panY ?? DEFAULT_VIDEO_EDIT.panY,
    rotateDeg: settings.rotateDeg ?? DEFAULT_VIDEO_EDIT.rotateDeg,
    flipH: Boolean(settings.flipH),
    flipV: Boolean(settings.flipV),
    fitMode: settings.fitMode ?? DEFAULT_VIDEO_EDIT.fitMode,
    videoHeightPct: settings.videoHeightPct ?? DEFAULT_VIDEO_EDIT.videoHeightPct,
    brightness: settings.brightness ?? DEFAULT_VIDEO_EDIT.brightness,
    contrast: settings.contrast ?? DEFAULT_VIDEO_EDIT.contrast,
    saturation: settings.saturation ?? DEFAULT_VIDEO_EDIT.saturation,
    hueDeg: settings.hueDeg ?? DEFAULT_VIDEO_EDIT.hueDeg,
    sepia: settings.sepia ?? DEFAULT_VIDEO_EDIT.sepia,
    grayscale: settings.grayscale ?? DEFAULT_VIDEO_EDIT.grayscale,
    blurPx: settings.blurPx ?? DEFAULT_VIDEO_EDIT.blurPx,
    vignette: settings.vignette ?? DEFAULT_VIDEO_EDIT.vignette,
    adversarialNoise: Boolean(settings.adversarialNoise),
    adversarialStrength:
      settings.adversarialStrength ?? DEFAULT_VIDEO_EDIT.adversarialStrength,
  };
}

export function applyVisualPresetValues(
  current: VideoEditSettings,
  values: VisualPresetValues
): VideoEditSettings {
  return {
    ...current,
    ...values,
  };
}

export function extractAudioPresetValues(
  voiceSettings: VoiceSettings
): AudioPresetValues {
  return {
    presetId: voiceSettings.presetId ?? DEFAULT_VOICE_SETTINGS.presetId,
    pitchSemitones:
      voiceSettings.pitchSemitones ?? DEFAULT_VOICE_SETTINGS.pitchSemitones,
    speed: voiceSettings.speed ?? DEFAULT_VOICE_SETTINGS.speed,
    tone: voiceSettings.tone ?? DEFAULT_VOICE_SETTINGS.tone,
    echo: voiceSettings.echo ?? DEFAULT_VOICE_SETTINGS.echo,
    robot: voiceSettings.robot ?? DEFAULT_VOICE_SETTINGS.robot,
    adversarialNoise: Boolean(voiceSettings.adversarialNoise),
    adversarialStrength:
      voiceSettings.adversarialStrength ??
      DEFAULT_VOICE_SETTINGS.adversarialStrength,
    spectralPhaseShift: Boolean(voiceSettings.spectralPhaseShift),
    spectralPhaseStrength:
      voiceSettings.spectralPhaseStrength ??
      DEFAULT_VOICE_SETTINGS.spectralPhaseStrength,
    vocalIsolation: Boolean(voiceSettings.vocalIsolation),
    vocalIsolationStrength:
      voiceSettings.vocalIsolationStrength ??
      DEFAULT_VOICE_SETTINGS.vocalIsolationStrength,
  };
}

export function extractSubtitlePresetValues(
  settings: VideoEditSettings
): SubtitlePresetValues {
  const sizePct =
    typeof settings.subtitleSizePct === "number" &&
    Number.isFinite(settings.subtitleSizePct)
      ? Math.round(settings.subtitleSizePct)
      : settings.subtitleFontScale === "sm"
        ? 86
        : settings.subtitleFontScale === "lg"
          ? 116
          : 100;

  return {
    subtitleTheme: settings.subtitleTheme ?? DEFAULT_VIDEO_EDIT.subtitleTheme,
    subtitleHighlightColor:
      settings.subtitleHighlightColor ?? DEFAULT_VIDEO_EDIT.subtitleHighlightColor,
    subtitleFontScale:
      settings.subtitleFontScale ?? DEFAULT_VIDEO_EDIT.subtitleFontScale,
    subtitleCardStyle:
      settings.subtitleCardStyle ?? DEFAULT_VIDEO_EDIT.subtitleCardStyle ?? "card",
    subtitleWordStyle:
      settings.subtitleWordStyle ?? DEFAULT_VIDEO_EDIT.subtitleWordStyle ?? "fill",
    subtitleFontFamily:
      settings.subtitleFontFamily ?? DEFAULT_VIDEO_EDIT.subtitleFontFamily ?? "sans",
    subtitleAlign:
      settings.subtitleAlign ?? DEFAULT_VIDEO_EDIT.subtitleAlign ?? "left",
    subtitleSizePct: sizePct,
    subtitleCardRadius:
      typeof settings.subtitleCardRadius === "number" &&
      Number.isFinite(settings.subtitleCardRadius)
        ? Math.round(settings.subtitleCardRadius)
        : DEFAULT_VIDEO_EDIT.subtitleCardRadius ?? 18,
    subtitleTextWeight:
      settings.subtitleTextWeight ??
      DEFAULT_VIDEO_EDIT.subtitleTextWeight ??
      "semibold",
    subtitleLineSpacing:
      settings.subtitleLineSpacing ??
      DEFAULT_VIDEO_EDIT.subtitleLineSpacing ??
      "normal",
    showThaiScript: Boolean(settings.showThaiScript),
    showWordGloss: settings.showWordGloss !== false,
    showBurmeseLine: settings.showBurmeseLine !== false,
    videoHeightPct: Math.round(
      settings.videoHeightPct ?? DEFAULT_VIDEO_EDIT.videoHeightPct
    ),
  };
}

export function applySubtitlePresetValues(
  current: VideoEditSettings,
  values: SubtitlePresetValues
): VideoEditSettings {
  return {
    ...current,
    ...values,
  };
}

// --- Match helpers to show active preset highlight ---

function numEq(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

export function isVisualPresetMatch(
  current: VideoEditSettings,
  values: VisualPresetValues
): boolean {
  const c = extractVisualPresetValues(current);
  return (
    c.filterPreset === values.filterPreset &&
    numEq(c.playbackSpeed, values.playbackSpeed) &&
    c.aspectRatio === values.aspectRatio &&
    numEq(c.zoom, values.zoom) &&
    c.panX === values.panX &&
    c.panY === values.panY &&
    c.rotateDeg === values.rotateDeg &&
    c.flipH === values.flipH &&
    c.flipV === values.flipV &&
    c.fitMode === values.fitMode &&
    c.videoHeightPct === values.videoHeightPct &&
    c.brightness === values.brightness &&
    c.contrast === values.contrast &&
    c.saturation === values.saturation &&
    c.hueDeg === values.hueDeg &&
    c.sepia === values.sepia &&
    c.grayscale === values.grayscale &&
    numEq(c.blurPx, values.blurPx, 0.05) &&
    c.vignette === values.vignette &&
    c.adversarialNoise === values.adversarialNoise &&
    c.adversarialStrength === values.adversarialStrength
  );
}

export function isAudioPresetMatch(
  current: VoiceSettings,
  values: AudioPresetValues
): boolean {
  const c = extractAudioPresetValues(current);
  return (
    numEq(c.pitchSemitones, values.pitchSemitones) &&
    numEq(c.speed, values.speed) &&
    c.tone === values.tone &&
    c.echo === values.echo &&
    c.robot === values.robot &&
    c.adversarialNoise === values.adversarialNoise &&
    c.adversarialStrength === values.adversarialStrength &&
    c.spectralPhaseShift === values.spectralPhaseShift &&
    c.spectralPhaseStrength === values.spectralPhaseStrength &&
    c.vocalIsolation === values.vocalIsolation &&
    c.vocalIsolationStrength === values.vocalIsolationStrength
  );
}

export function isSubtitlePresetMatch(
  current: VideoEditSettings,
  values: SubtitlePresetValues
): boolean {
  const c = extractSubtitlePresetValues(current);
  return (
    c.subtitleTheme === values.subtitleTheme &&
    c.subtitleHighlightColor === values.subtitleHighlightColor &&
    c.subtitleCardStyle === values.subtitleCardStyle &&
    c.subtitleWordStyle === values.subtitleWordStyle &&
    c.subtitleFontFamily === values.subtitleFontFamily &&
    c.subtitleAlign === values.subtitleAlign &&
    c.subtitleSizePct === values.subtitleSizePct &&
    c.subtitleCardRadius === values.subtitleCardRadius &&
    c.subtitleTextWeight === values.subtitleTextWeight &&
    c.subtitleLineSpacing === values.subtitleLineSpacing &&
    c.showThaiScript === values.showThaiScript &&
    c.showWordGloss === values.showWordGloss &&
    c.showBurmeseLine === values.showBurmeseLine &&
    c.videoHeightPct === values.videoHeightPct
  );
}
