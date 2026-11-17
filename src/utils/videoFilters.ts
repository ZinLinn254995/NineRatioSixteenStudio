import type { VideoEditSettings, VideoFilterPresetId } from "../types";

export const DEFAULT_VIDEO_EDIT: VideoEditSettings = {
  filterPreset: "normal",
  zoom: 1,
  panX: 0,
  panY: 0,
  rotateDeg: 0,
  flipH: false,
  flipV: false,
  fitMode: "cover",
  videoHeightPct: 35,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hueDeg: 0,
  sepia: 0,
  grayscale: 0,
  blurPx: 0,
  vignette: 0,
};

export interface VideoFilterPresetOption {
  id: VideoFilterPresetId;
  label: string;
  values: Pick<
    VideoEditSettings,
    "brightness" | "contrast" | "saturation" | "hueDeg" | "sepia" | "grayscale" | "vignette"
  >;
}

export const VIDEO_FILTER_PRESETS: VideoFilterPresetOption[] = [
  {
    id: "normal",
    label: "Normal",
    values: {
      brightness: 100,
      contrast: 100,
      saturation: 100,
      hueDeg: 0,
      sepia: 0,
      grayscale: 0,
      vignette: 0,
    },
  },
  {
    id: "vivid",
    label: "Vivid",
    values: {
      brightness: 106,
      contrast: 122,
      saturation: 138,
      hueDeg: 0,
      sepia: 0,
      grayscale: 0,
      vignette: 10,
    },
  },
  {
    id: "bw",
    label: "B&W",
    values: {
      brightness: 104,
      contrast: 124,
      saturation: 0,
      hueDeg: 0,
      sepia: 0,
      grayscale: 100,
      vignette: 18,
    },
  },
  {
    id: "warm",
    label: "Warm",
    values: {
      brightness: 105,
      contrast: 106,
      saturation: 118,
      hueDeg: -8,
      sepia: 22,
      grayscale: 0,
      vignette: 12,
    },
  },
  {
    id: "cool",
    label: "Cool",
    values: {
      brightness: 102,
      contrast: 108,
      saturation: 110,
      hueDeg: 14,
      sepia: 0,
      grayscale: 0,
      vignette: 10,
    },
  },
  {
    id: "vintage",
    label: "Vintage",
    values: {
      brightness: 98,
      contrast: 92,
      saturation: 82,
      hueDeg: -6,
      sepia: 48,
      grayscale: 0,
      vignette: 32,
    },
  },
  {
    id: "dramatic",
    label: "Dramatic",
    values: {
      brightness: 95,
      contrast: 138,
      saturation: 90,
      hueDeg: 0,
      sepia: 8,
      grayscale: 0,
      vignette: 42,
    },
  },
  {
    id: "soft",
    label: "Soft",
    values: {
      brightness: 112,
      contrast: 88,
      saturation: 96,
      hueDeg: 0,
      sepia: 6,
      grayscale: 0,
      vignette: 0,
    },
  },
];

export function buildCssFilterString(edit: VideoEditSettings): string {
  const parts: string[] = [];
  if (edit.brightness !== 100) parts.push(`brightness(${edit.brightness}%)`);
  if (edit.contrast !== 100) parts.push(`contrast(${edit.contrast}%)`);
  if (edit.saturation !== 100) parts.push(`saturate(${edit.saturation}%)`);
  if (edit.hueDeg !== 0) parts.push(`hue-rotate(${edit.hueDeg}deg)`);
  if (edit.sepia > 0) parts.push(`sepia(${edit.sepia}%)`);
  if (edit.grayscale > 0) parts.push(`grayscale(${edit.grayscale}%)`);
  if (edit.blurPx > 0) parts.push(`blur(${edit.blurPx}px)`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

export function buildCssTransformString(edit: VideoEditSettings): string {
  const sx = edit.zoom * (edit.flipH ? -1 : 1);
  const sy = edit.zoom * (edit.flipV ? -1 : 1);
  return `translate(${edit.panX}%, ${edit.panY}%) scale(${sx}, ${sy}) rotate(${edit.rotateDeg}deg)`;
}
