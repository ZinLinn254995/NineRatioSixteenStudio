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
        <div className="w-full aspect-video rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 flex flex-col items-center justify-center text-center p-6 gap-3">
          <div className="w-10 h-10 rounded-full bg-neutral-200/80 dark:bg-neutral-800 flex items-center justify-center text-neutral-700 dark:text-neutral-200">
            <Upload className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-sm">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              16:9 Video Editor
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
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
            className="mt-1 h-9 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap cursor-pointer hover:opacity-90 transition-opacity"
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
      <div className="px-3.5 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {media.title}
          </p>
          <p className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400">
            Uploaded Video · {Math.round(media.durationSec)}s
          </p>
        </div>
        <button
          type="button"
          onClick={onClearVideo}
          className="h-8 px-3 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors shrink-0 text-neutral-800 dark:text-neutral-200"
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
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
            {scenes.length} {scenes.length === 1 ? "scene" : "scenes"} ·{" "}
            {`${Math.round(totalSelectedSec * 10) / 10}s`}
          </span>

          <div
            role="group"
            aria-label="Translation tone"
            className="inline-flex items-center p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800"
          >
            {TONE_OPTIONS.map((opt) => {
              const active = translationTone === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChangeTranslationTone(opt.id)}
                  disabled={isProcessing}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 ${
                    active
                      ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                      : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white"
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
          className="h-9 px-5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity cursor-pointer"
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
