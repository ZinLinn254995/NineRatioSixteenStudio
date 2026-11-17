import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { YouTubeScenePlayer, type YouTubeScenePlayerHandle } from "./YouTubeScenePlayer";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";

interface Stage9x16Props {
  project: VideoProject | null;
  cutTime: number;
  seekNonce: number;
  isPlaying: boolean;
  muted: boolean;
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  onTogglePlay: () => void;
  onPlayingChange: (playing: boolean) => void;
  onSeek: (timeSec: number) => void;
  onTimeUpdate: (newCutTime: number) => void;
  onEnded: () => void;
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
  seekNonce,
  isPlaying,
  muted,
  voiceSettings,
  editSettings,
  onTogglePlay,
  onPlayingChange,
  onSeek,
  onTimeUpdate,
  onEnded,
  onToggleMute,
}: Stage9x16Props) {
  const playerRef = useRef<YouTubeScenePlayerHandle | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Keep the current subtitle selected across silent gaps until the next subtitle starts
  const activeSub: SubtitleItem | undefined = project?.subtitles.reduce<
    SubtitleItem | undefined
  >((acc, s) => (cutTime >= s.startTime ? s : acc), undefined);

  const scrollTargetSub: SubtitleItem | undefined = activeSub ?? project?.subtitles[0];

  // Auto-scroll the active list item smoothly inside the 9:16 list view
  useEffect(() => {
    if (!scrollTargetSub || !listContainerRef.current) return;
    const container = listContainerRef.current;
    const el = itemRefs.current[scrollTargetSub.id];
    if (!el) return;

    const containerHeight = container.clientHeight;
    const targetTop = el.offsetTop - containerHeight * 0.34 + el.clientHeight * 0.5;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [scrollTargetSub?.id]);

  const totalDuration = project?.targetDurationSec || 90;
  const effectiveSpeed = project
    ? getEffectivePlaybackSpeed(
        project.sourceType,
        editSettings.playbackSpeed,
        voiceSettings.speed
      )
    : 1;
  const displayCutTime = cutTime / effectiveSpeed;
  const displayTotalDuration = totalDuration / effectiveSpeed;
  const progressPct = totalDuration > 0 ? Math.min(100, (cutTime / totalDuration) * 100) : 0;

  return (
    <div className="flex flex-col items-center justify-center w-full gap-3">
      {/* Strictly 9:16 Vertical Video Frame */}
      <div
        className="relative h-[min(calc(100dvh-180px),675px)] min-h-[300px] max-w-full aspect-[9/16] rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 flex flex-col shadow-sm"
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
                ref={playerRef}
                sourceType={project.sourceType}
                videoId={project.videoId}
                localUrl={project.localUrl}
                scenes={project.scenes}
                cutTime={cutTime}
                seekNonce={seekNonce}
                isPlaying={isPlaying}
                muted={muted}
                voiceSettings={voiceSettings}
                editSettings={editSettings}
                fallbackThumbnail={project.keyframeUrls[0]}
                onTimeUpdate={onTimeUpdate}
                onPlayingChange={onPlayingChange}
                onEnded={onEnded}
              />
            </div>

            {/* Bottom Scrolling List Item View (when subtitles exist) */}
            {project.subtitles.length > 0 && (
              <div
                ref={listContainerRef}
                className="relative flex-1 overflow-y-auto no-scrollbar px-3.5 py-4 space-y-2.5 bg-slate-50 dark:bg-[#0b1120]"
              >
                {project.subtitles.map((sub, subIdx) => {
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
                      className={`relative w-full text-left rounded-xl pl-4 pr-3.5 py-3 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:focus-visible:ring-indigo-400 ${
                        isActive
                          ? "bg-white dark:bg-[#131c31] border border-indigo-200/90 dark:border-indigo-500/40 shadow-sm shadow-indigo-950/5"
                          : "bg-white/65 dark:bg-slate-900/45 border border-slate-200/70 dark:border-slate-800/70 opacity-70 hover:opacity-95 hover:border-indigo-200/60 dark:hover:border-indigo-500/30"
                      }`}
                    >
                      {/* Educational Left Accent Bar */}
                      <span
                        aria-hidden="true"
                        className={`absolute left-1.5 top-3 bottom-3 w-1 rounded-full transition-colors ${
                          isActive
                            ? "bg-indigo-600 dark:bg-indigo-400"
                            : "bg-slate-200 dark:bg-slate-800"
                        }`}
                      />

                      {/* Line 1: Thai in English phonetics with warm Amber study-highlighter word sync */}
                      <div className="flex flex-wrap items-start gap-x-1.5 gap-y-2 leading-snug">
                        {sub.words.map((word, wi) => {
                          const isLastWord = wi === sub.words.length - 1;
                          const isWordSpoken =
                            isActive &&
                            localElapsed >= word.startOffsetSec &&
                            (isLastWord
                              ? localElapsed <= word.endOffsetSec
                              : localElapsed < word.endOffsetSec);
                          const wasWordSpoken =
                            isActive &&
                            (isLastWord
                              ? localElapsed > word.endOffsetSec
                              : localElapsed >= word.endOffsetSec);

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
                                    ? "bg-amber-300 text-slate-950 ring-1 ring-amber-400/80 dark:bg-amber-400 dark:text-slate-950 dark:ring-amber-300/70 shadow-xs"
                                    : isActive
                                      ? wasWordSpoken
                                        ? "text-indigo-700 dark:text-indigo-300"
                                        : "text-slate-700 dark:text-slate-300"
                                      : "text-slate-500 dark:text-slate-400"
                                }`}
                              >
                                {word.phonetic}
                              </motion.span>
                              {word.burmeseGloss && (
                                <span
                                  className={`font-myanmar text-[10px] leading-tight mt-0.5 ${
                                    isWordSpoken
                                      ? "text-amber-700 dark:text-amber-300 font-semibold"
                                      : isActive
                                        ? "text-teal-700 dark:text-teal-300 font-medium"
                                        : "text-slate-400 dark:text-slate-500"
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
                      <div
                        className={`mt-2 pt-2 border-t flex items-baseline gap-2 ${
                          isActive
                            ? "border-indigo-100 dark:border-indigo-500/20"
                            : "border-slate-100 dark:border-slate-800/70"
                        }`}
                      >
                        <span
                          className={`text-[10px] font-mono-tabular font-semibold shrink-0 ${
                            isActive
                              ? "text-indigo-500 dark:text-indigo-400"
                              : "text-slate-400 dark:text-slate-500"
                          }`}
                        >
                          {String(subIdx + 1).padStart(2, "0")}
                        </span>
                        <p
                          className={`font-myanmar text-[13.5px] leading-relaxed ${
                            isActive
                              ? "text-teal-800 dark:text-teal-200 font-medium"
                              : "text-slate-500 dark:text-slate-400"
                          }`}
                        >
                          {sub.burmese}
                        </p>
                      </div>
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
            onClick={() => {
              if (playerRef.current) {
                playerRef.current.togglePlay();
              } else {
                onTogglePlay();
              }
            }}
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
                {formatSec(displayCutTime)} / {formatSec(displayTotalDuration)}
                {Math.abs(effectiveSpeed - 1) > 0.01 ? ` (${effectiveSpeed.toFixed(2).replace(/\.00$/, "")}x)` : ""}
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
