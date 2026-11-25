import { useRef } from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";
import type {
  ActiveMediaSource,
  SceneSelection,
  SubtitleGenerationProgress,
  TranslationTone,
} from "../types";
import { LocalVideoTimelineEditor } from "./LocalVideoTimelineEditor";
import { PreGenerateBar } from "./PreGenerateBar";
import { UploadHeader } from "./UploadHeader";

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
  generationProgress?: SubtitleGenerationProgress | null;
  clipSubtitleCounts?: Record<string, number>;
  regeneratingClipId?: string | null;
  regeneratingClipPercent?: number | null;
  translationTone: TranslationTone;
  onChangeTranslationTone: (tone: TranslationTone) => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes?: (scenes: SceneSelection[]) => void;
  onGenerate: () => void;
  onGenerateSingleClip?: (sceneId: string) => void;
  onDetectedDuration?: (dur: number) => void;
  onUploadVideo: (file: File) => void;
  onClearVideo: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  isTabActive?: boolean;
  mobileStageTarget?: HTMLElement | null;
}

export function ScenePicker({
  media,
  scenes,
  isProcessing,
  generationProgress = null,
  clipSubtitleCounts,
  regeneratingClipId = null,
  regeneratingClipPercent = null,
  translationTone,
  onChangeTranslationTone,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onGenerate,
  onGenerateSingleClip,
  onDetectedDuration,
  onUploadVideo,
  onClearVideo,
  onUndo,
  canUndo = false,
  isTabActive = true,
  mobileStageTarget = null,
}: ScenePickerProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  if (!media || media.sourceType !== "local") {
    const uploadDropzoneNode = (
      <button
        type="button"
        onClick={() => uploadInputRef.current?.click()}
        className={`group w-full rounded-lg border border-dashed border-[#bcc9e6] dark:border-[#2e3644] bg-[#e7ecf8]/75 dark:bg-[#0d1015] hover:border-teal-700/60 dark:hover:border-teal-400/50 hover:bg-[#e6eaf0]/85 dark:hover:bg-[#12161d] flex flex-col items-center justify-center gap-1.5 text-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
          mobileStageTarget ? "h-full p-3" : "max-w-xl mx-auto aspect-video p-6"
        }`}
      >
        <Upload className="w-5 h-5 text-teal-700 dark:text-teal-400 transition-transform duration-150 group-hover:-translate-y-0.5 shrink-0" />
        <span className="text-xs font-medium text-[#4d597d] dark:text-[#919ec4] group-hover:text-[#0c1026] dark:group-hover:text-[#f3f5fc] transition-colors">
          Upload video
        </span>
      </button>
    );

    return (
      <div className="flex flex-col gap-4 pb-6">
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
        {mobileStageTarget ? (
          <>
            {createPortal(uploadDropzoneNode, mobileStageTarget)}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div
                role="group"
                aria-label="Translation tone"
                className="inline-flex items-center p-0.5 rounded-md bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]"
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
                          ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918] font-semibold"
                          : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                disabled
                className="h-9 px-4 rounded-md bg-teal-700 dark:bg-teal-400 text-white dark:text-[#060918] text-xs font-semibold whitespace-nowrap opacity-40 cursor-not-allowed"
              >
                Generate Subtitles
              </button>
            </div>
          </>
        ) : (
          uploadDropzoneNode
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <UploadHeader
        title={media.title}
        durationSec={media.durationSec}
        onClearVideo={onClearVideo}
      />

      <LocalVideoTimelineEditor
        media={media}
        scenes={scenes}
        clipSubtitleCounts={clipSubtitleCounts}
        regeneratingClipId={regeneratingClipId}
        regeneratingClipPercent={regeneratingClipPercent}
        isProcessingAll={isProcessing}
        onGenerateSingleClip={onGenerateSingleClip}
        onUpdateScene={onUpdateScene}
        onRemoveScene={onRemoveScene}
        onReplaceScenes={onReplaceScenes}
        onDetectedDuration={onDetectedDuration}
        onUndo={onUndo}
        canUndo={canUndo}
        isTabActive={isTabActive}
        mobileStageTarget={mobileStageTarget}
      />

      {/* Translation Tone & Generate Subtitles Action Bar */}
      <PreGenerateBar
        scenes={scenes}
        isProcessing={isProcessing}
        generationProgress={generationProgress}
        translationTone={translationTone}
        onChangeTranslationTone={onChangeTranslationTone}
        onGenerate={onGenerate}
        regeneratingClipId={regeneratingClipId}
      />
    </div>
  );
}
