import { AudioLines, Layers, RotateCcw, Shield } from "lucide-react";
import type { VoiceSettings } from "../types";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_PRESETS,
} from "../utils/voicePresets";
import { resumeAllVoiceContexts } from "../utils/webAudioVoice";

interface VoiceChangerPanelProps {
  settings: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}

export function VoiceChangerPanel({
  settings,
  onChange,
}: VoiceChangerPanelProps) {

  const updateField = <K extends keyof VoiceSettings>(
    key: K,
    value: VoiceSettings[K],
    markCustom = true
  ) => {
    resumeAllVoiceContexts();
    onChange({
      ...settings,
      ...(markCustom ? { presetId: "custom" } : {}),
      [key]: value,
    });
  };

  const isVoiceModified =
    settings.presetId !== DEFAULT_VOICE_SETTINGS.presetId ||
    Math.abs(settings.pitchSemitones - DEFAULT_VOICE_SETTINGS.pitchSemitones) > 0.01 ||
    Math.abs(settings.speed - DEFAULT_VOICE_SETTINGS.speed) > 0.01 ||
    settings.tone !== DEFAULT_VOICE_SETTINGS.tone ||
    settings.echo !== DEFAULT_VOICE_SETTINGS.echo ||
    settings.robot !== DEFAULT_VOICE_SETTINGS.robot ||
    settings.adversarialNoise !== DEFAULT_VOICE_SETTINGS.adversarialNoise ||
    settings.adversarialStrength !== DEFAULT_VOICE_SETTINGS.adversarialStrength ||
    settings.spectralPhaseShift !== DEFAULT_VOICE_SETTINGS.spectralPhaseShift ||
    settings.spectralPhaseStrength !== DEFAULT_VOICE_SETTINGS.spectralPhaseStrength ||
    settings.vocalIsolation !== DEFAULT_VOICE_SETTINGS.vocalIsolation ||
    settings.vocalIsolationStrength !== DEFAULT_VOICE_SETTINGS.vocalIsolationStrength;

  return (
    <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c]">
      {/* Voice Style Presets */}
      <div className="pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
            Voice Presets
          </span>
          {isVoiceModified && (
            <button
              type="button"
              onClick={() => {
                resumeAllVoiceContexts();
                onChange({ ...DEFAULT_VOICE_SETTINGS });
              }}
              className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-teal-700 dark:hover:text-teal-400 flex items-center gap-1 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Voice</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {VOICE_PRESETS.map((preset) => {
            const active = settings.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  resumeAllVoiceContexts();
                  onChange({
                    ...preset.settings,
                    adversarialNoise: settings.adversarialNoise,
                    adversarialStrength: settings.adversarialStrength,
                    spectralPhaseShift: settings.spectralPhaseShift,
                    spectralPhaseStrength: settings.spectralPhaseStrength,
                    vocalIsolation: settings.vocalIsolation,
                    vocalIsolationStrength: settings.vocalIsolationStrength,
                  });
                }}
                className={`h-7 px-2 rounded-sm text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#060918] dark:border-teal-400 font-semibold"
                    : "bg-[#f3f5fc] dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] border-[#d2dcf0] dark:border-[#21284c] hover:border-teal-600/50 dark:hover:border-teal-400/50"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Manual Fine-Tuning Controls */}
      <div className="py-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
            Tuning
          </span>
          {settings.presetId === "custom" && (
            <span className="text-[10px] font-mono-tabular font-semibold text-teal-700 dark:text-teal-400">
              Custom
            </span>
          )}
        </div>

        {/* Speed */}
        {(() => {
          const safeSpeed =
            typeof settings.speed === "number" &&
            Number.isFinite(settings.speed) &&
            settings.speed > 0
              ? settings.speed
              : DEFAULT_VOICE_SETTINGS.speed;
          return (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#4d597d] dark:text-[#919ec4]">Voice Speed</span>
                <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                  {`${safeSpeed.toFixed(2)}x`}
                </span>
              </div>
              <input
                type="range"
                min={0.75}
                max={1.4}
                step={0.01}
                value={Math.max(0.75, Math.min(1.4, safeSpeed))}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  if (Number.isFinite(next)) {
                    updateField("speed", next);
                  }
                }}
                aria-label="Voice speed"
                className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
              />
            </div>
          );
        })()}

        {/* Pitch, Tone, Echo, Robot */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#4d597d] dark:text-[#919ec4]">Pitch</span>
              <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                {settings.pitchSemitones > 0 ? `+${settings.pitchSemitones}` : settings.pitchSemitones} st
              </span>
            </div>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={settings.pitchSemitones}
              onChange={(e) => updateField("pitchSemitones", parseFloat(e.target.value))}
              aria-label="Voice pitch semitones"
              className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#4d597d] dark:text-[#919ec4]">Tone</span>
              <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                {settings.tone > 0 ? `+${settings.tone}` : settings.tone}
              </span>
            </div>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={settings.tone}
              onChange={(e) => updateField("tone", parseInt(e.target.value, 10))}
              aria-label="Voice tone"
              className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#4d597d] dark:text-[#919ec4]">Echo</span>
              <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                {settings.echo}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={settings.echo}
              onChange={(e) => updateField("echo", parseInt(e.target.value, 10))}
              aria-label="Voice echo"
              className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#4d597d] dark:text-[#919ec4]">Robot</span>
              <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                {settings.robot}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={settings.robot}
              onChange={(e) => updateField("robot", parseInt(e.target.value, 10))}
              aria-label="Robot modulation"
              className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Audio Protection & Separation Controls */}
      <div className="pt-3 divide-y divide-[#d2dcf0] dark:divide-[#21284c]">
        {/* 1. Vocal Isolation & Background Suppression */}
        <div className="space-y-2 pb-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                <Layers className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>Vocal Isolation</span>
              </div>
              <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                Isolate center vocals and reduce stereo music & noise.
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={settings.vocalIsolation}
              aria-label="Toggle Vocal Isolation"
              onClick={() =>
                updateField("vocalIsolation", !settings.vocalIsolation, false)
              }
              className={`h-6 px-2.5 rounded-sm text-[11px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                settings.vocalIsolation
                  ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#060918] dark:border-teal-400"
                  : "bg-[#e7ecf8] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] border-[#d2dcf0] dark:border-[#21284c] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
              }`}
            >
              {settings.vocalIsolation ? "ON" : "OFF"}
            </button>
          </div>

          {settings.vocalIsolation && (
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#4d597d] dark:text-[#919ec4]">Strength</span>
                <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                  {settings.vocalIsolationStrength}%
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={settings.vocalIsolationStrength}
                onChange={(e) =>
                  updateField("vocalIsolationStrength", parseInt(e.target.value, 10), false)
                }
                aria-label="Vocal isolation strength"
                className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
              />
            </div>
          )}
        </div>

        {/* 2. Spectral Phase Shifting */}
        <div className="space-y-2 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                <AudioLines className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>Spectral Phase Shift</span>
              </div>
              <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                Cascaded all-pass dispersion while keeping speech natural.
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={settings.spectralPhaseShift}
              aria-label="Toggle Spectral Phase Shifting"
              onClick={() =>
                updateField("spectralPhaseShift", !settings.spectralPhaseShift, false)
              }
              className={`h-6 px-2.5 rounded-sm text-[11px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                settings.spectralPhaseShift
                  ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#060918] dark:border-teal-400"
                  : "bg-[#e7ecf8] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] border-[#d2dcf0] dark:border-[#21284c] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
              }`}
            >
              {settings.spectralPhaseShift ? "ON" : "OFF"}
            </button>
          </div>

          {settings.spectralPhaseShift && (
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#4d597d] dark:text-[#919ec4]">Phase Dispersion</span>
                <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                  {settings.spectralPhaseStrength}%
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={settings.spectralPhaseStrength}
                onChange={(e) =>
                  updateField("spectralPhaseStrength", parseInt(e.target.value, 10), false)
                }
                aria-label="Spectral phase dispersion strength"
                className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
              />
            </div>
          )}
        </div>

        {/* 3. Audio Adversarial Perturbations */}
        <div className="space-y-2 pt-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                <Shield className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                <span>Audio Perturbations</span>
              </div>
              <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] mt-0.5 leading-snug">
                Micro-phase & psychoacoustic perturbations for preview and MP4.
              </p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={settings.adversarialNoise}
              aria-label="Toggle Audio Adversarial Perturbations"
              onClick={() =>
                updateField("adversarialNoise", !settings.adversarialNoise, false)
              }
              className={`h-6 px-2.5 rounded-sm text-[11px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                settings.adversarialNoise
                  ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#060918] dark:border-teal-400"
                  : "bg-[#e7ecf8] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] border-[#d2dcf0] dark:border-[#21284c] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
              }`}
            >
              {settings.adversarialNoise ? "ON" : "OFF"}
            </button>
          </div>

          {settings.adversarialNoise && (
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#4d597d] dark:text-[#919ec4]">Strength (ε)</span>
                <span className="font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
                  {settings.adversarialStrength}%
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={settings.adversarialStrength}
                onChange={(e) =>
                  updateField("adversarialStrength", parseInt(e.target.value, 10), false)
                }
                aria-label="Audio adversarial perturbation strength"
                className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
