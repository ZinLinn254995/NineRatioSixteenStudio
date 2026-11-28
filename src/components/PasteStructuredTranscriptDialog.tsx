import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardPaste, Copy, FileText, Trash2, X } from "lucide-react";
import type { SceneSelection, SpeakingScene } from "../types";
import {
  buildSubtitlesFromStructuredTranscript,
  type StructuredTranscriptImportResult,
  type TranscriptTimingCoordinateMode,
} from "../utils/pasteTranscriptSync";

interface PasteStructuredTranscriptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedScenes: SceneSelection[];
  scenes?: SpeakingScene[];
  totalDurationSec: number;
  sourceDurationSec?: number;
  existingSubtitleCount: number;
  onApply: (result: StructuredTranscriptImportResult, mode: "replace" | "append") => void;
}

const SAMPLE_TRANSCRIPT = `[01] 00:01 – 00:02
Phonetic: mâi yàa
Thai:     ไม่ อย่า
Burmese:  မလုပ်နဲ့၊ တားလိုက်။
Words:    mâi (မ/မဟုတ်) · yàa (မလုပ်နဲ့/တားသည်)
[02] 00:14 – 00:16
Phonetic: mâi yàa
Thai:     ไม่ อย่า
Burmese:  မလုပ်နဲ့၊ မလာနဲ့။
Words:    mâi (မ) · yàa (မလုပ်နဲ့)`;

function formatClockTime(sec: number): string {
  const safe = Math.max(0, Math.round(sec * 10) / 10);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const wholeSecs = Math.floor(rem);
  const tenths = Math.round((rem - wholeSecs) * 10);
  const base = `${String(mins).padStart(2, "0")}:${String(wholeSecs).padStart(2, "0")}`;
  return tenths > 0 && tenths < 10 ? `${base}.${tenths}` : base;
}

export function PasteStructuredTranscriptDialog({
  isOpen,
  onClose,
  selectedScenes,
  scenes,
  totalDurationSec,
  sourceDurationSec,
  existingSubtitleCount,
  onApply,
}: PasteStructuredTranscriptDialogProps) {
  const [rawText, setRawText] = useState("");
  const [applyMode, setApplyMode] = useState<"replace" | "append">("replace");
  const [timingMode, setTimingMode] = useState<TranscriptTimingCoordinateMode>("auto");
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const [copiedFormat, setCopiedFormat] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setClipboardHint(null);
    setCopiedFormat(false);
    setTimingMode("auto");
    setApplyMode(existingSubtitleCount > 0 ? "replace" : "append");
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 40);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, existingSubtitleCount, onClose]);

  const parsedResult = useMemo(
    () =>
      buildSubtitlesFromStructuredTranscript(rawText, selectedScenes, totalDurationSec, {
        timingMode,
        scenes,
        sourceDurationSec,
      }),
    [rawText, selectedScenes, scenes, totalDurationSec, sourceDurationSec, timingMode]
  );

  const effectiveTimelineDur =
    parsedResult.clipTotalDurationSec > 0 ? parsedResult.clipTotalDurationSec : totalDurationSec;

  const exceedsVideoEnd =
    effectiveTimelineDur > 0 &&
    parsedResult.subtitles.length > 0 &&
    parsedResult.spanEndSec > effectiveTimelineDur + 0.25;

  const clipCount = (scenes && scenes.length > 0 ? scenes.length : selectedScenes.length) || 1;

  const detectedFields = useMemo(() => {
    const labels: string[] = [];
    if (parsedResult.hasPhonetic) labels.push("Phonetic");
    if (parsedResult.hasThai) labels.push("Thai");
    if (parsedResult.hasBurmese) labels.push("Burmese");
    if (parsedResult.hasWords) labels.push("Words");
    return labels;
  }, [parsedResult]);

  if (!isOpen) return null;

  const handlePasteClipboard = async () => {
    setClipboardHint(null);
    try {
      if (!navigator.clipboard?.readText) {
        setClipboardHint("Press Ctrl+V / Cmd+V or long-press inside the box to paste.");
        textareaRef.current?.focus();
        return;
      }
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        setClipboardHint("Clipboard is empty.");
        return;
      }
      setRawText(clip);
    } catch {
      setClipboardHint("Clipboard access blocked — paste directly inside the box below.");
      textareaRef.current?.focus();
    }
  };

  const handleCopyFormat = async () => {
    setClipboardHint(null);
    try {
      await navigator.clipboard.writeText(SAMPLE_TRANSCRIPT);
      setCopiedFormat(true);
      window.setTimeout(() => setCopiedFormat(false), 1800);
    } catch {
      setClipboardHint("Could not copy automatically. Use Sample to insert the format.");
    }
  };

  const handleSubmit = () => {
    if (parsedResult.subtitles.length === 0) return;
    const freshResult = buildSubtitlesFromStructuredTranscript(
      rawText,
      selectedScenes,
      totalDurationSec,
      {
        timingMode,
        scenes,
        sourceDurationSec,
      }
    );
    onApply(freshResult, existingSubtitleCount > 0 ? applyMode : "replace");
  };

  const subCount = parsedResult.subtitles.length;
  const applicableSubCount = parsedResult.subtitles.filter(
    (s) => effectiveTimelineDur <= 0 || s.startTime < effectiveTimelineDur - 0.05
  ).length;
  const effectiveApplyCount = applicableSubCount > 0 ? applicableSubCount : subCount;
  const applyButtonLabel =
    subCount === 0
      ? "Add Subtitles"
      : existingSubtitleCount > 0 && applyMode === "replace"
        ? `Replace with ${effectiveApplyCount} ${effectiveApplyCount === 1 ? "Subtitle" : "Subtitles"}`
        : `Add ${effectiveApplyCount} ${effectiveApplyCount === 1 ? "Subtitle" : "Subtitles"}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-structured-transcript-title"
      className="fixed inset-0 z-50 w-full h-[100dvh] bg-white dark:bg-[#0d1022] flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 sm:px-6 py-3.5 border-b border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg border border-teal-600/30 dark:border-teal-400/30 bg-teal-50 dark:bg-teal-950/50 flex items-center justify-center text-teal-700 dark:text-teal-300 shrink-0">
            <ClipboardPaste className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2
              id="paste-structured-transcript-title"
              className="font-display text-sm sm:text-base font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate"
            >
              Paste Subtitle Transcript
            </h2>
            <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] truncate">
              Paste timestamped blocks with Phonetic, Thai, Burmese, and Words.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="w-10 h-10 rounded-lg border border-transparent hover:border-[#d2dcf0] dark:hover:border-[#21284c] hover:bg-[#f3f5fc] dark:hover:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center cursor-pointer transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-4">
          {/* Toolbar row */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4]">
              Transcript Input
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handlePasteClipboard()}
                className="h-9 px-3 rounded-md border border-teal-600/40 dark:border-teal-400/40 bg-teal-50/70 dark:bg-teal-950/40 hover:bg-teal-100/80 dark:hover:bg-teal-950/70 text-teal-800 dark:text-teal-300 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                <span>Paste</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setClipboardHint(null);
                  setRawText(SAMPLE_TRANSCRIPT);
                  textareaRef.current?.focus();
                }}
                className="h-9 px-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Sample</span>
              </button>

              <button
                type="button"
                onClick={() => void handleCopyFormat()}
                className="h-9 px-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                {copiedFormat ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Format</span>
                  </>
                )}
              </button>

              {rawText.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setRawText("");
                    setClipboardHint(null);
                    textareaRef.current?.focus();
                  }}
                  className="h-9 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-red-400/60 hover:text-red-600 dark:hover:text-red-400 text-[#4d597d] dark:text-[#919ec4] text-xs font-medium inline-flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              )}
            </div>
          </div>

          {clipboardHint && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-500/30 rounded-md px-3 py-2">
              {clipboardHint}
            </p>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            rows={12}
            placeholder={SAMPLE_TRANSCRIPT}
            aria-label="Structured subtitle transcript"
            className={`w-full rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8fafe] dark:bg-[#070814] px-3.5 py-3 text-xs sm:text-[13px] font-mono leading-relaxed text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7a87ad]/70 dark:placeholder:text-[#5c6890] focus:outline-none focus:border-teal-600 dark:focus:border-teal-400 resize-y ${
              rawText.trim().length === 0 ? "flex-1 min-h-[260px]" : "min-h-[220px] sm:min-h-[260px]"
            }`}
          />

          {/* Timing Coordinate Selector when clips were edited / trimmed / split / reordered */}
          {rawText.trim().length > 0 && parsedResult.canToggleTimingMode && (
            <div className="rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f8fafe] dark:bg-[#090c1a] px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                  Timestamp Match ({clipCount} {clipCount === 1 ? "clip" : "clips"} · {formatClockTime(effectiveTimelineDur)})
                </p>
                <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] leading-snug">
                  {parsedResult.resolvedTimingMode === "timeline"
                    ? "Timeline (Cut): 00:00 matches Clip 1 start on your edited timeline (best for Whisper tab transcripts)."
                    : "Source Video: Timestamps match the original unedited video and map into kept clip ranges."}
                </p>
              </div>
              <div className="inline-flex rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#070814] p-0.5 shrink-0 self-start sm:self-center">
                <button
                  type="button"
                  onClick={() => setTimingMode("timeline")}
                  className={`h-8 px-2.5 rounded-md text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                    parsedResult.resolvedTimingMode === "timeline"
                      ? "bg-white dark:bg-[#1a2142] text-teal-700 dark:text-teal-300 shadow-xs font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Timeline (Cut)
                  {timingMode === "auto" && parsedResult.autoDetectedTimingMode === "timeline" ? " · Auto" : ""}
                </button>
                <button
                  type="button"
                  onClick={() => setTimingMode("source")}
                  className={`h-8 px-2.5 rounded-md text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                    parsedResult.resolvedTimingMode === "source"
                      ? "bg-white dark:bg-[#1a2142] text-teal-700 dark:text-teal-300 shadow-xs font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Source Video
                  {timingMode === "auto" && parsedResult.autoDetectedTimingMode === "source" ? " · Auto" : ""}
                </button>
              </div>
            </div>
          )}

          {/* Live Summary & Warnings */}
          {rawText.trim().length > 0 && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4d597d] dark:text-[#919ec4] border-t border-[#e7ecf8] dark:border-[#1a2142] pt-3">
                <div className="font-mono-tabular flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    {subCount} {subCount === 1 ? "subtitle" : "subtitles"}
                  </span>
                  {subCount > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        {formatClockTime(parsedResult.spanStartSec)} →{" "}
                        {formatClockTime(parsedResult.spanEndSec)}
                      </span>
                    </>
                  )}
                  {detectedFields.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="font-sans text-[#4d597d] dark:text-[#919ec4]">
                        {detectedFields.join(" · ")}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {subCount === 0 && (
                <div className="px-3 py-2.5 rounded-md border border-amber-300/70 dark:border-amber-500/35 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200">
                  {parsedResult.resolvedTimingMode === "source" &&
                  parsedResult.outsideSourceClipsCount > 0 ? (
                    <span>
                      All timestamped lines fell outside your kept clips in Source Video mode.
                      Switch Timestamp Match to <span className="font-semibold">Timeline (Cut)</span>{" "}
                      if your timestamps start at 00:00 for the edited timeline.
                    </span>
                  ) : (
                    <>
                      No subtitle lines detected yet. Check that each block starts with{" "}
                      <span className="font-mono-tabular font-semibold">[01] 00:01 – 00:02</span>{" "}
                      followed by <span className="font-mono">Phonetic:</span>,{" "}
                      <span className="font-mono">Thai:</span>,{" "}
                      <span className="font-mono">Burmese:</span>, or{" "}
                      <span className="font-mono">Words:</span>.
                    </>
                  )}
                </div>
              )}

              {(parsedResult.warnings.length > 0 || exceedsVideoEnd) && (
                <div className="px-3 py-2 rounded-md border border-amber-300/70 dark:border-amber-500/35 bg-amber-50/70 dark:bg-amber-950/30 text-[11px] text-amber-800 dark:text-amber-200 space-y-1">
                  {parsedResult.warnings.map((warn, i) => (
                    <p key={i}>{warn}</p>
                  ))}
                  {exceedsVideoEnd && parsedResult.exceedsTimelineCount === 0 && (
                    <p className="font-mono-tabular">
                      Last subtitle reaches {formatClockTime(parsedResult.spanEndSec)}, past timeline
                      end ({formatClockTime(effectiveTimelineDur)}) and will trim to fit the clip end.
                    </p>
                  )}
                </div>
              )}

              {/* Parsed Preview List */}
              {subCount > 0 && (
                <div className="rounded-lg border border-[#d2dcf0] dark:border-[#21284c] divide-y divide-[#e7ecf8] dark:divide-[#1a2142] max-h-[360px] overflow-y-auto bg-[#fbfcff] dark:bg-[#090c1a]">
                  {parsedResult.subtitles.map((sub, idx) => {
                    const outOfTimelineBounds =
                      effectiveTimelineDur > 0 && sub.startTime >= effectiveTimelineDur - 0.05;
                    return (
                      <div
                        key={sub.id}
                        className={`px-3 py-2.5 space-y-1 ${
                          outOfTimelineBounds ? "opacity-55 bg-amber-50/40 dark:bg-amber-950/20" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-teal-700 dark:text-teal-400">
                              [{String(idx + 1).padStart(2, "0")}]
                            </span>
                            {clipCount > 1 && (
                              <span className="px-1.5 py-0.5 rounded bg-[#e7ecf8] dark:bg-[#1a2142] text-[10px] font-medium text-[#31406b] dark:text-[#b4c1e6]">
                                Clip {sub.sceneIndex + 1}
                              </span>
                            )}
                            {outOfTimelineBounds && (
                              <span className="text-[10px] font-sans font-medium text-amber-700 dark:text-amber-300">
                                Past timeline end
                              </span>
                            )}
                          </div>
                          <span>
                            {formatClockTime(sub.startTime)} – {formatClockTime(sub.endTime)}
                          </span>
                        </div>

                        {sub.thaiPhonetic && (
                          <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] break-words">
                            {sub.thaiPhonetic}
                          </p>
                        )}

                        {sub.thaiScript && sub.thaiScript !== sub.thaiPhonetic && (
                          <p className="text-xs text-[#31406b] dark:text-[#b4c1e6] break-words">
                            {sub.thaiScript}
                          </p>
                        )}

                        {sub.burmese && (
                          <p className="font-myanmar text-xs text-[#1c3db8] dark:text-[#93b5fa] break-words leading-relaxed">
                            {sub.burmese}
                          </p>
                        )}

                        {sub.words.length > 0 && (
                          <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] break-words leading-relaxed">
                            {sub.words
                              .map((w) =>
                                w.burmeseGloss ? `${w.phonetic} (${w.burmeseGloss})` : w.phonetic
                              )
                              .join(" · ")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Replace vs Append option when subtitles already exist */}
          {existingSubtitleCount > 0 && (
            <div className="pt-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-[#4d597d] dark:text-[#919ec4]">
                Existing subtitles ({existingSubtitleCount})
              </span>
              <div className="inline-flex rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#070814] p-0.5">
                <button
                  type="button"
                  onClick={() => setApplyMode("replace")}
                  className={`h-8 px-3 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                    applyMode === "replace"
                      ? "bg-white dark:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] shadow-xs"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => setApplyMode("append")}
                  className={`h-8 px-3 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                    applyMode === "append"
                      ? "bg-white dark:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] shadow-xs"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                  }`}
                >
                  Append
                </button>
              </div>
            </div>
          )}
        </div>

      {/* Footer */}
      <div className="px-4 sm:px-6 py-3.5 border-t border-[#d2dcf0] dark:border-[#21284c] bg-[#f8fafe] dark:bg-[#0a0d1c] flex items-center justify-end gap-2.5 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="h-11 px-4 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#f3f5fc] dark:hover:bg-[#141933] text-xs sm:text-sm font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
        >
          Cancel
        </button>

        <button
          type="button"
          disabled={subCount === 0}
          onClick={handleSubmit}
          className="h-11 px-5 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
        >
          <Check className="w-4 h-4 shrink-0" />
          <span>{applyButtonLabel}</span>
        </button>
      </div>
    </div>
  );
}
