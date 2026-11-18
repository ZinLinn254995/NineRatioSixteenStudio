import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { YouTubeScenePlayer, type YouTubeScenePlayerHandle } from "./YouTubeScenePlayer";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getScrollAnchorSubtitle } from "../utils/projectTimeline";

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
  compactMobile?: boolean;
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
  compactMobile = false,
}: Stage9x16Props) {
  const playerRef = useRef<YouTubeScenePlayerHandle | null>(null);
  const stageFrameRef = useRef<HTMLDivElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [stageWidth, setStageWidth] = useState<number>(360);

  useEffect(() => {
    const el = stageFrameRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setStageWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const uiScale = Math.max(0.32, Math.min(1.08, stageWidth / 360));

  const totalDuration = project?.targetDurationSec || 90;
  const effectiveSpeed = project
    ? getEffectivePlaybackSpeed(
        project.sourceType,
        editSettings.playbackSpeed,
        voiceSettings.speed
      )
    : 1;
  // Subtle visual lead while playing so highlights hit right as speech begins instead of lagging
  const highlightTime =
    isPlaying && project
      ? Math.min(
          totalDuration,
          cutTime + (project.sourceType === "youtube" ? 0.22 : 0.12)
        )
      : cutTime;

  const subtitles = project?.subtitles ?? [];
  const activeSub: SubtitleItem | undefined = findActiveSubtitle(subtitles, highlightTime);
  const scrollTargetSub: SubtitleItem | undefined = getScrollAnchorSubtitle(subtitles, highlightTime);

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

  const displayCutTime = cutTime / effectiveSpeed;
  const displayTotalDuration = totalDuration / effectiveSpeed;
  const progressPct = totalDuration > 0 ? Math.min(100, (cutTime / totalDuration) * 100) : 0;

  return (
    <div
      className={`flex flex-col items-center justify-center w-full ${
        compactMobile ? "gap-2 lg:gap-3" : "gap-3"
      }`}
    >
      {/* Strictly 9:16 Vertical Video Frame */}
      <div
        ref={stageFrameRef}
        className={`relative max-w-full aspect-[9/16] rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 flex flex-col shadow-sm ${
          compactMobile
            ? "h-[min(46dvh,420px)] min-h-[240px] lg:h-[min(calc(100dvh-180px),675px)] lg:min-h-[360px]"
            : "h-[min(calc(100dvh-180px),675px)] min-h-[360px]"
        }`}
      >
        {!project ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center ${
              compactMobile ? "p-4 lg:p-8" : "p-8"
            }`}
          >
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl border border-neutral-200 dark:border-neutral-800 flex items-center justify-center mb-2.5 lg:mb-3 text-neutral-400">
              <Play className="w-4 h-4 lg:w-5 lg:h-5" />
            </div>
            <p className="text-xs lg:text-sm font-medium text-neutral-900 dark:text-neutral-100">
              9:16 Stage
            </p>
            <p className="text-[11px] lg:text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              Watch a video, pick scenes, and generate subtitles
            </p>
          </div>
        ) : project.scenes.length === 0 ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center ${
              compactMobile ? "p-4 lg:p-8" : "p-8"
            }`}
          >
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl border border-neutral-200 dark:border-neutral-800 flex items-center justify-center mb-2.5 lg:mb-3 text-neutral-400">
              <Play className="w-4 h-4 lg:w-5 lg:h-5" />
            </div>
            <p className="text-xs lg:text-sm font-medium text-neutral-900 dark:text-neutral-100">
              No clips kept
            </p>
            <p className="text-[11px] lg:text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              Click Undo or Reset in the Edit timeline to restore clips
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
                  ? `${
                      compactMobile ? "min-h-[108px] lg:min-h-[200px]" : "min-h-[200px]"
                    } shrink-0 border-b border-neutral-200 dark:border-neutral-800`
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

            {/* Bottom Scrolling List Item View (when subtitles exist, scaled proportionally to preview width) */}
            {project.subtitles.length > 0 && (
              <div
                ref={listContainerRef}
                style={{
                  padding: `${Math.max(4, Math.round(14 * uiScale))}px ${Math.max(
                    4,
                    Math.round(12 * uiScale)
                  )}px`,
                  gap: `${Math.max(3, Math.round(10 * uiScale))}px`,
                }}
                className="relative flex-1 flex flex-col overflow-y-auto overflow-x-hidden no-scrollbar bg-slate-50 dark:bg-[#0b1120]"
              >
                {project.subtitles.map((sub, subIdx) => {
                  const isActive = activeSub?.id === sub.id;
                  const localElapsed = Math.max(0, highlightTime - sub.startTime);

                  return (
                    <button
                      key={sub.id}
                      ref={(node) => {
                        itemRefs.current[sub.id] = node;
                      }}
                      type="button"
                      onClick={() => onSeek(sub.startTime)}
                      style={{
                        borderRadius: `${Math.max(6, Math.round(12 * uiScale))}px`,
                        padding: `${Math.max(4, Math.round(11 * uiScale))}px ${Math.max(
                          4,
                          Math.round(12 * uiScale)
                        )}px ${Math.max(4, Math.round(11 * uiScale))}px ${Math.max(
                          7,
                          Math.round(15 * uiScale)
                        )}px`,
                      }}
                      className={`relative w-full text-left shrink-0 overflow-hidden transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:focus-visible:ring-indigo-400 ${
                        isActive
                          ? "bg-white dark:bg-[#131c31] border border-indigo-200/90 dark:border-indigo-500/40 shadow-sm shadow-indigo-950/5"
                          : "bg-white/65 dark:bg-slate-900/45 border border-slate-200/70 dark:border-slate-800/70 opacity-70 hover:opacity-95 hover:border-indigo-200/60 dark:hover:border-indigo-500/30"
                      }`}
                    >
                      {/* Educational Left Accent Bar */}
                      <span
                        aria-hidden="true"
                        style={{
                          left: `${Math.max(2, Math.round(6 * uiScale))}px`,
                          top: `${Math.max(4, Math.round(11 * uiScale))}px`,
                          bottom: `${Math.max(4, Math.round(11 * uiScale))}px`,
                          width: `${Math.max(2, Math.round(4 * uiScale))}px`,
                        }}
                        className={`absolute rounded-full transition-colors ${
                          isActive
                            ? "bg-indigo-600 dark:bg-indigo-400"
                            : "bg-slate-200 dark:bg-slate-800"
                        }`}
                      />

                      {/* Line 1: Thai in English phonetics with warm Amber study-highlighter word sync */}
                      <div
                        style={{
                          columnGap: `${Math.max(2, Math.round(6 * uiScale))}px`,
                          rowGap: `${Math.max(2, Math.round(6 * uiScale))}px`,
                        }}
                        className="flex flex-wrap items-start leading-snug"
                      >
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
                              className="inline-flex flex-col items-center max-w-full"
                            >
                              <motion.span
                                animate={
                                  isWordSpoken
                                    ? {
                                        scale: 1.05,
                                        y: -Math.max(0.5, Number((1 * uiScale).toFixed(1))),
                                      }
                                    : { scale: 1, y: 0 }
                                }
                                transition={{ duration: 0.05, ease: [0.16, 1, 0.3, 1] }}
                                style={{
                                  fontSize: `${Math.max(7.5, Number((15 * uiScale).toFixed(1)))}px`,
                                  padding: `${Math.max(1, Math.round(2 * uiScale))}px ${Math.max(
                                    2,
                                    Math.round(6 * uiScale)
                                  )}px`,
                                  borderRadius: `${Math.max(3, Math.round(6 * uiScale))}px`,
                                  lineHeight: 1.2,
                                }}
                                className={`font-semibold tracking-tight max-w-full break-words ${
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
                                  style={{
                                    fontSize: `${Math.max(
                                      6,
                                      Number((10 * uiScale).toFixed(1))
                                    )}px`,
                                    marginTop: `${Math.max(1, Math.round(2 * uiScale))}px`,
                                  }}
                                  className={`font-myanmar leading-tight max-w-full break-words ${
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
                        style={{
                          marginTop: `${Math.max(3, Math.round(8 * uiScale))}px`,
                          paddingTop: `${Math.max(3, Math.round(8 * uiScale))}px`,
                          gap: `${Math.max(3, Math.round(8 * uiScale))}px`,
                        }}
                        className={`border-t flex items-baseline ${
                          isActive
                            ? "border-indigo-100 dark:border-indigo-500/20"
                            : "border-slate-100 dark:border-slate-800/70"
                        }`}
                      >
                        <span
                          style={{
                            fontSize: `${Math.max(6, Number((10 * uiScale).toFixed(1)))}px`,
                          }}
                          className={`font-mono-tabular font-semibold shrink-0 ${
                            isActive
                              ? "text-indigo-500 dark:text-indigo-400"
                              : "text-slate-400 dark:text-slate-500"
                          }`}
                        >
                          {String(subIdx + 1).padStart(2, "0")}
                        </span>
                        <p
                          style={{
                            fontSize: `${Math.max(
                              7,
                              Number((13.5 * uiScale).toFixed(1))
                            )}px`,
                            lineHeight: 1.45,
                          }}
                          className={`font-myanmar min-w-0 break-words ${
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
                <div
                  style={{ height: `${Math.max(24, Math.round(96 * uiScale))}px` }}
                  className="shrink-0"
                  aria-hidden="true"
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Minimal Transport Controls below 9:16 Stage */}
      {project && project.scenes.length > 0 && (
        <div
          className={`w-full max-w-[380px] flex items-center ${
            compactMobile ? "gap-2 lg:gap-3" : "gap-3"
          }`}
        >
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
            className={`${
              compactMobile ? "w-8 h-8 lg:w-10 lg:h-10" : "w-10 h-10"
            } rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity cursor-pointer`}
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
            className={`${
              compactMobile ? "w-8 h-8 lg:w-10 lg:h-10" : "w-10 h-10"
            } rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
