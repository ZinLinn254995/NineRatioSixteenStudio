import { useRef, useState } from "react";
import { Film, Upload } from "lucide-react";

interface EmptyStudioUploadProps {
  onUploadVideo: (file: File) => void;
}

export function EmptyStudioUpload({ onUploadVideo }: EmptyStudioUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFiles = (file: File | null | undefined) => {
    if (!file) return;
    if (
      file.type.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name)
    ) {
      onUploadVideo(file);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDragOver) setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget === e.target) setIsDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        handleFiles(e.dataTransfer?.files?.[0]);
      }}
      className="flex-1 min-h-0 w-full flex items-center justify-center p-6 bg-[#eef2fa] dark:bg-[#050712] overflow-y-auto"
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div
        className={`w-full max-w-sm rounded-xl border border-dashed px-6 py-9 flex flex-col items-center text-center transition-colors ${
          isDragOver
            ? "border-teal-600 dark:border-teal-400 bg-teal-50/70 dark:bg-teal-950/30"
            : "border-[#bcc9e6] dark:border-[#242d56] bg-white/85 dark:bg-[#0d1022]/90"
        }`}
      >
        <div className="w-12 h-12 rounded-xl border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] flex items-center justify-center text-teal-700 dark:text-teal-400 mb-4">
          <Film className="w-5 h-5" />
        </div>

        <h2 className="font-display text-base font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
          No video yet
        </h2>

        <p className="mt-1.5 text-xs leading-relaxed text-[#4d597d] dark:text-[#919ec4] max-w-[260px]">
          Upload a video from your device to cut clips and edit video &amp; audio in 9:16 Studio.
        </p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-5 h-10 px-5 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold inline-flex items-center justify-center gap-2 shadow-sm cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/60 dark:focus-visible:ring-teal-400/60"
        >
          <Upload className="w-4 h-4 shrink-0" />
          <span>Upload Video</span>
        </button>

        <p className="mt-3 text-[11px] text-[#64748b] dark:text-[#7c89b0]">
          MP4, MOV, WebM · or drag and drop here
        </p>
      </div>
    </div>
  );
}
