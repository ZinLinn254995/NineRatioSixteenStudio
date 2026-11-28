import { useEffect } from "react";
import type {
  SubtitleGenerationConfig,
  SubtitleGenerationProgress,
} from "../types";
import { SubtitleGeneratePanel } from "./SubtitleGeneratePanel";

interface GenerateSubtitlesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  config: SubtitleGenerationConfig;
  hasExistingSubtitles: boolean;
  existingSubtitleCount: number;
  clipCount: number;
  totalDurationSec: number;
  canGenerate: boolean;
  missingMediaReason?: string | null;
  isGenerating: boolean;
  generationProgress?: SubtitleGenerationProgress | null;
  processError?: string | null;
  onChangeConfig: (next: SubtitleGenerationConfig) => void;
  onStartGenerate: (config: SubtitleGenerationConfig) => void;
  onCancelGenerate?: () => void;
}

export function GenerateSubtitlesDialog({
  isOpen,
  onClose,
  config,
  hasExistingSubtitles,
  existingSubtitleCount,
  clipCount,
  totalDurationSec,
  canGenerate,
  missingMediaReason,
  isGenerating,
  generationProgress = null,
  processError = null,
  onChangeConfig,
  onStartGenerate,
  onCancelGenerate,
}: GenerateSubtitlesDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#060918]/65 backdrop-blur-xs p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generate Subtitle Settings"
        className="w-full h-[100dvh] sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-xl border-0 sm:border sm:border-[#d2dcf0] dark:sm:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-2xl overflow-y-auto overscroll-contain flex flex-col"
      >
        <SubtitleGeneratePanel
          config={config}
          hasExistingSubtitles={hasExistingSubtitles}
          existingSubtitleCount={existingSubtitleCount}
          clipCount={clipCount}
          totalDurationSec={totalDurationSec}
          canGenerate={canGenerate}
          missingMediaReason={missingMediaReason}
          isGenerating={isGenerating}
          generationProgress={generationProgress}
          processError={processError}
          onChangeConfig={onChangeConfig}
          onStartGenerate={onStartGenerate}
          onCancelGenerate={onCancelGenerate}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
