import type { VoicePresetId, VoiceSettings } from "../types";

export interface VoicePresetOption {
  id: VoicePresetId;
  label: string;
  settings: VoiceSettings;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  presetId: "original",
  pitchSemitones: 0,
  speed: 1,
  tone: 0,
  echo: 0,
  robot: 0,
  adversarialNoise: false,
  adversarialStrength: 35,
  spectralPhaseShift: false,
  spectralPhaseStrength: 50,
  vocalIsolation: false,
  vocalIsolationStrength: 65,
};

const YOUTUBE_SUPPORTED_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function getEffectivePlaybackSpeed(
  sourceType: "youtube" | "local",
  rawSpeed: number,
  extraSpeed = 1
): number {
  const combined = (rawSpeed || 1) * (extraSpeed || 1);
  const clamped = Math.max(0.25, Math.min(2.5, combined));
  if (sourceType === "local") return clamped;
  let nearest = 1;
  let bestDiff = Infinity;
  for (const r of YOUTUBE_SUPPORTED_RATES) {
    const diff = Math.abs(r - clamped);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearest = r;
    }
  }
  return nearest;
}

export const VOICE_PRESETS: VoicePresetOption[] = [
  {
    id: "original",
    label: "Original",
    settings: { ...DEFAULT_VOICE_SETTINGS },
  },
  {
    id: "deep",
    label: "Deep",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "deep",
      pitchSemitones: -4.5,
      speed: 0.96,
      tone: -5,
      echo: 8,
      robot: 0,
    },
  },
  {
    id: "cute",
    label: "Cute",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "cute",
      pitchSemitones: 4.5,
      speed: 1.06,
      tone: 3,
      echo: 0,
      robot: 0,
    },
  },
  {
    id: "cartoon",
    label: "Cartoon",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "cartoon",
      pitchSemitones: 6.5,
      speed: 1.15,
      tone: 5,
      echo: 5,
      robot: 0,
    },
  },
  {
    id: "robot",
    label: "Robot",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "robot",
      pitchSemitones: -1.5,
      speed: 1,
      tone: 4,
      echo: 18,
      robot: 80,
    },
  },
  {
    id: "echo",
    label: "Echo Hall",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "echo",
      pitchSemitones: 0,
      speed: 1,
      tone: -1,
      echo: 65,
      robot: 0,
    },
  },
  {
    id: "radio",
    label: "Radio",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "radio",
      pitchSemitones: -1,
      speed: 1,
      tone: 7,
      echo: 12,
      robot: 0,
    },
  },
  {
    id: "calm",
    label: "Calm",
    settings: {
      ...DEFAULT_VOICE_SETTINGS,
      presetId: "calm",
      pitchSemitones: -1.5,
      speed: 0.86,
      tone: -3,
      echo: 15,
      robot: 0,
    },
  },
];
