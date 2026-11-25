import { Loader2 } from "lucide-react";
import type {
  SceneSelection,
  SubtitleGenerationProgress,
  TranslationTone,
} from "../types";

const TONE_OPTIONS: { id: TranslationTone; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "formal", label: "Polite" },
  { id: "dramatic", label: "Drama" },
  { id: "literal", label: "Literal" },
];

export interface PreGenerateBarProps {
  scenes: SceneSelection[];
  isProcessing: boolean;
  generationProgress?: SubtitleGenerationProgress | null;
  translationTone: TranslationTone;
  onChangeTranslationTone: (tone: TranslationTone) => void;
  onGenerate: () => void;
  regeneratingClipId?: string | null;
}

export function PreGenerateBar({
  scenes,
  isProcessing,
  generationProgress = null,
  translationTone,
  onChangeTranslationTone,
  onGenerate,
  regeneratingClipId = null,
}: PreGenerateBarProps) {
  const totalSelectedSec = scenes.reduce(
    (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
    0
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#d2dcf0] dark:border-[#21284c]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-mono-tabular text-[#4d597d] dark:text-[#919ec4] whitespace-nowrap">
          {scenes.length} {scenes.length === 1 ? "clip" : "clips"} ·{" "}
          {`${Math.round(totalSelectedSec * 10) / 10}s`}
        </span>

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
                disabled={isProcessing || Boolean(regeneratingClipId)}
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
      </div>

      <button
        type="button"
        onClick={onGenerate}
        disabled={scenes.length === 0 || isProcessing || Boolean(regeneratingClipId)}
        className="h-9 px-5 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold flex items-center gap-2 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-xs"
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {generationProgress ? `Generating ${generationProgress.percent}%` : "Generating..."}
            </span>
          </>
        ) : (
          <span>Generate Subtitles</span>
        )}
      </button>
    </div>
  );
}
