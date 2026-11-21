import { useRef } from "react";
import { Loader2, Upload, X } from "lucide-react";
import type { ActiveMediaSource, SceneSelection, TranslationTone } from "../types";
import { LocalVideoTimelineEditor } from "./LocalVideoTimelineEditor";

const TONE_OPTIONS: { id: TranslationTone; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "formal", label: "Polite" },
  { id: "dramatic", label: "Drama" },
  { id: "literal", label: "Literal" },
];

interface ScenePickerProps {
  media?: ActiveMediaSource | null;
  scenes: SceneSelection[];
  isProcessing: boolean;
  translationTone: TranslationTone;
  onChangeTranslationTone: (tone: TranslationTone) => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes?: (scenes: SceneSelection[]) => void;
  onGenerate: () => void;
  onDetectedDuration?: (dur: number) => void;
  onUploadVideo: (file: File) => void;
  onClearVideo: () => void;
  isTabActive?: boolean;
}

export function ScenePicker({
  media,
  scenes,
  isProcessing,
  translationTone,
  onChangeTranslationTone,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onGenerate,
  onDetectedDuration,
  onUploadVideo,
  onClearVideo,
  isTabActive = true,
}: ScenePickerProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  if (!media || media.sourceType !== "local") {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <div className="w-full aspect-video rounded-lg border border-dashed border-[#c9d1dc] dark:border-[#2e3644] bg-[#eceff3]/60 dark:bg-[#090b0e] flex flex-col items-center justify-center text-center p-6 gap-3">
          <div className="w-11 h-11 rounded-lg bg-teal-50 dark:bg-teal-950/60 border border-teal-200/80 dark:border-teal-500/30 flex items-center justify-center text-teal-700 dark:text-teal-400">
            <Upload className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-sm">
            <p className="font-display text-sm font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
              16:9 Scene Editor
            </p>
            <p className="text-xs text-[#525d6d] dark:text-[#8b95a5] leading-relaxed">
              Upload a local video to preview, trim clips on the timeline, and generate subtitles.
            </p>
          </div>

          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadVideo(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            className="mt-1 h-9 px-4 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#061412] text-xs font-semibold flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors shadow-xs"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Video</span>
          </button>
        </div>
      </div>
    );
  }

  const totalSelectedSec = scenes.reduce(
    (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
    0
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="pb-3 border-b border-[#dde2e9] dark:border-[#242a34] flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold text-[#0e1217] dark:text-[#f1f3f5] truncate">
            {media.title}
          </p>
          <p className="text-[11px] font-mono-tabular text-[#525d6d] dark:text-[#8b95a5] mt-0.5">
            Local Source · {Math.round(media.durationSec)}s
          </p>
        </div>
        <button
          type="button"
          onClick={onClearVideo}
          className="h-8 px-3 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/35 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors shrink-0 text-[#0e1217] dark:text-[#f1f3f5]"
        >
          <X className="w-3.5 h-3.5" />
          <span>Clear Video</span>
        </button>
      </div>

      <LocalVideoTimelineEditor
        media={media}
        scenes={scenes}
        onUpdateScene={onUpdateScene}
        onRemoveScene={onRemoveScene}
        onReplaceScenes={onReplaceScenes}
        onDetectedDuration={onDetectedDuration}
        isTabActive={isTabActive}
      />

      {/* Translation Tone & Generate Subtitles Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#dde2e9] dark:border-[#242a34]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-mono-tabular text-[#525d6d] dark:text-[#8b95a5] whitespace-nowrap">
            {scenes.length} {scenes.length === 1 ? "scene" : "scenes"} ·{" "}
            {`${Math.round(totalSelectedSec * 10) / 10}s`}
          </span>

          <div
            role="group"
            aria-label="Translation tone"
            className="inline-flex items-center p-0.5 rounded-md bg-[#eceff3] dark:bg-[#181c23] border border-[#dde2e9] dark:border-[#242a34]"
          >
            {TONE_OPTIONS.map((opt) => {
              const active = translationTone === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChangeTranslationTone(opt.id)}
                  disabled={isProcessing}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 ${
                    active
                      ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] font-semibold"
                      : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={onGenerate}
          disabled={scenes.length === 0 || isProcessing}
          className="h-9 px-5 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#061412] text-xs font-semibold flex items-center gap-2 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-xs"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Generating...</span>
            </>
          ) : (
            <span>Generate Subtitles</span>
          )}
        </button>
      </div>
    </div>
  );
}
