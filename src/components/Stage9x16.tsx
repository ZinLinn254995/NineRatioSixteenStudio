import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { YouTubeScenePlayer } from "./YouTubeScenePlayer";

interface Stage9x16Props {
  project: VideoProject | null;
  cutTime: number;
  isPlaying: boolean;
  muted: boolean;
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  onTogglePlay: () => void;
  onSeek: (timeSec: number) => void;
  onToggleMute: () => void;
}

function formatSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function Stage9x16({
  project,
  cutTime,
  isPlaying,
  muted,
  voiceSettings,
  editSettings,
  onTogglePlay,
  onSeek,
  onToggleMute,
}: Stage9x16Props) {
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activeSub: SubtitleItem | undefined =
    project?.subtitles.find((s) => cutTime >= s.startTime && cutTime < s.endTime) ??
    project?.subtitles[project?.subtitles.length - 1];

  // Auto-scroll the active list item smoothly inside the 9:16 list view
  useEffect(() => {
    if (!activeSub || !listContainerRef.current) return;
    const container = listContainerRef.current;
    const el = itemRefs.current[activeSub.id];
    if (!el) return;

    const containerHeight = container.clientHeight;
    const targetTop = el.offsetTop - containerHeight * 0.34 + el.clientHeight * 0.5;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [activeSub?.id]);

  const totalDuration = project?.targetDurationSec || 90;
  const progressPct = totalDuration > 0 ? Math.min(100, (cutTime / totalDuration) * 100) : 0;

  return (
    <div className="flex flex-col items-center justify-center w-full gap-3">
      {/* Strictly 9:16 Vertical Video Frame */}
      <div
        className="relative h-[min(calc(100vh-175px),675px)] min-h-[460px] max-w-full aspect-[9/16] rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 flex flex-col shadow-sm"
      >
        {!project ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-xl border border-neutral-200 dark:border-neutral-800 flex items-center justify-center mb-3 text-neutral-400">
              <Play className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              9:16 Stage
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              Watch a video, pick scenes, and generate subtitles
            </p>
          </div>
        ) : (
          <>
            {/* Top Video Window (Full 9:16 if no subtitles, otherwise dynamic height split) */}
            <div
              style={
                project.subtitles.length > 0
                  ? { height: `${editSettings.videoHeightPct}%` }
                  : undefined
              }
              className={`w-full bg-neutral-950 overflow-hidden ${
                project.subtitles.length > 0
                  ? "shrink-0 border-b border-neutral-200 dark:border-neutral-800"
                  : "flex-1 h-full"
              }`}
            >
              <YouTubeScenePlayer
                sourceType={project.sourceType}
                videoId={project.videoId}
                localUrl={project.localUrl}
                scenes={project.scenes}
                cutTime={cutTime}
                isPlaying={isPlaying}
                muted={muted}
                voiceSettings={voiceSettings}
                editSettings={editSettings}
                fallbackThumbnail={project.keyframeUrls[0]}
              />
            </div>

            {/* Bottom Scrolling List Item View (when subtitles exist) */}
            {project.subtitles.length > 0 && (
              <div
                ref={listContainerRef}
                className="relative flex-1 overflow-y-auto no-scrollbar px-3.5 py-4 space-y-2.5 bg-white dark:bg-neutral-950"
              >
                {project.subtitles.map((sub) => {
                  const isActive = activeSub?.id === sub.id;
                  const localElapsed = Math.max(0, cutTime - sub.startTime);

                  return (
                    <button
                      key={sub.id}
                      ref={(node) => {
                        itemRefs.current[sub.id] = node;
                      }}
                      type="button"
                      onClick={() => onSeek(sub.startTime)}
                      className={`w-full text-left rounded-xl px-3.5 py-3 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-white ${
                        isActive
                          ? "bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700"
                          : "bg-transparent border border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-900/50 opacity-60 hover:opacity-90"
                      }`}
                    >
                      {/* Line 1: Thai in English phonetics with animated word-by-word highlights */}
                      <div className="flex flex-wrap items-start gap-x-1.5 gap-y-2 leading-snug">
                        {sub.words.map((word, wi) => {
                          const isWordSpoken =
                            isActive &&
                            localElapsed >= word.startOffsetSec &&
                            localElapsed <= word.endOffsetSec;
                          const wasWordSpoken = isActive && localElapsed > word.endOffsetSec;

                          return (
                            <span
                              key={`${sub.id}-w-${wi}`}
                              className="inline-flex flex-col items-center"
                            >
                              <motion.span
                                animate={
                                  isWordSpoken
                                    ? { scale: 1.06, y: -1 }
                                    : { scale: 1, y: 0 }
                                }
                                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                                className={`px-1.5 py-0.5 rounded-md text-[15px] font-semibold tracking-tight transition-colors duration-150 ${
                                  isWordSpoken
                                    ? "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950"
                                    : isActive
                                      ? wasWordSpoken
                                        ? "text-neutral-950 dark:text-neutral-50"
                                        : "text-neutral-600 dark:text-neutral-400"
                                      : "text-neutral-700 dark:text-neutral-300"
                                }`}
                              >
                                {word.phonetic}
                              </motion.span>
                              {word.burmeseGloss && (
                                <span
                                  className={`font-myanmar text-[10px] leading-tight mt-0.5 ${
                                    isWordSpoken
                                      ? "text-neutral-900 dark:text-neutral-100 font-medium"
                                      : "text-neutral-500 dark:text-neutral-400"
                                  }`}
                                >
                                  {word.burmeseGloss}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>

                      {/* Line 2: Burmese translation */}
                      <p
                        className={`font-myanmar text-[13.5px] leading-relaxed mt-2 ${
                          isActive
                            ? "text-neutral-950 dark:text-neutral-100 font-medium"
                            : "text-neutral-600 dark:text-neutral-400"
                        }`}
                      >
                        {sub.burmese}
                      </p>
                    </button>
                  );
                })}
                <div className="h-24" aria-hidden="true" />
              </div>
            )}
          </>
        )}
      </div>

      {/* Minimal Transport Controls below 9:16 Stage */}
      {project && (
        <div className="w-full max-w-[380px] flex items-center gap-3">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="w-10 h-10 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>

          <div className="flex-1 flex flex-col gap-1">
            <input
              type="range"
              min={0}
              max={totalDuration}
              step={0.1}
              value={cutTime}
              onChange={(e) => onSeek(parseFloat(e.target.value))}
              aria-label="Timeline scrubber"
              className="w-full h-1.5 rounded-full appearance-none bg-neutral-200 dark:bg-neutral-800 accent-neutral-950 dark:accent-white cursor-pointer"
            />
            <div className="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
              <span>
                {formatSec(cutTime)} / {formatSec(totalDuration)}
              </span>
              <span>{Math.round(progressPct)}%</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Unmute original audio" : "Mute original audio"}
            className="w-10 h-10 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-center shrink-0 transition-colors cursor-pointer"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
