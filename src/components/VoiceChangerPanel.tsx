import { useRef } from "react";
import { Download, Loader2, RotateCcw, Upload } from "lucide-react";
import type { VoiceSettings } from "../types";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_PRESETS,
  getEffectivePlaybackSpeed,
} from "../utils/voicePresets";
import { resumeAllVoiceContexts } from "../utils/webAudioVoice";

interface VoiceChangerPanelProps {
  sourceType: "youtube" | "local";
  localVideoTitle?: string;
  settings: VoiceSettings;
  canDownload: boolean;
  isExporting: boolean;
  onChange: (next: VoiceSettings) => void;
  onUploadVoiceVideo: (file: File) => void;
  onDownloadMp4: () => void;
}

export function VoiceChangerPanel({
  sourceType,
  localVideoTitle,
  settings,
  canDownload,
  isExporting,
  onChange,
  onUploadVoiceVideo,
  onDownloadMp4,
}: VoiceChangerPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isYoutube = sourceType === "youtube";

  const updateField = <K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]) => {
    resumeAllVoiceContexts();
    onChange({
      ...settings,
      presetId: "custom",
      [key]: value,
    });
  };

  return (
    <div className="space-y-4 pb-6">
      {/* Direct Video Upload & Download Strip */}
      <div className="p-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-2.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUploadVoiceVideo(file);
            e.target.value = "";
          }}
        />

        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 truncate">
          {localVideoTitle ? localVideoTitle : "No video uploaded"}
        </span>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 px-3 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{localVideoTitle ? "Change Video" : "Upload Video"}</span>
          </button>

          {localVideoTitle && canDownload && (
            <button
              type="button"
              onClick={onDownloadMp4}
              disabled={isExporting}
              className="h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 cursor-pointer hover:opacity-90 transition-opacity"
            >
              {isExporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>Download</span>
            </button>
          )}
        </div>
      </div>

      {/* Voice Style Presets */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Voice Style
          </span>
          {settings.presetId !== "original" && (
            <button
              type="button"
              onClick={() => {
                resumeAllVoiceContexts();
                onChange({ ...DEFAULT_VOICE_SETTINGS });
              }}
              className="text-xs text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {VOICE_PRESETS.map((preset) => {
            const active = settings.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  resumeAllVoiceContexts();
                  onChange({ ...preset.settings });
                }}
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

      {/* Manual Fine-Tuning Controls */}
      <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-900 dark:text-neutral-100">
            Manual Controls
          </span>
          {settings.presetId === "custom" && (
            <span className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400">
              Custom
            </span>
          )}
        </div>

        {/* Speed */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-300">Speed</span>
            <span className="font-mono-tabular text-neutral-950 dark:text-white">
              {isYoutube
                ? `${getEffectivePlaybackSpeed("youtube", settings.speed)}x`
                : `${settings.speed.toFixed(2)}x`}
            </span>
          </div>
          <input
            type="range"
            min={0.75}
            max={1.4}
            step={isYoutube ? 0.25 : 0.01}
            value={settings.speed}
            onChange={(e) => updateField("speed", parseFloat(e.target.value))}
            aria-label="Voice speed"
            className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
          />
        </div>

        {/* Pitch, Tone, Echo, Robot */}
        <div className={`space-y-4 ${isYoutube ? "opacity-45" : ""}`}>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Pitch</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.pitchSemitones > 0 ? `+${settings.pitchSemitones}` : settings.pitchSemitones} st
              </span>
            </div>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              disabled={isYoutube}
              value={settings.pitchSemitones}
              onChange={(e) => updateField("pitchSemitones", parseFloat(e.target.value))}
              aria-label="Voice pitch semitones"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer disabled:cursor-not-allowed"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Tone (Bass / Bright)</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.tone > 0 ? `+${settings.tone}` : settings.tone}
              </span>
            </div>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              disabled={isYoutube}
              value={settings.tone}
              onChange={(e) => updateField("tone", parseInt(e.target.value, 10))}
              aria-label="Voice tone"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer disabled:cursor-not-allowed"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Echo</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.echo}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              disabled={isYoutube}
              value={settings.echo}
              onChange={(e) => updateField("echo", parseInt(e.target.value, 10))}
              aria-label="Voice echo"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer disabled:cursor-not-allowed"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">Robot</span>
              <span className="font-mono-tabular text-neutral-950 dark:text-white">
                {settings.robot}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              disabled={isYoutube}
              value={settings.robot}
              onChange={(e) => updateField("robot", parseInt(e.target.value, 10))}
              aria-label="Robot modulation"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer disabled:cursor-not-allowed"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
