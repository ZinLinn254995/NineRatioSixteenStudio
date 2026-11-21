import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { YouTubeScenePlayer, type YouTubeScenePlayerHandle } from "./YouTubeScenePlayer";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getScrollAnchorSubtitle } from "../utils/projectTimeline";

function getActiveWordHighlightKey(sub: SubtitleItem | undefined, highlightTime: number): string {
  if (!sub) return "";
  const localElapsed = Math.max(0, highlightTime - sub.startTime);
  for (let wi = 0; wi < sub.words.length; wi++) {
    const word = sub.words[wi];
    const isLast = wi === sub.words.length - 1;
    const hit =
      localElapsed >= word.startOffsetSec &&
      (isLast ? localElapsed <= word.endOffsetSec : localElapsed < word.endOffsetSec);
    if (hit) return `${sub.id}:${wi}`;
  }
  return `${sub.id}:-1`;
}

export const DEFAULT_STAGE_PREVIEW_SCALE = 1;

export function getCompactStageBounds(outerWidth: number, viewportHeight: number) {
  const stageHorizontalPad = 20; // px-2.5 (10px each side)
  const effectiveStageW = outerWidth > 0 ? outerWidth : 390;
  const availWidth = Math.max(200, effectiveStageW - stageHorizontalPad);
  const maxSafeHeight = Math.max(160, Math.round(viewportHeight * 0.64));
  const maxWidthPx = Math.max(
    200,
    Math.min(availWidth, Math.floor((maxSafeHeight * 16) / 9))
  );
  const minWidthPx = Math.max(
    176,
    Math.min(maxWidthPx - 24, Math.round(maxWidthPx * 0.44))
  );
  const spanWidthPx = Math.max(1, maxWidthPx - minWidthPx);
  const minHeightPx = Math.round((minWidthPx * 9) / 16);
  const maxHeightPx = Math.round((maxWidthPx * 9) / 16);
  const spanHeightPx = Math.max(1, maxHeightPx - minHeightPx);
  return {
    availWidth,
    minWidthPx,
    maxWidthPx,
    spanWidthPx,
    minHeightPx,
    maxHeightPx,
    spanHeightPx,
  };
}

interface Stage9x16Props {
  project: VideoProject | null;
  cutTime: number;
  subscribeCutTime?: (listener: (sec: number) => void) => () => void;
  getLiveCutTime?: () => number;
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
  fitContainerHeight?: boolean;
  previewScale?: number;
  onChangePreviewScale?: (scale: number) => void;
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
  subscribeCutTime,
  getLiveCutTime,
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
  fitContainerHeight = false,
  previewScale = DEFAULT_STAGE_PREVIEW_SCALE,
  onChangePreviewScale,
}: Stage9x16Props) {
  const playerRef = useRef<YouTubeScenePlayerHandle | null>(null);
  const stageOuterRef = useRef<HTMLDivElement | null>(null);
  const stageFrameRef = useRef<HTMLDivElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const scrubberInputRef = useRef<HTMLInputElement | null>(null);
  const timeTextRef = useRef<HTMLSpanElement | null>(null);
  const pctTextRef = useRef<HTMLSpanElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dragStartRef = useRef<{
    startY: number;
    startHeightPx: number;
    pointerId: number | null;
    source: "pointer" | "touch";
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const resizeMetricsRef = useRef<{
    minHeightPx: number;
    maxHeightPx: number;
    spanPx: number;
    isCompactLayout: boolean;
    onChangePreviewScale?: (scale: number) => void;
  }>({
    minHeightPx: 150,
    maxHeightPx: 480,
    spanPx: 330,
    isCompactLayout: false,
    onChangePreviewScale: undefined,
  });
  const [outerWidth, setOuterWidth] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isResizing, setIsResizing] = useState(false);
  const [viewportMetrics, setViewportMetrics] = useState<{
    width: number;
    height: number;
    isLg: boolean;
  }>(() =>
    typeof window !== "undefined"
      ? {
          width: document.documentElement?.clientWidth || window.innerWidth,
          height: window.innerHeight,
          isLg: window.matchMedia("(min-width: 1024px)").matches,
        }
      : { width: 1280, height: 900, isLg: true }
  );

  useEffect(() => {
    const updateViewport = () => {
      setViewportMetrics({
        width: document.documentElement?.clientWidth || window.innerWidth,
        height: window.innerHeight,
        isLg: window.matchMedia("(min-width: 1024px)").matches,
      });
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    const el = stageOuterRef.current;
    if (!el) return;
    const parentEl = el.parentElement;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setOuterWidth(w);
      if (parentEl && parentEl.clientHeight > 0) {
        setContainerHeight(parentEl.clientHeight);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (parentEl) ro.observe(parentEl);
    return () => ro.disconnect();
  }, []);

  const totalDuration = project?.targetDurationSec || 90;
  const effectiveSpeed = project
    ? getEffectivePlaybackSpeed(
        project.sourceType,
        editSettings.playbackSpeed,
        voiceSettings.speed
      )
    : 1;
  const displayTotalDuration = totalDuration / effectiveSpeed;
  const leadSec = project ? (project.sourceType === "youtube" ? 0.22 : 0.12) : 0;
  const subtitles = project?.subtitles ?? [];

  const [subClockTime, setSubClockTime] = useState<number>(cutTime);
  const wordKeyRef = useRef<string>("");
  const lastDisplaySecRef = useRef<number>(-1);
  const subtitlesRef = useRef(subtitles);
  subtitlesRef.current = subtitles;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const totalDurationRef = useRef(totalDuration);
  totalDurationRef.current = totalDuration;
  const effectiveSpeedRef = useRef(effectiveSpeed);
  effectiveSpeedRef.current = effectiveSpeed;
  const displayTotalDurationRef = useRef(displayTotalDuration);
  displayTotalDurationRef.current = displayTotalDuration;
  const leadSecRef = useRef(leadSec);
  leadSecRef.current = leadSec;

  // Keep local Stage clock and DOM scrubber synced whenever paused, reset, or explicitly seeked
  const sceneCount = project?.scenes.length ?? 0;
  useEffect(() => {
    if (!isPlaying || !subscribeCutTime) {
      setSubClockTime(cutTime);
      const hl = Math.min(totalDuration, cutTime);
      wordKeyRef.current = getActiveWordHighlightKey(
        findActiveSubtitle(subtitles, hl),
        hl
      );
      lastDisplaySecRef.current = Math.floor(cutTime / effectiveSpeed);
      if (scrubberInputRef.current) {
        scrubberInputRef.current.value = String(cutTime);
      }
      if (pctTextRef.current) {
        const pct = totalDuration > 0 ? Math.min(100, (cutTime / totalDuration) * 100) : 0;
        pctTextRef.current.textContent = `${Math.round(pct)}%`;
      }
      if (timeTextRef.current) {
        const speedSuffix =
          Math.abs(effectiveSpeed - 1) > 0.01
            ? ` (${effectiveSpeed.toFixed(2).replace(/\.00$/, "")}x)`
            : "";
        timeTextRef.current.textContent = `${formatSec(cutTime / effectiveSpeed)} / ${formatSec(displayTotalDuration)}${speedSuffix}`;
      }
    }
  }, [
    cutTime,
    isPlaying,
    seekNonce,
    totalDuration,
    effectiveSpeed,
    displayTotalDuration,
    subtitles,
    sceneCount,
    subscribeCutTime,
  ]);

  // Subscribe to 60fps clock: update scrubber & timer via DOM refs, and only re-render subtitle cards on word/card transitions
  useEffect(() => {
    if (!subscribeCutTime) return;
    return subscribeCutTime((liveSec) => {
      const totDur = totalDurationRef.current;
      const spd = effectiveSpeedRef.current;
      const totDisp = displayTotalDurationRef.current;

      if (scrubberInputRef.current) {
        scrubberInputRef.current.value = String(liveSec);
      }
      if (pctTextRef.current) {
        const pct = totDur > 0 ? Math.min(100, (liveSec / totDur) * 100) : 0;
        pctTextRef.current.textContent = `${Math.round(pct)}%`;
      }
      const dispFloor = Math.floor(liveSec / spd);
      if (dispFloor !== lastDisplaySecRef.current) {
        lastDisplaySecRef.current = dispFloor;
        if (timeTextRef.current) {
          const speedSuffix =
            Math.abs(spd - 1) > 0.01 ? ` (${spd.toFixed(2).replace(/\.00$/, "")}x)` : "";
          timeTextRef.current.textContent = `${formatSec(liveSec / spd)} / ${formatSec(totDisp)}${speedSuffix}`;
        }
      }

      const hl = isPlayingRef.current
        ? Math.min(totDur, liveSec + leadSecRef.current)
        : liveSec;
      const nextSub = findActiveSubtitle(subtitlesRef.current, hl);
      const nextKey = getActiveWordHighlightKey(nextSub, hl);
      if (nextKey !== wordKeyRef.current) {
        wordKeyRef.current = nextKey;
        setSubClockTime(liveSec);
      }
    });
  }, [subscribeCutTime]);

  const activeTimeForDisplay = subscribeCutTime ? subClockTime : cutTime;
  const highlightTime =
    isPlaying && project
      ? Math.min(totalDuration, activeTimeForDisplay + leadSec)
      : activeTimeForDisplay;

  const activeSub: SubtitleItem | undefined = findActiveSubtitle(subtitles, highlightTime);
  const scrollTargetSub: SubtitleItem | undefined = getScrollAnchorSubtitle(subtitles, highlightTime);

  // Auto-scroll the active list item smoothly inside the fixed 720x1280 subtitle viewport
  useEffect(() => {
    if (!scrollTargetSub || !listContainerRef.current) return;
    const container = listContainerRef.current;
    const el = itemRefs.current[scrollTargetSub.id];
    if (!el) return;

    const cHeight = container.clientHeight;
    const targetTop = el.offsetTop + el.clientHeight * 0.5 - cHeight * 0.42;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [scrollTargetSub?.id]);

  const initialStageCutTime = getLiveCutTime ? getLiveCutTime() : activeTimeForDisplay;
  const displayCutTime = initialStageCutTime / effectiveSpeed;
  const progressPct = totalDuration > 0 ? Math.min(100, (initialStageCutTime / totalDuration) * 100) : 0;

  const clampedScale = Math.max(0, Math.min(1, previewScale));
  const isCompactLayout = compactMobile && !viewportMetrics.isLg;
  const compactBounds = getCompactStageBounds(
    outerWidth > 0 ? outerWidth : viewportMetrics.width,
    viewportMetrics.height
  );
  const boundedHeightCeiling =
    fitContainerHeight && !isCompactLayout && containerHeight > 180
      ? Math.max(220, containerHeight - 78)
      : Math.max(360, viewportMetrics.height - 168);
  const minHeightPx = isCompactLayout
    ? compactBounds.minHeightPx
    : Math.max(
        180,
        Math.min(
          fitContainerHeight ? Math.round(boundedHeightCeiling * 0.62) : 440,
          viewportMetrics.height - 340
        )
      );
  const baseMaxHeightPx = isCompactLayout
    ? compactBounds.maxHeightPx
    : Math.max(minHeightPx + 40, Math.min(840, boundedHeightCeiling));
  const availableFrameOuterWidth = Math.max(120, outerWidth - (isCompactLayout ? 24 : 0));
  const maxHeightPx = isCompactLayout
    ? baseMaxHeightPx
    : outerWidth > 0
      ? Math.max(
          minHeightPx + 24,
          Math.min(baseMaxHeightPx, Math.floor((availableFrameOuterWidth * 16) / 9))
        )
      : baseMaxHeightPx;
  const spanPx = Math.max(1, maxHeightPx - minHeightPx);
  const frameHeightPx = Math.round(minHeightPx + clampedScale * spanPx);
  const targetStageWidthPx = Math.round((frameHeightPx * 9) / 16);
  const renderedStageWidthPx =
    outerWidth > 0 ? Math.min(targetStageWidthPx, availableFrameOuterWidth) : targetStageWidthPx;
  const stageScale = renderedStageWidthPx / 720;

  resizeMetricsRef.current = {
    minHeightPx,
    maxHeightPx,
    spanPx,
    isCompactLayout,
    onChangePreviewScale,
  };

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      dragStartRef.current = null;
    };
  }, []);

  const scaleLabel =
    clampedScale < 0.28 ? "Small" : clampedScale > 0.72 ? "Large" : "Normal";

  const applyDragClientY = (clientY: number) => {
    const active = dragStartRef.current;
    const {
      minHeightPx: curMin,
      maxHeightPx: curMax,
      spanPx: curSpan,
      isCompactLayout: compact,
      onChangePreviewScale: notifyScale,
    } = resizeMetricsRef.current;
    if (!active || !notifyScale) return;
    const dy = clientY - active.startY;
    const sensitivity = compact ? 1.0 : 1.5;
    const nextHeight = Math.max(
      curMin,
      Math.min(curMax, active.startHeightPx + dy * sensitivity)
    );
    const nextScale = Math.max(0, Math.min(1, (nextHeight - curMin) / curSpan));
    notifyScale(Number(nextScale.toFixed(4)));
  };

  const endDragResize = () => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setIsResizing(false);
  };

  const beginDragSession = (
    startY: number,
    source: "pointer" | "touch",
    pointerId: number | null
  ) => {
    dragCleanupRef.current?.();
    dragStartRef.current = {
      startY,
      startHeightPx: frameHeightPx,
      pointerId,
      source,
    };
    setIsResizing(true);

    const onWinPointerMove = (ev: PointerEvent) => {
      const active = dragStartRef.current;
      if (!active || active.source !== "pointer") return;
      if (active.pointerId !== null && ev.pointerId !== active.pointerId) return;
      if (ev.cancelable) ev.preventDefault();
      applyDragClientY(ev.clientY);
    };

    const onWinPointerEnd = (ev: PointerEvent) => {
      const active = dragStartRef.current;
      if (!active || active.source !== "pointer") return;
      if (active.pointerId !== null && ev.pointerId !== active.pointerId) return;
      endDragResize();
    };

    const onWinTouchMove = (ev: TouchEvent) => {
      const active = dragStartRef.current;
      if (!active) return;
      if (ev.cancelable) ev.preventDefault();
      if (active.source === "touch" && ev.touches.length > 0) {
        applyDragClientY(ev.touches[0].clientY);
      }
    };

    const onWinTouchEnd = () => {
      const active = dragStartRef.current;
      if (!active) return;
      endDragResize();
    };

    window.addEventListener("pointermove", onWinPointerMove, { passive: false });
    window.addEventListener("pointerup", onWinPointerEnd);
    window.addEventListener("pointercancel", onWinPointerEnd);
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("touchend", onWinTouchEnd);
    window.addEventListener("touchcancel", onWinTouchEnd);

    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onWinPointerMove);
      window.removeEventListener("pointerup", onWinPointerEnd);
      window.removeEventListener("pointercancel", onWinPointerEnd);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("touchend", onWinTouchEnd);
      window.removeEventListener("touchcancel", onWinTouchEnd);
    };
  };

  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onChangePreviewScale) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }
    beginDragSession(e.clientY, "pointer", e.pointerId);
  };

  const handleDragTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!onChangePreviewScale) return;
    if (dragStartRef.current) return;
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
    beginDragSession(e.touches[0].clientY, "touch", null);
  };

  const handleDragDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onChangePreviewScale) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
    onChangePreviewScale(clampedScale >= 0.99 ? 0.5 : DEFAULT_STAGE_PREVIEW_SCALE);
  };

  const handleDragKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onChangePreviewScale) return;
    const target = e.target as HTMLElement | null;
    if (target && target !== e.currentTarget && target.closest("button, input")) return;
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      onChangePreviewScale(Math.max(0, Number((clampedScale - 0.05).toFixed(2))));
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      onChangePreviewScale(Math.min(1, Number((clampedScale + 0.05).toFixed(2))));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChangePreviewScale(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onChangePreviewScale(1);
    } else if (e.key === "0" || e.key === "Enter") {
      e.preventDefault();
      onChangePreviewScale(DEFAULT_STAGE_PREVIEW_SCALE);
    }
  };

  // Match exportVideo.ts 720x1280 split geometry verbatim
  const hasSubtitles = Boolean(project && project.subtitles.length > 0);
  const clampedHeightPct = Math.max(26, Math.min(52, editSettings.videoHeightPct || 35));
  const exportTopVideoH = hasSubtitles ? Math.round((1280 * clampedHeightPct) / 100) : 1280;
  const exportListH = Math.max(1, 1280 - exportTopVideoH);
  const topVideoHeightPct = (exportTopVideoH / 1280) * 100;

  return (
    <div
      ref={stageOuterRef}
      className={`flex flex-col items-center justify-center w-full ${
        compactMobile ? "gap-2 lg:gap-2.5" : "gap-2.5"
      }`}
    >
      {/* Strictly 9:16 Vertical Video Frame matching exportVideo.ts 720x1280 layout */}
      <div
        ref={stageFrameRef}
        style={
          isCompactLayout
            ? { width: `${renderedStageWidthPx}px`, height: `${frameHeightPx}px` }
            : { width: `${renderedStageWidthPx}px` }
        }
        className={`relative max-w-full ${
          isCompactLayout ? "" : "aspect-[9/16]"
        } rounded-lg overflow-hidden bg-white dark:bg-[#12151a] flex flex-col shadow-md ${
          isResizing || isCompactLayout ? "transition-none" : "transition-[width] duration-150"
        }`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg border border-[#dde2e9] dark:border-[#242a34] z-20"
        />
        {!project ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center ${
              compactMobile ? "p-4 lg:p-8" : "p-8"
            }`}
          >
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-lg border border-[#dde2e9] dark:border-[#242a34] bg-[#eceff3] dark:bg-[#181c23] flex items-center justify-center mb-2.5 lg:mb-3 text-teal-700 dark:text-teal-400">
              <Play className="w-4 h-4 lg:w-5 lg:h-5" />
            </div>
            <p className="font-display text-xs lg:text-sm font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
              9:16 Monitor
            </p>
          </div>
        ) : project.scenes.length === 0 ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center ${
              compactMobile ? "p-4 lg:p-8" : "p-8"
            }`}
          >
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-lg border border-[#dde2e9] dark:border-[#242a34] bg-[#eceff3] dark:bg-[#181c23] flex items-center justify-center mb-2.5 lg:mb-3 text-teal-700 dark:text-teal-400">
              <Play className="w-4 h-4 lg:w-5 lg:h-5" />
            </div>
            <p className="font-display text-xs lg:text-sm font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
              No clips kept
            </p>
            <p className="text-[11px] lg:text-xs text-[#525d6d] dark:text-[#8b95a5] mt-1">
              Click Undo or Reset in the Timeline dock to restore clips
            </p>
          </div>
        ) : (
          <>
            {/* Top Video Window (Strictly locked to exportVideo.ts heightPct% without min-height distortion) */}
            <div
              style={hasSubtitles ? { height: `${topVideoHeightPct}%` } : undefined}
              className={`w-full bg-neutral-950 overflow-hidden ${
                hasSubtitles ? "shrink-0" : "flex-1 h-full"
              }`}
            >
              <YouTubeScenePlayer
                ref={playerRef}
                sourceType={project.sourceType}
                videoId={project.videoId}
                localUrl={project.localUrl}
                scenes={project.scenes}
                cutTime={subscribeCutTime ? 0 : cutTime}
                getLiveCutTime={getLiveCutTime}
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

            {/* Bottom Scrolling List Item View — fixed 720px coordinate system matching exportVideo.ts, scaled uniformly with preview */}
            {hasSubtitles && (() => {
              const fontMultiplier =
                editSettings.subtitleFontScale === "sm"
                  ? 0.86
                  : editSettings.subtitleFontScale === "lg"
                    ? 1.16
                    : 1;
              const theme = editSettings.subtitleTheme || "auto";
              const hl = editSettings.subtitleHighlightColor || "amber";
              const showGloss = editSettings.showWordGloss !== false;
              const showBurmese = editSettings.showBurmeseLine !== false;

              const containerThemeClass =
                theme === "light"
                  ? "bg-[#f8fafc]"
                  : theme === "dark"
                    ? "bg-[#0b1120]"
                    : theme === "warm"
                      ? "bg-[#fbf7ef]"
                      : "bg-[#f8fafc] dark:bg-[#0b1120]";

              const topDividerClass =
                theme === "light"
                  ? "border-t border-[#cbd5e1]"
                  : theme === "dark"
                    ? "border-t border-[#1e293b]"
                    : theme === "warm"
                      ? "border-t border-[#e7dcc8]"
                      : "border-t border-[#cbd5e1] dark:border-[#1e293b]";

              const getCardThemeClass = (isActive: boolean) => {
                if (theme === "light") {
                  return isActive
                    ? "bg-white border-2 border-[#c7d2fe]"
                    : "bg-white/72 border border-[#e2e8f0] hover:border-[#c7d2fe]";
                }
                if (theme === "dark") {
                  return isActive
                    ? "bg-[#131c31] border-2 border-indigo-500/45"
                    : "bg-slate-900/55 border border-[#1e293b] hover:border-indigo-500/35";
                }
                if (theme === "warm") {
                  return isActive
                    ? "bg-[#fffdf8] border-2 border-[#fcd34d]"
                    : "bg-[#f4ede0]/72 border border-[#e5dac6] hover:border-[#fcd34d]";
                }
                return isActive
                  ? "bg-white dark:bg-[#131c31] border-2 border-[#c7d2fe] dark:border-indigo-500/45"
                  : "bg-white/72 dark:bg-slate-900/55 border border-[#e2e8f0] dark:border-[#1e293b] hover:border-[#c7d2fe] dark:hover:border-indigo-500/35";
              };

              const getAccentBarClass = (isActive: boolean) => {
                if (theme === "warm") {
                  return isActive ? "bg-[#d97706]" : "bg-[#dfd3be]";
                }
                if (theme === "light") {
                  return isActive ? "bg-[#4f46e5]" : "bg-[#e2e8f0]";
                }
                if (theme === "dark") {
                  return isActive ? "bg-[#818cf8]" : "bg-[#1e293b]";
                }
                return isActive
                  ? "bg-[#4f46e5] dark:bg-[#818cf8]"
                  : "bg-[#e2e8f0] dark:bg-[#1e293b]";
              };

              const spokenPillClass =
                hl === "emerald"
                  ? "bg-[#6ee7b7] text-[#0f172a]"
                  : hl === "indigo"
                    ? "bg-[#6366f1] text-white"
                    : hl === "rose"
                      ? "bg-[#fda4af] text-[#0f172a]"
                      : theme === "dark"
                        ? "bg-[#fbbf24] text-[#0f172a]"
                        : theme === "light" || theme === "warm"
                          ? "bg-[#fde047] text-[#0f172a]"
                          : "bg-[#fde047] dark:bg-[#fbbf24] text-[#0f172a]";

              const getWordClass = (isWordSpoken: boolean, isActive: boolean, wasWordSpoken: boolean) => {
                if (isWordSpoken) return spokenPillClass;
                if (isActive) {
                  if (wasWordSpoken) {
                    if (theme === "dark") return "text-[#a5b4fc]";
                    if (theme === "warm") return "text-[#92400e]";
                    if (theme === "light") return "text-[#4338ca]";
                    return "text-[#4338ca] dark:text-[#a5b4fc]";
                  }
                  if (theme === "dark") return "text-[#cbd5e1]";
                  if (theme === "warm") return "text-[#292524]";
                  if (theme === "light") return "text-[#334155]";
                  return "text-[#334155] dark:text-[#cbd5e1]";
                }
                if (theme === "warm") return "text-[#78716c]";
                return "text-[#64748b]";
              };

              const getGlossClass = (isWordSpoken: boolean, isActive: boolean) => {
                if (isWordSpoken) {
                  if (hl === "emerald") {
                    if (theme === "dark") return "text-[#6ee7b7] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#047857] font-medium";
                    return "text-[#047857] dark:text-[#6ee7b7] font-medium";
                  }
                  if (hl === "indigo") {
                    if (theme === "dark") return "text-[#a5b4fc] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#4338ca] font-medium";
                    return "text-[#4338ca] dark:text-[#a5b4fc] font-medium";
                  }
                  if (hl === "rose") {
                    if (theme === "dark") return "text-[#fda4af] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#be123c] font-medium";
                    return "text-[#be123c] dark:text-[#fda4af] font-medium";
                  }
                  if (theme === "dark") return "text-[#fcd34d] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#b45309] font-medium";
                  return "text-[#b45309] dark:text-[#fcd34d] font-medium";
                }
                if (isActive) {
                  if (theme === "dark") return "text-[#5eead4] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#0f766e] font-medium";
                  return "text-[#0f766e] dark:text-[#5eead4] font-medium";
                }
                if (theme === "dark") return "text-[#475569] font-medium";
                if (theme === "warm") return "text-[#a8a29e] font-medium";
                if (theme === "light") return "text-[#94a3b8] font-medium";
                return "text-[#94a3b8] dark:text-[#475569] font-medium";
              };

              const getThaiScriptClass = (isActive: boolean) => {
                if (isActive) {
                  if (theme === "dark") return "text-[#e2e8f0] font-medium";
                  if (theme === "warm") return "text-[#44403c] font-medium";
                  if (theme === "light") return "text-[#334155] font-medium";
                  return "text-[#334155] dark:text-[#e2e8f0] font-medium";
                }
                if (theme === "warm") return "text-[#78716c] font-medium";
                return "text-[#64748b] font-medium";
              };

              const getDividerClass = (isActive: boolean) => {
                if (theme === "warm") {
                  return isActive ? "border-[#fde68a]" : "border-[#e7dcc8]";
                }
                if (theme === "dark") {
                  return isActive ? "border-indigo-500/25" : "border-[#1e293b]";
                }
                if (theme === "light") {
                  return isActive ? "border-[#e0e7ff]" : "border-[#f1f5f9]";
                }
                return isActive
                  ? "border-[#e0e7ff] dark:border-indigo-500/25"
                  : "border-[#f1f5f9] dark:border-[#1e293b]";
              };

              const getIndexClass = (isActive: boolean) => {
                if (isActive) {
                  if (theme === "warm") return "text-[#b45309]";
                  if (theme === "dark") return "text-[#818cf8]";
                  if (theme === "light") return "text-[#6366f1]";
                  return "text-[#6366f1] dark:text-[#818cf8]";
                }
                if (theme === "dark") return "text-[#475569]";
                if (theme === "warm") return "text-[#a8a29e]";
                if (theme === "light") return "text-[#94a3b8]";
                return "text-[#94a3b8] dark:text-[#475569]";
              };

              const getBurmeseClass = (isActive: boolean) => {
                if (isActive) {
                  if (theme === "dark") return "text-[#99f6e4] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#115e59] font-medium";
                  return "text-[#115e59] dark:text-[#99f6e4] font-medium";
                }
                if (theme === "warm") return "text-[#57534e] font-medium";
                return "text-[#64748b] font-medium";
              };

              const phoneticPx = Math.round(28 * fontMultiplier);
              const glossPx = Math.round(13 * fontMultiplier);
              const thaiPx = Math.round(20 * fontMultiplier);
              const indexPx = Math.round(15 * fontMultiplier);
              const burmesePx = Math.round(22 * fontMultiplier);

              return (
                <div
                  style={{ transform: "translateZ(0)", contain: "layout paint" }}
                  className={`relative flex-1 w-full overflow-hidden ${topDividerClass} ${containerThemeClass}`}
                >
                  <div
                    ref={listContainerRef}
                    style={{
                      width: "720px",
                      height: `${exportListH}px`,
                      transform: `scale(${stageScale}) translateZ(0)`,
                      transformOrigin: "top left",
                      padding: "34px 22px 0 22px",
                      gap: "18px",
                    }}
                    className={`absolute top-0 left-0 flex flex-col overflow-y-auto overflow-x-hidden no-scrollbar ${containerThemeClass}`}
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
                            borderRadius: "18px",
                            padding: "16px 26px 20px 32px",
                          }}
                          className={`relative w-full text-left shrink-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:focus-visible:ring-indigo-400 ${getCardThemeClass(
                            isActive
                          )}`}
                        >
                          {/* Educational Left Accent Bar matching exportVideo.ts (x=32, w=5) */}
                          <span
                            aria-hidden="true"
                            style={{
                              left: "10px",
                              top: "18px",
                              bottom: "18px",
                              width: "5px",
                              borderRadius: "3px",
                            }}
                            className={`absolute ${getAccentBarClass(isActive)}`}
                          />

                          {/* Line 1: Thai in English phonetics with word-by-word sync */}
                          <div
                            style={{
                              columnGap: "8px",
                              rowGap: `${Math.round(10 * fontMultiplier)}px`,
                            }}
                            className="flex flex-wrap items-start"
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
                                  className="inline-flex flex-col items-start max-w-full"
                                >
                                  <span
                                    style={{
                                      fontSize: `${phoneticPx}px`,
                                      padding: `${Math.round(4 * fontMultiplier)}px ${Math.round(
                                        9 * fontMultiplier
                                      )}px`,
                                      borderRadius: "9px",
                                      lineHeight: 1.2,
                                    }}
                                    className={`font-semibold tracking-tight max-w-full break-words ${getWordClass(
                                      isWordSpoken,
                                      isActive,
                                      wasWordSpoken
                                    )}`}
                                  >
                                    {word.phonetic}
                                  </span>
                                  {showGloss && word.burmeseGloss && (
                                    <span
                                      style={{
                                        fontSize: `${glossPx}px`,
                                        marginTop: `${Math.round(4 * fontMultiplier)}px`,
                                        paddingLeft: `${Math.round(9 * fontMultiplier)}px`,
                                        lineHeight: 1.25,
                                      }}
                                      className={`font-myanmar max-w-full break-words ${getGlossClass(
                                        isWordSpoken,
                                        isActive
                                      )}`}
                                    >
                                      {word.burmeseGloss}
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>

                          {/* Optional Thai Script Line */}
                          {editSettings.showThaiScript && sub.thaiScript && (
                            <p
                              style={{
                                marginTop: `${Math.round(12 * fontMultiplier)}px`,
                                paddingLeft: "4px",
                                fontSize: `${thaiPx}px`,
                                fontFamily: "'Noto Sans Thai', 'Plus Jakarta Sans', sans-serif",
                                lineHeight: 1.4,
                              }}
                              className={`min-w-0 break-words ${getThaiScriptClass(isActive)}`}
                            >
                              {sub.thaiScript}
                            </p>
                          )}

                          {/* Line 2: Burmese translation */}
                          {showBurmese && (
                            <div
                              style={{
                                marginTop: `${Math.round(14 * fontMultiplier)}px`,
                                paddingTop: `${Math.round(14 * fontMultiplier)}px`,
                                gap: "12px",
                              }}
                              className={`border-t flex items-baseline ${getDividerClass(isActive)}`}
                            >
                              <span
                                style={{
                                  fontSize: `${indexPx}px`,
                                  minWidth: "20px",
                                }}
                                className={`font-mono-tabular font-semibold shrink-0 ${getIndexClass(
                                  isActive
                                )}`}
                              >
                                {String(subIdx + 1).padStart(2, "0")}
                              </span>
                              <p
                                style={{
                                  fontSize: `${burmesePx}px`,
                                  lineHeight: 1.54,
                                }}
                                className={`font-myanmar min-w-0 break-words ${getBurmeseClass(
                                  isActive
                                )}`}
                              >
                                {sub.burmese}
                              </p>
                            </div>
                          )}
                        </button>
                      );
                    })}
                    <div
                      style={{ height: `${Math.round(exportListH * 0.45)}px` }}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* Transport Controls Row with integrated full-row vertical drag resize */}
      {project && project.scenes.length > 0 ? (
        <div
          role={onChangePreviewScale ? "slider" : undefined}
          tabIndex={onChangePreviewScale ? 0 : undefined}
          aria-label={
            onChangePreviewScale
              ? "Playback controls and preview size drag bar (drag row up to shrink, down to enlarge, double-click for normal)"
              : undefined
          }
          aria-orientation={onChangePreviewScale ? "vertical" : undefined}
          aria-valuemin={onChangePreviewScale ? 0 : undefined}
          aria-valuemax={onChangePreviewScale ? 100 : undefined}
          aria-valuenow={onChangePreviewScale ? Math.round(clampedScale * 100) : undefined}
          title={
            onChangePreviewScale
              ? "Drag this row up to shrink · Drag down to enlarge · Double-click for Normal"
              : undefined
          }
          onPointerDown={onChangePreviewScale ? handleDragPointerDown : undefined}
          onTouchStart={onChangePreviewScale ? handleDragTouchStart : undefined}
          onDoubleClick={onChangePreviewScale ? handleDragDoubleClick : undefined}
          onKeyDown={onChangePreviewScale ? handleDragKeyDown : undefined}
          className={`relative group flex flex-col ${
            isResizing ? "transition-none" : "transition-colors duration-150"
          } ${
            onChangePreviewScale
              ? `w-full ${
                  compactMobile
                    ? "border-t border-b rounded-none px-3.5 pt-1 pb-2"
                    : "border rounded-lg px-3 pt-1 pb-2"
                } cursor-ns-resize touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
                  isResizing
                    ? "border-teal-700 dark:border-teal-400 bg-teal-50/70 dark:bg-[#181c23]"
                    : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:border-[#c3ccd9] dark:hover:border-[#323a48]"
                }`
              : "w-full border border-transparent px-0 py-0"
          }`}
        >
          {/* Dedicated touch-friendly Drag Bar Strip along top of the Play row */}
          {onChangePreviewScale && (
            <div className="flex items-center justify-center py-1.5 touch-none">
              <span
                className={`h-1 rounded-full transition-all ${
                  isResizing
                    ? "w-16 bg-teal-700 dark:bg-teal-400"
                    : "w-10 bg-[#c9d1dc] dark:bg-[#323a48] group-hover:w-14 group-hover:bg-teal-700/70 dark:group-hover:bg-teal-400/70"
                }`}
              />
              {isResizing && (
                <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm">
                  {scaleLabel} · {Math.round(clampedScale * 100)}%
                </span>
              )}
            </div>
          )}

          <div
            className={`w-full flex items-center ${
              compactMobile ? "gap-2 lg:gap-2.5" : "gap-2.5"
            }`}
          >
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={() => {
                if (playerRef.current) {
                  playerRef.current.togglePlay();
                } else {
                  onTogglePlay();
                }
              }}
              aria-label={isPlaying ? "Pause" : "Play"}
              className={`${
                compactMobile ? "w-8 h-8 lg:w-9 lg:h-9" : "w-9 h-9"
              } rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#061412] flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>

            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <input
                ref={scrubberInputRef}
                type="range"
                min={0}
                max={totalDuration}
                step={0.1}
                defaultValue={initialStageCutTime}
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onChange={(e) => onSeek(parseFloat(e.target.value))}
                aria-label="Timeline scrubber"
                className="w-full h-1.5 rounded-full appearance-none bg-[#dde2e9] dark:bg-[#242a34] cursor-pointer"
              />
              <div className="flex items-center justify-between text-[11px] text-[#525d6d] dark:text-[#8b95a5] font-mono-tabular">
                <span ref={timeTextRef} className="truncate">
                  {formatSec(displayCutTime)} / {formatSec(displayTotalDuration)}
                  {Math.abs(effectiveSpeed - 1) > 0.01 ? ` (${effectiveSpeed.toFixed(2).replace(/\.00$/, "")}x)` : ""}
                </span>
                <span ref={pctTextRef} className="shrink-0 ml-1">
                  {Math.round(progressPct)}%
                </span>
              </div>
            </div>

            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={onToggleMute}
              aria-label={muted ? "Unmute original audio" : "Mute original audio"}
              className={`${
                compactMobile ? "w-8 h-8 lg:w-9 lg:h-9" : "w-9 h-9"
              } rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[#0e1217] dark:text-[#f1f3f5] flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      ) : (
        onChangePreviewScale && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Resize 9:16 video preview (drag up to shrink, down to enlarge, double-click for normal)"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampedScale * 100)}
            title="Drag up to shrink · Drag down to enlarge · Double-click to reset Normal"
            onPointerDown={handleDragPointerDown}
            onTouchStart={handleDragTouchStart}
            onDoubleClick={handleDragDoubleClick}
            onKeyDown={handleDragKeyDown}
            className={`relative group w-full h-6 flex items-center justify-center cursor-ns-resize touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
              compactMobile
                ? "border-b border-[#dde2e9] dark:border-[#242a34]"
                : ""
            }`}
          >
            <span
              className={`h-1 rounded-full transition-all ${
                isResizing
                  ? "w-16 bg-teal-700 dark:bg-teal-400"
                  : "w-10 bg-[#b8c2d0] dark:bg-[#323a48] group-hover:w-14 group-hover:bg-teal-700/80 dark:group-hover:bg-teal-400/80"
              }`}
            />
            {isResizing && (
              <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm">
                {scaleLabel} · {Math.round(clampedScale * 100)}%
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
