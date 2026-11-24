import type { VideoEditSettings, VideoFilterPresetId } from "../types";

export const DEFAULT_VIDEO_EDIT: VideoEditSettings = {
  filterPreset: "normal",
  playbackSpeed: 1,
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
  adversarialNoise: false,
  adversarialStrength: 12,
  showThaiScript: false,
  translationTone: "casual",
  subtitleFontScale: "md",
  subtitleTheme: "auto",
  subtitleHighlightColor: "indigo",
  showWordGloss: true,
  showBurmeseLine: true,
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

const numOr = (v: unknown, fb: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fb;

export function buildCssFilterString(edit: VideoEditSettings): string {
  const parts: string[] = [];
  const brightness = numOr(edit.brightness, 100);
  const contrast = numOr(edit.contrast, 100);
  const saturation = numOr(edit.saturation, 100);
  const hueDeg = numOr(edit.hueDeg, 0);
  const sepia = numOr(edit.sepia, 0);
  const grayscale = numOr(edit.grayscale, 0);
  const blurPx = numOr(edit.blurPx, 0);
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
  if (saturation !== 100) parts.push(`saturate(${saturation}%)`);
  if (hueDeg !== 0) parts.push(`hue-rotate(${hueDeg}deg)`);
  if (sepia > 0) parts.push(`sepia(${sepia}%)`);
  if (grayscale > 0) parts.push(`grayscale(${grayscale}%)`);
  if (blurPx > 0) parts.push(`blur(${blurPx}px)`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

export function buildCssTransformString(edit: VideoEditSettings): string {
  const zoom = numOr(edit.zoom, 1);
  const panX = numOr(edit.panX, 0);
  const panY = numOr(edit.panY, 0);
  const rotateDeg = numOr(edit.rotateDeg, 0);
  if (
    zoom === 1 &&
    panX === 0 &&
    panY === 0 &&
    rotateDeg === 0 &&
    !edit.flipH &&
    !edit.flipV
  ) {
    return "none";
  }
  const sx = zoom * (edit.flipH ? -1 : 1);
  const sy = zoom * (edit.flipV ? -1 : 1);
  return `translate(${panX}%, ${panY}%) scale(${sx}, ${sy}) rotate(${rotateDeg}deg)`;
}

const ADV_TILE_SIZE = 128;

// Build a deterministic structured high-frequency RGB perturbation tile (-127..+127 normalized sign-gradient + checkerboard)
export function createAdversarialPerturbationTile(phase = 0): Int8Array {
  const tile = new Int8Array(ADV_TILE_SIZE * ADV_TILE_SIZE * 3);
  let seed = (0x9e3779b9 ^ ((phase + 1) * 0x85ebca6b)) >>> 0;
  const pOffset = phase * 19;

  for (let y = 0; y < ADV_TILE_SIZE; y++) {
    for (let x = 0; x < ADV_TILE_SIZE; x++) {
      // Deterministic LCG + multi-frequency Fourier/checkerboard spatial grating
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const randA = ((seed >>> 16) & 0xff) / 127.5 - 1; // [-1, 1]
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const randB = ((seed >>> 16) & 0xff) / 127.5 - 1;

      const checker = ((x + y + phase) & 1) === 0 ? 1 : -1;
      const hfX = Math.sin((x + pOffset) * 1.15) * Math.cos((y - pOffset) * 0.85);
      const hfY = Math.cos((x - pOffset) * 0.9) * Math.sin((y + pOffset) * 1.2);

      // Decoupled R/G/B channel perturbations preserve perceived luminance while shifting pixel feature maps
      const baseIdx = (y * ADV_TILE_SIZE + x) * 3;
      const rVal = Math.max(-1, Math.min(1, 0.45 * checker + 0.35 * hfX + 0.2 * randA));
      const gVal = Math.max(-1, Math.min(1, -0.45 * checker + 0.35 * hfY + 0.2 * randB));
      const bVal = Math.max(-1, Math.min(1, 0.35 * checker - 0.35 * hfX + 0.3 * (randA - randB) * 0.5));

      tile[baseIdx] = Math.round(rVal * 127);
      tile[baseIdx + 1] = Math.round(gVal * 127);
      tile[baseIdx + 2] = Math.round(bVal * 127);
    }
  }
  return tile;
}

// Apply L-infinity bounded ±epsilon RGB pixel perturbations directly onto canvas ImageData
export function applyAdversarialPerturbationToImageData(
  imageData: ImageData,
  epsilon: number,
  tile: Int8Array
): void {
  const eps = Math.max(1, Math.min(32, epsilon));
  const scale = eps / 127;
  const { data, width, height } = imageData;

  for (let y = 0; y < height; y++) {
    const ty = (y & (ADV_TILE_SIZE - 1)) * ADV_TILE_SIZE;
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const tIdx = (ty + (x & (ADV_TILE_SIZE - 1))) * 3;
      const pIdx = rowOffset + x * 4;
      data[pIdx] += Math.round(tile[tIdx] * scale);
      data[pIdx + 1] += Math.round(tile[tIdx + 1] * scale);
      data[pIdx + 2] += Math.round(tile[tIdx + 2] * scale);
    }
  }
}

export function createAdversarialOverlayTileDataUrl(phase = 0): string {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = ADV_TILE_SIZE;
  canvas.height = ADV_TILE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const tile = createAdversarialPerturbationTile(phase);
  const img = ctx.createImageData(ADV_TILE_SIZE, ADV_TILE_SIZE);
  const { data } = img;
  for (let i = 0, p = 0; i < tile.length; i += 3, p += 4) {
    // Neutral 128 midpoint for overlay/hard-light blending across positive & negative perturbations
    data[p] = 128 + tile[i];
    data[p + 1] = 128 + tile[i + 1];
    data[p + 2] = 128 + tile[i + 2];
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

