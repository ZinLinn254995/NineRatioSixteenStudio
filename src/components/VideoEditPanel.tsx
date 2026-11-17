import {
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { VideoEditSettings } from "../types";
import { DEFAULT_VIDEO_EDIT, VIDEO_FILTER_PRESETS } from "../utils/videoFilters";

interface VideoEditPanelProps {
  settings: VideoEditSettings;
  onChange: (next: VideoEditSettings) => void;
}

export function VideoEditPanel({ settings, onChange }: VideoEditPanelProps) {
  const updateField = <K extends keyof VideoEditSettings>(
    key: K,
    value: VideoEditSettings[K],
    markCustomFilter = false
  ) => {
    onChange({
      ...settings,
      ...(markCustomFilter ? { filterPreset: "custom" } : {}),
      [key]: value,
    });
  };

  const isModified = JSON.stringify(settings) !== JSON.stringify(DEFAULT_VIDEO_EDIT);

  return (
    <div className="space-y-4 pb-6">
      {/* Header + Reset */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Transform & Framing
        </span>
        {isModified && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_VIDEO_EDIT })}
            className="text-xs text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset All</span>
          </button>
        )}
      </div>

      {/* Transform Controls: Zoom, Rotate, Flip, Fit, Pan */}
      <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-4">
        {/* Quick Action Row: Zoom Out/In, Rotate -90/+90, Flip H/V, Fit */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <button
            type="button"
            onClick={() =>
              updateField("zoom", Math.max(0.5, Number((settings.zoom - 0.15).toFixed(2))))
            }
            title="Zoom Out"
            className="h-9 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
            <span>Out</span>
          </button>

          <button
            type="button"
            onClick={() =>
              updateField("zoom", Math.min(2.5, Number((settings.zoom + 0.15).toFixed(2))))
            }
            title="Zoom In"
            className="h-9 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
            <span>In</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const next = settings.rotateDeg - 90;
              updateField("rotateDeg", next < -180 ? next + 360 : next);
            }}
            title="Rotate -90°"
            className="h-9 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>90°</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const next = settings.rotateDeg + 90;
              updateField("rotateDeg", next > 180 ? next - 360 : next);
            }}
            title="Rotate +90°"
            className="h-9 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>90°</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("flipH", !settings.flipH)}
            title="Flip Horizontal"
            className={`h-9 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              settings.flipH
                ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            <FlipHorizontal2 className="w-3.5 h-3.5" />
            <span>Flip H</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("flipV", !settings.flipV)}
            title="Flip Vertical"
            className={`h-9 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              settings.flipV
                ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            <FlipVertical2 className="w-3.5 h-3.5" />
            <span>Flip V</span>
          </button>
        </div>

        {/* Zoom Slider */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-300">Zoom</span>
            <span className="font-mono-tabular text-neutral-950 dark:text-white">
              {settings.zoom.toFixed(2)}x
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={2.5}
            step={0.05}
            value={settings.zoom}
            onChange={(e) => updateField("zoom", parseFloat(e.target.value))}
            aria-label="Video zoom"
            className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
          />
        </div>

        {/* Rotate Slider */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-300">Rotate</span>
            <span className="font-mono-tabular text-neutral-950 dark:text-white">
              {settings.rotateDeg}°
            </span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={settings.rotateDeg}
            onChange={(e) => updateField("rotateDeg", parseInt(e.target.value, 10))}
            aria-label="Video rotation"
            className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
          />
        </div>

        {/* Pan X & Pan Y */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Position X</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.panX}%
              </span>
            </div>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={settings.panX}
              onChange={(e) => updateField("panX", parseInt(e.target.value, 10))}
              aria-label="Horizontal position"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Position Y</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.panY}%
              </span>
            </div>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={settings.panY}
              onChange={(e) => updateField("panY", parseInt(e.target.value, 10))}
              aria-label="Vertical position"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>
        </div>

        {/* Fit Mode + Top Window Height */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateField("fitMode", "cover")}
              className={`flex-1 h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                settings.fitMode === "cover"
                  ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                  : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300"
              }`}
            >
              <Maximize2 className="w-3 h-3" />
              <span>Fill</span>
            </button>
            <button
              type="button"
              onClick={() => updateField("fitMode", "contain")}
              className={`flex-1 h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                settings.fitMode === "contain"
                  ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                  : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300"
              }`}
            >
              <Minimize2 className="w-3 h-3" />
              <span>Fit</span>
            </button>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Video Height</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.videoHeightPct}%
              </span>
            </div>
            <input
              type="range"
              min={26}
              max={52}
              step={1}
              value={settings.videoHeightPct}
              onChange={(e) => updateField("videoHeightPct", parseInt(e.target.value, 10))}
              aria-label="Top video height percentage"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Filter Presets */}
      <div>
        <span className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2.5">
          Filter Effects
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {VIDEO_FILTER_PRESETS.map((preset) => {
            const active = settings.filterPreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  onChange({
                    ...settings,
                    filterPreset: preset.id,
                    ...preset.values,
                  })
                }
                className={`h-9 px-3 rounded-lg text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                    : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Color & Lens Adjustments */}
      <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-3.5">
        <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
          Color & Effects
        </span>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Brightness</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.brightness}%
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={150}
              step={1}
              value={settings.brightness}
              onChange={(e) => updateField("brightness", parseInt(e.target.value, 10), true)}
              aria-label="Brightness"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Contrast</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.contrast}%
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={180}
              step={1}
              value={settings.contrast}
              onChange={(e) => updateField("contrast", parseInt(e.target.value, 10), true)}
              aria-label="Contrast"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Saturation</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.saturation}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={settings.saturation}
              onChange={(e) => updateField("saturation", parseInt(e.target.value, 10), true)}
              aria-label="Saturation"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Color Hue</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.hueDeg}°
              </span>
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={settings.hueDeg}
              onChange={(e) => updateField("hueDeg", parseInt(e.target.value, 10), true)}
              aria-label="Hue rotation"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Blur</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.blurPx}px
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={settings.blurPx}
              onChange={(e) => updateField("blurPx", parseFloat(e.target.value))}
              aria-label="Blur"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Vignette</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.vignette}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={settings.vignette}
              onChange={(e) => updateField("vignette", parseInt(e.target.value, 10), true)}
              aria-label="Vignette"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
