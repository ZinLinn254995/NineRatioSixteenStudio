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

export type StudioEditSectionId = "visual" | "audio";
export type EditSectionId = "timeline" | StudioEditSectionId;

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
  activeSection?: EditSectionId;
  hideTabStrip?: boolean;
  hideTimeline?: boolean;
  onChange: (next: VideoEditSettings) => void;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (sec: number) => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateProjectScenes: (nextScenes: SpeakingScene[]) => void;
  onUpdateSubtitleTiming?: (id: string, startTime: number, endTime: number) => void;
  onRestoreProjectSnapshot: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onGoToScenes?: () => void;
}

export function getVideoEditDirtyMap(
  settings: VideoEditSettings,
  voiceSettings: VoiceSettings
) {
  const voiceDirty =
    voiceSettings.presetId !== DEFAULT_VOICE_SETTINGS.presetId ||
    Math.abs(voiceSettings.pitchSemitones - DEFAULT_VOICE_SETTINGS.pitchSemitones) > 0.01 ||
    Math.abs(voiceSettings.speed - DEFAULT_VOICE_SETTINGS.speed) > 0.01 ||
    voiceSettings.tone !== DEFAULT_VOICE_SETTINGS.tone ||
    voiceSettings.echo !== DEFAULT_VOICE_SETTINGS.echo ||
    voiceSettings.robot !== DEFAULT_VOICE_SETTINGS.robot ||
    voiceSettings.adversarialNoise !== DEFAULT_VOICE_SETTINGS.adversarialNoise ||
    voiceSettings.adversarialStrength !== DEFAULT_VOICE_SETTINGS.adversarialStrength ||
    voiceSettings.spectralPhaseShift !== DEFAULT_VOICE_SETTINGS.spectralPhaseShift ||
    voiceSettings.spectralPhaseStrength !== DEFAULT_VOICE_SETTINGS.spectralPhaseStrength ||
    voiceSettings.vocalIsolation !== DEFAULT_VOICE_SETTINGS.vocalIsolation ||
    voiceSettings.vocalIsolationStrength !== DEFAULT_VOICE_SETTINGS.vocalIsolationStrength;

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
  const noiseDirty =
    settings.adversarialNoise !== DEFAULT_VIDEO_EDIT.adversarialNoise ||
    settings.adversarialStrength !== DEFAULT_VIDEO_EDIT.adversarialStrength;

  const visualDirty = speedDirty || framingDirty || filtersDirty || colorDirty || noiseDirty;
  const audioDirty = voiceDirty;

  return {
    voiceDirty,
    speedDirty,
    framingDirty,
    filtersDirty,
    colorDirty,
    noiseDirty,
    visualDirty,
    audioDirty,
    isModified: visualDirty || audioDirty,
  };
}

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
  activeSection,
  hideTabStrip = false,
  hideTimeline = false,
  onChange,
  onChangeVoiceSettings,
  onTogglePlay,
  onPause,
  onSeek,
  onPlayFromTime,
  onUpdateProjectScenes,
  onUpdateSubtitleTiming,
  onRestoreProjectSnapshot,
  onResetTimeline,
  onGoToScenes,
}: VideoEditPanelProps) {
  const [internalSection, setInternalSection] = useState<EditSectionId>(
    hideTimeline ? "visual" : "timeline"
  );
  const section = activeSection ?? internalSection;

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

  const { visualDirty, audioDirty, isModified } = getVideoEditDirtyMap(settings, voiceSettings);
  const isYoutube = sourceType === "youtube";
  const effectiveSpeed = getEffectivePlaybackSpeed(
    sourceType,
    settings.playbackSpeed,
    voiceSettings.speed
  );
  const scaledDurationSec =
    sourceDurationSec && sourceDurationSec > 0 ? sourceDurationSec / effectiveSpeed : null;

  const allSections: {
    id: EditSectionId;
    label: string;
    dirty: boolean;
    icon: typeof SlidersHorizontal;
  }[] = [
    { id: "timeline", label: "Timeline", dirty: timelineDirty, icon: Scissors },
    { id: "visual", label: "Video & Look", dirty: visualDirty, icon: SlidersHorizontal },
    { id: "audio", label: "Audio & Voice", dirty: audioDirty, icon: Mic },
  ];
  const sections = hideTimeline ? allSections.filter((s) => s.id !== "timeline") : allSections;

  return (
    <div className={hideTabStrip ? "" : "space-y-3 pb-4"}>
      {/* Optional Category Switcher (hidden when WorkspaceSidebar hosts top tabs) */}
      {!hideTabStrip && (
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#dde2e9] dark:border-[#242a34]">
          <div
            role="tablist"
            aria-label="Edit setting categories"
            className="inline-flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full"
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
                  onClick={() => setInternalSection(item.id)}
                  className={`relative px-2.5 py-1.5 text-xs font-medium rounded-sm whitespace-nowrap shrink-0 flex items-center gap-1.5 transition-colors cursor-pointer ${
                    active
                      ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] font-semibold"
                      : item.dirty
                        ? "text-teal-700 dark:text-teal-400 bg-teal-50/70 dark:bg-teal-950/40"
                        : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23]"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {isModified && (
            <button
              type="button"
              onClick={() => {
                onChange({
                  ...DEFAULT_VIDEO_EDIT,
                  showThaiScript: settings.showThaiScript,
                  translationTone: settings.translationTone,
                  subtitleFontScale: settings.subtitleFontScale,
                  subtitleTheme: settings.subtitleTheme,
                  subtitleHighlightColor: settings.subtitleHighlightColor,
                  showWordGloss: settings.showWordGloss,
                  showBurmeseLine: settings.showBurmeseLine,
                });
                onChangeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS });
              }}
              className="text-xs font-medium text-[#525d6d] dark:text-[#8b95a5] hover:text-teal-700 dark:hover:text-teal-400 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset All</span>
            </button>
          )}
        </div>
      )}

      {/* Section: 9:16 Video Timeline Editor */}
      {section === "timeline" && !hideTimeline && (
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
          onUpdateSubtitleTiming={onUpdateSubtitleTiming}
          onRestoreSnapshot={onRestoreProjectSnapshot}
          onResetTimeline={onResetTimeline}
          onGoToScenes={onGoToScenes}
        />
      )}

      {/* Section: Unified Video & Look (Speed · Framing · Filters · Color · Pixel Shield) */}
      {section === "visual" && (
        <div className="divide-y divide-[#dde2e9] dark:divide-[#242a34]">
          {/* 1. Playback Speed */}
          <div className="pb-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#525d6d] dark:text-[#8b95a5]">
                <Gauge className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400" />
                <span>Speed</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs font-mono-tabular">
                <span className="text-[#0e1217] dark:text-[#f1f3f5] font-semibold">
                  {isYoutube ? `${effectiveSpeed}x` : `${settings.playbackSpeed.toFixed(2)}x`}
                </span>
                {scaledDurationSec !== null && sourceDurationSec && (
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">
                    ({formatSpeedDuration(sourceDurationSec)} →{" "}
                    <span className="text-[#0e1217] dark:text-[#f1f3f5] font-medium">
                      {formatSpeedDuration(scaledDurationSec)}
                    </span>
                    )
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-6 gap-1">
              {SPEED_PRESETS.map((presetSpeed) => {
                const active = Math.abs(settings.playbackSpeed - presetSpeed) < 0.01;
                return (
                  <button
                    key={presetSpeed}
                    type="button"
                    onClick={() => updateField("playbackSpeed", presetSpeed)}
                    className={`h-7 px-1 rounded-sm text-[11px] font-mono-tabular font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                      active
                        ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400 font-semibold"
                        : "bg-[#f5f6f8] dark:bg-[#181c23] text-[#0e1217] dark:text-[#f1f3f5] border-[#dde2e9] dark:border-[#242a34] hover:border-teal-600/50 dark:hover:border-teal-400/50"
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
              className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
            />
          </div>

          {/* 2. Framing & Transform */}
          <div className="py-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#525d6d] dark:text-[#8b95a5]">
                Framing & Crop
              </span>
              <div className="inline-flex items-center rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] overflow-hidden">
                <button
                  type="button"
                  onClick={() => updateField("fitMode", "cover")}
                  className={`h-6 px-2 text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                    settings.fitMode === "cover"
                      ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] font-semibold"
                      : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                  }`}
                >
                  <Maximize2 className="w-2.5 h-2.5" />
                  <span>Fill</span>
                </button>
                <button
                  type="button"
                  onClick={() => updateField("fitMode", "contain")}
                  className={`h-6 px-2 text-[11px] font-medium flex items-center gap-1 border-l border-[#dde2e9] dark:border-[#242a34] cursor-pointer transition-colors ${
                    settings.fitMode === "contain"
                      ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] font-semibold"
                      : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                  }`}
                >
                  <Minimize2 className="w-2.5 h-2.5" />
                  <span>Fit</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-6 gap-1">
              <button
                type="button"
                onClick={() =>
                  updateField("zoom", Math.max(0.5, Number((settings.zoom - 0.15).toFixed(2))))
                }
                title="Zoom Out"
                className="h-7 px-1 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
              >
                <ZoomOut className="w-3 h-3" />
                <span>Out</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  updateField("zoom", Math.min(2.5, Number((settings.zoom + 0.15).toFixed(2))))
                }
                title="Zoom In"
                className="h-7 px-1 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
              >
                <ZoomIn className="w-3 h-3" />
                <span>In</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = settings.rotateDeg - 90;
                  updateField("rotateDeg", next < -180 ? next + 360 : next);
                }}
                title="Rotate -90°"
                className="h-7 px-1 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                <span>90°</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = settings.rotateDeg + 90;
                  updateField("rotateDeg", next > 180 ? next - 360 : next);
                }}
                title="Rotate +90°"
                className="h-7 px-1 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
              >
                <RotateCw className="w-3 h-3" />
                <span>90°</span>
              </button>

              <button
                type="button"
                onClick={() => updateField("flipH", !settings.flipH)}
                title="Flip Horizontal"
                className={`h-7 px-1 rounded-sm border text-[11px] font-medium flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                  settings.flipH
                    ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400 font-semibold"
                    : "border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e]"
                }`}
              >
                <FlipHorizontal2 className="w-3 h-3" />
                <span>H</span>
              </button>

              <button
                type="button"
                onClick={() => updateField("flipV", !settings.flipV)}
                title="Flip Vertical"
                className={`h-7 px-1 rounded-sm border text-[11px] font-medium flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                  settings.flipV
                    ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400 font-semibold"
                    : "border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e]"
                }`}
              >
                <FlipVertical2 className="w-3 h-3" />
                <span>V</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Zoom</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Rotate</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Position X</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Position Y</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#525d6d] dark:text-[#8b95a5]">Stage Split (Video Height)</span>
                <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
              />
            </div>
          </div>

          {/* 3. Look & Filter Presets */}
          <div className="py-3 space-y-2">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#525d6d] dark:text-[#8b95a5]">
              Filter Presets
            </span>
            <div className="grid grid-cols-4 gap-1.5">
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
                    className={`h-7 px-2 rounded-sm text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap truncate ${
                      active
                        ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400 font-semibold"
                        : "bg-[#f5f6f8] dark:bg-[#181c23] text-[#0e1217] dark:text-[#f1f3f5] border-[#dde2e9] dark:border-[#242a34] hover:border-teal-600/50 dark:hover:border-teal-400/50"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Color & Lens Grade */}
          <div className="py-3 space-y-2.5">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#525d6d] dark:text-[#8b95a5]">
              Color & Lens
            </span>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Brightness</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Contrast</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Saturation</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Color Hue</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Blur</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">Vignette</span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* 5. Visual Shield / Pixel Perturbations */}
          <div className="pt-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
                  <Shield className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                  <span>Pixel Perturbations</span>
                </div>
                <p className="text-[11px] text-[#525d6d] dark:text-[#8b95a5] mt-0.5 leading-snug">
                  Subtle RGB pixel perturbations applied to preview and MP4 export frames.
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={settings.adversarialNoise}
                aria-label="Toggle Adversarial Noise / Pixel Perturbations"
                onClick={() => updateField("adversarialNoise", !settings.adversarialNoise)}
                className={`h-6 px-2.5 rounded-sm text-[11px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                  settings.adversarialNoise
                    ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400"
                    : "bg-[#eceff3] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] border-[#dde2e9] dark:border-[#242a34] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                }`}
              >
                {settings.adversarialNoise ? "ON" : "OFF"}
              </button>
            </div>

            {settings.adversarialNoise && (
              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#525d6d] dark:text-[#8b95a5]">
                    Perturbation Strength (ε)
                  </span>
                  <span className="font-mono-tabular text-[#0e1217] dark:text-[#f1f3f5]">
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
                  className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Section: Voice Changer & Audio Shield */}
      {section === "audio" && (
        <VoiceChangerPanel
          sourceType={sourceType}
          settings={voiceSettings}
          onChange={onChangeVoiceSettings}
        />
      )}
    </div>
  );
}
