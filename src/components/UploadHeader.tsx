import { FileAudio, Loader2, X } from "lucide-react";

export interface UploadHeaderProps {
  title: string;
  durationSec: number;
  onClearVideo: () => void;
  onExportAudio?: () => void;
  isExportingAudio?: boolean;
}

export function UploadHeader({
  title,
  durationSec,
  onClearVideo,
  onExportAudio,
  isExportingAudio = false,
}: UploadHeaderProps) {
  return (
    <div className="pb-3 border-b border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
          {title}
        </p>
        <p className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] mt-0.5">
          Local Source · {Math.round(durationSec)}s
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {onExportAudio && (
          <button
            type="button"
            disabled={isExportingAudio}
            onClick={onExportAudio}
            title="Export audio track only (.mp3) for external AI transcription"
            className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-teal-50 hover:border-teal-600/50 dark:hover:bg-teal-950/40 dark:hover:border-teal-400/50 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors shrink-0 text-[#0c1026] dark:text-[#f3f5fc] disabled:opacity-50 disabled:cursor-wait"
          >
            {isExportingAudio ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-700 dark:text-teal-400" />
            ) : (
              <FileAudio className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400" />
            )}
            <span>{isExportingAudio ? "Exporting..." : "Export Audio"}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onClearVideo}
          className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/35 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors shrink-0 text-[#0c1026] dark:text-[#f3f5fc]"
        >
          <X className="w-3.5 h-3.5" />
          <span>Clear Video</span>
        </button>
      </div>
    </div>
  );
}

