import { useState } from "react";
import {
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Maximize2,
  Mic,
  Minimize2,
  RotateCcw,
  RotateCw,
  Scissors,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Crop,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  SpeakingScene,
  SubtitleItem,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
} from "../types";
import { DEFAULT_VIDEO_EDIT, VIDEO_FILTER_PRESETS } from "../utils/videoFilters";
import { DEFAULT_VOICE_SETTINGS, getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { VoiceChangerPanel } from "./VoiceChangerPanel";
import { ProjectTimelineEditor } from "./ProjectTimelineEditor";

interface VideoEditPanelProps {
  settings: VideoEditSettings;
  voiceSettings: VoiceSettings;
  sourceType?: "youtube" | "local";
  sourceDurationSec?: number;
  project: VideoProject | null;
  cutTime: number;
  isPlaying: boolean;
  isTabActive?: boolean;
  timelineDirty?: boolean;
  onChange: (next: VideoEditSettings) => void;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (sec: number) => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateProjectScenes: (nextScenes: SpeakingScene[]) => void;
  onRestoreProjectSnapshot: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onGoToScenes?: () => void;
}

type EditSectionId = "timeline" | "framing" | "speed" | "filters" | "color" | "voice" | "noise";

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatSpeedDuration(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  if (mins > 0) {
    return `${mins}m ${rem.toFixed(1)}s`;
  }
  return `${s.toFixed(1)}s`;
}

export function VideoEditPanel({
  settings,
  voiceSettings,
  sourceType = "local",
  sourceDurationSec,
  project,
  cutTime,
  isPlaying,
  isTabActive = true,
  timelineDirty = false,
  onChange,
  onChangeVoiceSettings,
  onTogglePlay,
  onPause,
  onSeek,
  onPlayFromTime,
  onUpdateProjectScenes,
  onRestoreProjectSnapshot,
  onResetTimeline,
  onGoToScenes,
}: VideoEditPanelProps) {
  const [section, setSection] = useState<EditSectionId>("timeline");

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

  const voiceDirty =
    voiceSettings.presetId !== DEFAULT_VOICE_SETTINGS.presetId ||
    Math.abs(voiceSettings.pitchSemitones - DEFAULT_VOICE_SETTINGS.pitchSemitones) > 0.01 ||
    Math.abs(voiceSettings.speed - DEFAULT_VOICE_SETTINGS.speed) > 0.01 ||
    voiceSettings.tone !== DEFAULT_VOICE_SETTINGS.tone ||
    voiceSettings.echo !== DEFAULT_VOICE_SETTINGS.echo ||
    voiceSettings.robot !== DEFAULT_VOICE_SETTINGS.robot;

  const isModified =
    JSON.stringify(settings) !== JSON.stringify(DEFAULT_VIDEO_EDIT) || voiceDirty;
  const isYoutube = sourceType === "youtube";
  const effectiveSpeed = getEffectivePlaybackSpeed(
    sourceType,
    settings.playbackSpeed,
    voiceSettings.speed
  );
  const scaledDurationSec =
    sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec / effectiveSpeed : null;

  const speedDirty = Math.abs(settings.playbackSpeed - DEFAULT_VIDEO_EDIT.playbackSpeed) > 0.01;
  const framingDirty =
    settings.zoom !== DEFAULT_VIDEO_EDIT.zoom ||
    settings.rotateDeg !== DEFAULT_VIDEO_EDIT.rotateDeg ||
    settings.flipH !== DEFAULT_VIDEO_EDIT.flipH ||
    settings.flipV !== DEFAULT_VIDEO_EDIT.flipV ||
    settings.panX !== DEFAULT_VIDEO_EDIT.panX ||
    settings.panY !== DEFAULT_VIDEO_EDIT.panY ||
    settings.fitMode !== DEFAULT_VIDEO_EDIT.fitMode ||
    settings.videoHeightPct !== DEFAULT_VIDEO_EDIT.videoHeightPct;
  const filtersDirty = settings.filterPreset !== DEFAULT_VIDEO_EDIT.filterPreset;
  const colorDirty =
    settings.brightness !== DEFAULT_VIDEO_EDIT.brightness ||
    settings.contrast !== DEFAULT_VIDEO_EDIT.contrast ||
    settings.saturation !== DEFAULT_VIDEO_EDIT.saturation ||
    settings.hueDeg !== DEFAULT_VIDEO_EDIT.hueDeg ||
    settings.blurPx !== DEFAULT_VIDEO_EDIT.blurPx ||
    settings.vignette !== DEFAULT_VIDEO_EDIT.vignette;
  const noiseDirty = settings.adversarialNoise !== DEFAULT_VIDEO_EDIT.adversarialNoise;

  const sections: {
    id: EditSectionId;
    label: string;
    dirty: boolean;
    icon: typeof Gauge;
  }[] = [
    { id: "timeline", label: "Timeline", dirty: timelineDirty, icon: Scissors },
    { id: "framing", label: "Framing", dirty: framingDirty, icon: Crop },
    { id: "speed", label: "Speed", dirty: speedDirty, icon: Gauge },
    { id: "filters", label: "Filters", dirty: filtersDirty, icon: Sparkles },
    { id: "color", label: "Color", dirty: colorDirty, icon: SlidersHorizontal },
    { id: "voice", label: "Voice", dirty: voiceDirty, icon: Mic },
    { id: "noise", label: "Noise", dirty: noiseDirty, icon: Shield },
  ];

  return (
    <div className="space-y-3 pb-4">
      {/* Compact Header + Category Switcher */}
      <div className="flex items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Edit setting categories"
          className="inline-flex items-center p-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 overflow-x-auto no-scrollbar max-w-full"
        >
          {sections.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSection(item.id)}
                className={`relative px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap flex items-center gap-1.5 transition-colors cursor-pointer ${
                  active
                    ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                    : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{item.label}</span>
                {item.dirty && (
                  <span
                    aria-hidden="true"
                    className="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 shrink-0"
                  />
                )}
              </button>
            );
          })}
        </div>

        {isModified && (
          <button
            type="button"
            onClick={() => {
              onChange({ ...DEFAULT_VIDEO_EDIT });
              onChangeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS });
            }}
            className="text-xs text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset All</span>
          </button>
        )}
      </div>

      {/* Section: 9:16 Video Timeline Editor */}
      {section === "timeline" && (
        <ProjectTimelineEditor
          project={project}
          cutTime={cutTime}
          isPlaying={isPlaying}
          isActive={isTabActive && section === "timeline"}
          onTogglePlay={onTogglePlay}
          onPause={onPause}
          onSeek={onSeek}
          onPlayFromTime={onPlayFromTime}
          onUpdateScenes={onUpdateProjectScenes}
          onRestoreSnapshot={onRestoreProjectSnapshot}
          onResetTimeline={onResetTimeline}
          onGoToScenes={onGoToScenes}
        />
      )}

      {/* Section: Speed */}
      {section === "speed" && (
        <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-900 dark:text-neutral-100">
              <Gauge className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400" />
              <span>Playback Speed</span>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono-tabular">
              <span className="text-neutral-950 dark:text-white font-semibold">
                {isYoutube ? `${effectiveSpeed}x` : `${settings.playbackSpeed.toFixed(2)}x`}
              </span>
              {scaledDurationSec !== null && sourceDurationSec && (
                <span className="text-neutral-500 dark:text-neutral-400">
                  ({formatSpeedDuration(sourceDurationSec)} →{" "}
                  <span className="text-neutral-900 dark:text-neutral-100 font-medium">
                    {formatSpeedDuration(scaledDurationSec)}
                  </span>
                  )
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {SPEED_PRESETS.map((presetSpeed) => {
              const active = Math.abs(settings.playbackSpeed - presetSpeed) < 0.01;
              return (
                <button
                  key={presetSpeed}
                  type="button"
                  onClick={() => updateField("playbackSpeed", presetSpeed)}
                  className={`h-8 px-2 rounded-lg text-xs font-mono-tabular font-medium border transition-colors cursor-pointer ${
                    active
                      ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                      : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500"
                  }`}
                >
                  {presetSpeed}x
                </button>
              );
            })}
          </div>

          <input
            type="range"
            min={0.5}
            max={2}
            step={isYoutube ? 0.25 : 0.05}
            value={settings.playbackSpeed}
            onChange={(e) => updateField("playbackSpeed", parseFloat(e.target.value))}
            aria-label="Global video playback speed"
            className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
          />
        </div>
      )}

      {/* Section: Framing & Transform */}
      {section === "framing" && (
        <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-3">
          {/* Quick Action Row: Zoom Out/In, Rotate -90/+90, Flip H/V */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            <button
              type="button"
              onClick={() =>
                updateField("zoom", Math.max(0.5, Number((settings.zoom - 0.15).toFixed(2))))
              }
              title="Zoom Out"
              className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
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
              className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
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
              className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
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
              className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>90°</span>
            </button>

            <button
              type="button"
              onClick={() => updateField("flipH", !settings.flipH)}
              title="Flip Horizontal"
              className={`h-8 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
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
              className={`h-8 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                settings.flipV
                  ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                  : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              <FlipVertical2 className="w-3.5 h-3.5" />
              <span>Flip V</span>
            </button>
          </div>

          {/* Zoom & Rotate */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
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

            <div className="space-y-1">
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
          </div>

          {/* Pan X & Pan Y */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
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

            <div className="space-y-1">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-0.5">
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
      )}

      {/* Section: Filter Presets */}
      {section === "filters" && (
        <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-2.5">
          <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
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
      )}

      {/* Section: Color & Lens Adjustments */}
      {section === "color" && (
        <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-3">
          <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
            Color & Effects
          </span>

          <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
            <div className="space-y-1">
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

            <div className="space-y-1">
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

            <div className="space-y-1">
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

            <div className="space-y-1">
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

            <div className="space-y-1">
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

            <div className="space-y-1">
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
      )}

      {/* Section: Voice Changer */}
      {section === "voice" && (
        <VoiceChangerPanel
          sourceType={sourceType}
          settings={voiceSettings}
          onChange={onChangeVoiceSettings}
        />
      )}

      {/* Section: Adversarial Noise / Pixel Perturbations */}
      {section === "noise" && (
        <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-900 dark:text-neutral-100">
                <Shield className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 shrink-0" />
                <span>Adversarial Noise / Pixel Perturbations</span>
              </div>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5 leading-snug">
                Apply subtle RGB pixel perturbations to preview and exported MP4 frames.
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={settings.adversarialNoise}
              aria-label="Toggle Adversarial Noise / Pixel Perturbations"
              onClick={() => updateField("adversarialNoise", !settings.adversarialNoise)}
              className={`h-8 px-3 rounded-lg text-xs font-semibold border transition-colors cursor-pointer shrink-0 ${
                settings.adversarialNoise
                  ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                  : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500"
              }`}
            >
              {settings.adversarialNoise ? "ON" : "OFF"}
            </button>
          </div>

          {settings.adversarialNoise && (
            <div className="space-y-1.5 pt-2 border-t border-neutral-200/80 dark:border-neutral-800">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">
                  Perturbation Strength (ε)
                </span>
                <span className="font-mono-tabular text-neutral-950 dark:text-white">
                  ±{settings.adversarialStrength} px
                </span>
              </div>
              <input
                type="range"
                min={4}
                max={30}
                step={1}
                value={settings.adversarialStrength}
                onChange={(e) =>
                  updateField("adversarialStrength", parseInt(e.target.value, 10))
                }
                aria-label="Adversarial pixel perturbation strength"
                className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
