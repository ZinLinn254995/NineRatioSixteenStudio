import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
import { ChevronDown, Pause, Play, Ratio, Upload, Volume2, VolumeX } from "lucide-react";
import type {
  SubtitleItem,
  VideoAspectRatio,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
} from "../types";
import { ScenePlayer, type ScenePlayerHandle } from "./ScenePlayer";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getScrollAnchorSubtitle } from "../utils/projectTimeline";
import { hasGeneratedProject, hasProjectMedia } from "../utils/projectState";
import {
  VIDEO_ASPECT_RATIO_OPTIONS,
  resolveStageCanvasGeometry,
  resolveSubtitleFontMultiplier,
  resolveSubtitleFontStack,
} from "../utils/videoFilters";
import {
  clampAndSnapVideoHeightPct,
  isStageCleanClick,
} from "../utils/subtitleState";
import { AppErrorBoundary } from "./AppErrorBoundary";

function getActiveWordHighlightKey(sub: SubtitleItem | undefined, highlightTime: number): string {
  if (!sub || !Array.isArray(sub.words)) return "";
  const localElapsed = Math.max(0, highlightTime - (Number.isFinite(sub.startTime) ? sub.startTime : 0));
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
export const MAX_STAGE_PREVIEW_SCALE = 2;

export function scaleToBoundsValue(
  scale: number,
  minVal: number,
  defaultVal: number,
  maxVal: number
): number {
  const s = Math.max(0, Math.min(MAX_STAGE_PREVIEW_SCALE, scale));
  if (s <= 1) {
    return Math.round(minVal + s * (defaultVal - minVal));
  }
  return Math.round(defaultVal + (s - 1) * (maxVal - defaultVal));
}

export function boundsValueToScale(
  val: number,
  minVal: number,
  defaultVal: number,
  maxVal: number
): number {
  const clamped = Math.max(minVal, Math.min(maxVal, val));
  if (clamped <= defaultVal) {
    const lowerSpan = Math.max(1, defaultVal - minVal);
    return Math.max(0, Math.min(1, (clamped - minVal) / lowerSpan));
  }
  const upperSpan = Math.max(1, maxVal - defaultVal);
  return Math.max(1, Math.min(MAX_STAGE_PREVIEW_SCALE, 1 + (clamped - defaultVal) / upperSpan));
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
  selectedSubtitleId?: string | null;
  onSelectSubtitle?: (id: string, startTime: number) => void;
  compactMobile?: boolean;
  fitContainerHeight?: boolean;
  previewScale?: number;
  onChangePreviewScale?: (scale: number) => void;
  onChangeVideoHeightPct?: (pct: number) => void;
  onChangeAspectRatio?: (ratio: VideoAspectRatio) => void;
  onUploadVideo?: (file: File) => void;
  onDetectedDuration?: (dur: number) => void;
  hideCaptions?: boolean;
}

function formatSec(sec: number): string {
  const safeSec = typeof sec === "number" && Number.isFinite(sec) ? sec : 0;
  const s = Math.max(0, Math.floor(safeSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export interface Stage9x16Handle {
  play: () => void;
  pause: () => void;
  setScrubbing: (active: boolean) => void;
  seekCutTime: (cutSec: number, opts?: { force?: boolean }) => void;
  previewSourceTime: (sourceSec: number | null, opts?: { skipResync?: boolean }) => void;
}

export const Stage9x16 = forwardRef<Stage9x16Handle, Stage9x16Props>(function Stage9x16(
  {
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
    selectedSubtitleId = null,
    onSelectSubtitle,
    compactMobile = false,
    fitContainerHeight = false,
    previewScale = DEFAULT_STAGE_PREVIEW_SCALE,
    onChangePreviewScale,
    onChangeVideoHeightPct,
    onChangeAspectRatio,
    onUploadVideo,
    onDetectedDuration,
    hideCaptions = false,
  },
  ref
) {
  const playerRef = useRef<ScenePlayerHandle | null>(null);
  const subPanelRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const ratioMenuRef = useRef<HTMLDivElement | null>(null);
  const [isUploadDragOver, setIsUploadDragOver] = useState(false);
  const [showRatioMenu, setShowRatioMenu] = useState(false);
  const [detectedVideoDims, setDetectedVideoDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const onDetectedDurationRef = useRef(onDetectedDuration);
  onDetectedDurationRef.current = onDetectedDuration;
  const stageOuterRef = useRef<HTMLDivElement | null>(null);
  const stageFrameRef = useRef<HTMLDivElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const scrubberInputRef = useRef<HTMLInputElement | null>(null);
  const timeTextRef = useRef<HTMLSpanElement | null>(null);
  const pctTextRef = useRef<HTMLSpanElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const cardPointerDownRef = useRef<{
    id: string;
    clientX: number;
    clientY: number;
    at: number;
  } | null>(null);
  const suppressNextCardClickIdRef = useRef<string | null>(null);
  const dragStartRef = useRef<{
    startY: number;
    startHeightPx: number;
    pointerId: number | null;
    source: "pointer" | "touch";
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const resizeMetricsRef = useRef<{
    minHeightPx: number;
    defaultHeightPx: number;
    maxHeightPx: number;
    isCompactLayout: boolean;
    onChangePreviewScale?: (scale: number) => void;
  }>({
    minHeightPx: 160,
    defaultHeightPx: 320,
    maxHeightPx: 480,
    isCompactLayout: false,
    onChangePreviewScale: undefined,
  });
  const [outerWidth, setOuterWidth] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isResizing, setIsResizing] = useState(false);
  const [dragVideoHeightPct, setDragVideoHeightPct] = useState<number | null>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [isSplitSnapped, setIsSplitSnapped] = useState(false);
  const splitDragCleanupRef = useRef<(() => void) | null>(null);
  const splitRafRef = useRef<number | null>(null);
  const pendingSplitRef = useRef<{ pct: number; snapped: boolean } | null>(null);
  const onChangeVideoHeightPctRef = useRef(onChangeVideoHeightPct);
  onChangeVideoHeightPctRef.current = onChangeVideoHeightPct;
  const dragVideoHeightPctRef = useRef<number | null>(null);
  dragVideoHeightPctRef.current = dragVideoHeightPct;
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

  const activeProject = hasProjectMedia(project) ? project : null;

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        playerRef.current?.play();
      },
      pause: () => {
        playerRef.current?.pause();
      },
      setScrubbing: (active: boolean) => {
        playerRef.current?.setScrubbing(active);
      },
      seekCutTime: (cutSec: number, opts?: { force?: boolean }) => {
        playerRef.current?.seekCutTime(cutSec, opts);
      },
      previewSourceTime: (sourceSec: number | null, opts?: { skipResync?: boolean }) => {
        if (!activeProject?.localUrl) {
          if (subPanelRef.current) subPanelRef.current.style.visibility = "";
          return;
        }
        if (subPanelRef.current) {
          subPanelRef.current.style.visibility = sourceSec !== null ? "hidden" : "";
        }
        playerRef.current?.previewSourceTime(sourceSec, opts);
      },
    }),
    [activeProject?.localUrl]
  );

  useEffect(() => {
    if (subPanelRef.current) {
      subPanelRef.current.style.visibility = "";
    }
  }, [activeProject?.localUrl]);

  useEffect(() => {
    setDetectedVideoDims(null);
    setShowRatioMenu(false);
    if (!activeProject || !activeProject.localUrl) {
      return;
    }
    const frameEl = stageFrameRef.current;
    if (!frameEl) return;

    const reportFromVideo = (vidEl: HTMLVideoElement | null | undefined) => {
      if (!vidEl) return;
      const d = vidEl.duration;
      if (Number.isFinite(d) && d > 0) {
        onDetectedDurationRef.current?.(Math.max(0.5, Math.round(d * 10) / 10));
      }
      if (vidEl.videoWidth > 0 && vidEl.videoHeight > 0) {
        setDetectedVideoDims((prev) =>
          prev && prev.width === vidEl.videoWidth && prev.height === vidEl.videoHeight
            ? prev
            : { width: vidEl.videoWidth, height: vidEl.videoHeight }
        );
      }
    };

    const existingVideo = frameEl.querySelector("video");
    if (existingVideo && existingVideo.readyState >= 1) {
      reportFromVideo(existingVideo);
    }

    const onMediaReadyCapture = (ev: Event) => {
      if (ev.target instanceof HTMLVideoElement) {
        reportFromVideo(ev.target);
      }
    };
    frameEl.addEventListener("loadedmetadata", onMediaReadyCapture, true);
    frameEl.addEventListener("loadeddata", onMediaReadyCapture, true);
    return () => {
      frameEl.removeEventListener("loadedmetadata", onMediaReadyCapture, true);
      frameEl.removeEventListener("loadeddata", onMediaReadyCapture, true);
    };
  }, [activeProject?.localUrl]);

  useEffect(() => {
    if (!showRatioMenu) return;
    const onOutsidePointer = (ev: PointerEvent) => {
      if (ratioMenuRef.current && !ratioMenuRef.current.contains(ev.target as Node)) {
        setShowRatioMenu(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setShowRatioMenu(false);
    };
    window.addEventListener("pointerdown", onOutsidePointer);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onOutsidePointer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showRatioMenu]);
  const safeCutTime = typeof cutTime === "number" && Number.isFinite(cutTime) ? Math.max(0, cutTime) : 0;
  const totalDuration =
    activeProject &&
    typeof activeProject.targetDurationSec === "number" &&
    Number.isFinite(activeProject.targetDurationSec) &&
    activeProject.targetDurationSec > 0
      ? activeProject.targetDurationSec
      : 90;
  const rawEffectiveSpeed = activeProject
    ? getEffectivePlaybackSpeed(editSettings.playbackSpeed, voiceSettings.speed)
    : 1;
  const effectiveSpeed =
    typeof rawEffectiveSpeed === "number" && Number.isFinite(rawEffectiveSpeed) && rawEffectiveSpeed > 0
      ? rawEffectiveSpeed
      : 1;
  const displayTotalDuration = totalDuration / effectiveSpeed;
  const leadSec = activeProject ? 0.12 : 0;
  const subtitles =
    hasGeneratedProject(project) && Array.isArray(project.subtitles) ? project.subtitles : [];

  const [subClockTime, setSubClockTime] = useState<number>(safeCutTime);
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

  // Keep local Stage clock and DOM scrubber synced whenever paused, reset, seeked, or speed changes
  const sceneCount = activeProject ? activeProject.scenes.length : 0;
  const hasTransportBar = Boolean(activeProject && activeProject.scenes.length > 0);
  useIsomorphicLayoutEffect(() => {
    const syncTime =
      isPlaying && getLiveCutTime
        ? Math.max(0, Number.isFinite(getLiveCutTime()) ? getLiveCutTime() : safeCutTime)
        : safeCutTime;
    lastDisplaySecRef.current = Math.floor(syncTime / effectiveSpeed);
    if (scrubberInputRef.current && (!isPlaying || !subscribeCutTime)) {
      scrubberInputRef.current.value = String(syncTime);
    }
    if (pctTextRef.current) {
      const pct = totalDuration > 0 ? Math.min(100, (syncTime / totalDuration) * 100) : 0;
      pctTextRef.current.textContent = `${Math.round(pct)}%`;
    }
    if (timeTextRef.current) {
      const speedSuffix =
        Math.abs(effectiveSpeed - 1) > 0.01
          ? ` (${effectiveSpeed.toFixed(2).replace(/\.00$/, "")}x)`
          : "";
      timeTextRef.current.textContent = `${formatSec(syncTime / effectiveSpeed)} / ${formatSec(displayTotalDuration)}${speedSuffix}`;
    }
  }, [
    safeCutTime,
    isPlaying,
    seekNonce,
    totalDuration,
    effectiveSpeed,
    displayTotalDuration,
    sceneCount,
    hasTransportBar,
    subscribeCutTime,
    getLiveCutTime,
  ]);

  useEffect(() => {
    if (!isPlaying || !subscribeCutTime) {
      setSubClockTime(safeCutTime);
      const hl = Math.min(totalDuration, safeCutTime);
      wordKeyRef.current = getActiveWordHighlightKey(
        findActiveSubtitle(subtitles, hl),
        hl
      );
    }
  }, [
    safeCutTime,
    isPlaying,
    seekNonce,
    totalDuration,
    subtitles,
    sceneCount,
    subscribeCutTime,
  ]);

  // Subscribe to 60fps clock: update scrubber & timer via DOM refs, and only re-render subtitle cards on word/card transitions
  useEffect(() => {
    if (!subscribeCutTime) return;
    return subscribeCutTime((rawLiveSec) => {
      const liveSec =
        typeof rawLiveSec === "number" && Number.isFinite(rawLiveSec) ? Math.max(0, rawLiveSec) : 0;
      const totDur = totalDurationRef.current;
      const spd = effectiveSpeedRef.current > 0 ? effectiveSpeedRef.current : 1;
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

  const rawActiveTime = subscribeCutTime ? subClockTime : safeCutTime;
  const activeTimeForDisplay =
    typeof rawActiveTime === "number" && Number.isFinite(rawActiveTime) ? Math.max(0, rawActiveTime) : 0;
  const highlightTime =
    isPlaying && hasGeneratedProject(project)
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

    const targetTop = Math.max(0, el.offsetTop - 34);
    try {
      container.scrollTo({
        top: targetTop,
        behavior: "smooth",
      });
    } catch {
      // ignore unsupported smooth scroll
    }
  }, [scrollTargetSub?.id]);

  const rawInitialCutTime = getLiveCutTime ? getLiveCutTime() : activeTimeForDisplay;
  const initialStageCutTime =
    typeof rawInitialCutTime === "number" && Number.isFinite(rawInitialCutTime)
      ? Math.max(0, rawInitialCutTime)
      : 0;

  const stageGeometry = resolveStageCanvasGeometry(editSettings.aspectRatio, detectedVideoDims);
  const effectiveAspect = stageGeometry.aspect;

  const safePreviewScale =
    typeof previewScale === "number" && Number.isFinite(previewScale)
      ? previewScale
      : DEFAULT_STAGE_PREVIEW_SCALE;
  const clampedScale = Math.max(0, Math.min(MAX_STAGE_PREVIEW_SCALE, safePreviewScale));
  const isCompactLayout = compactMobile && !viewportMetrics.isLg;
  const effectiveOuterW = outerWidth > 0 ? outerWidth : viewportMetrics.width;
  const availableFrameOuterWidth = Math.max(120, effectiveOuterW - (isCompactLayout ? 20 : 0));

  let minHeightPx: number;
  let defaultHeightPx: number;
  let maxHeightPx: number;

  if (isCompactLayout) {
    const widthCappedMaxH = Math.floor(availableFrameOuterWidth / effectiveAspect);
    const viewportCappedMaxH = Math.min(
      Math.round(viewportMetrics.height * 0.64),
      Math.max(220, viewportMetrics.height - 320)
    );
    const maxSafeMobileH = Math.max(96, Math.min(viewportCappedMaxH, widthCappedMaxH));
    maxHeightPx = maxSafeMobileH;
    minHeightPx = Math.max(
      80,
      Math.min(maxHeightPx, Math.round(maxHeightPx * (effectiveAspect >= 1.15 ? 0.48 : 0.28)))
    );
    defaultHeightPx =
      effectiveAspect >= 1.15
        ? Math.max(minHeightPx, Math.min(maxHeightPx, Math.round(maxHeightPx * 0.92)))
        : Math.max(
            minHeightPx + Math.min(36, Math.max(0, maxHeightPx - minHeightPx)),
            Math.min(maxHeightPx - Math.min(36, Math.max(0, maxHeightPx - minHeightPx)), Math.round(maxHeightPx * 0.58))
          );
  } else {
    const controlsReservePx = hasTransportBar ? 104 : 38;
    const boundedHeightCeiling =
      fitContainerHeight && containerHeight > 180
        ? Math.max(160, containerHeight - controlsReservePx)
        : Math.max(300, viewportMetrics.height - 180);
    const widthCappedMaxH =
      outerWidth > 0 ? Math.floor(availableFrameOuterWidth / effectiveAspect) : 920;
    maxHeightPx = Math.max(120, Math.min(920, boundedHeightCeiling, widthCappedMaxH));
    minHeightPx = Math.max(
      96,
      Math.min(maxHeightPx, Math.round(maxHeightPx * (effectiveAspect >= 1.15 ? 0.5 : 0.42)))
    );
    defaultHeightPx =
      effectiveAspect >= 1.15
        ? Math.max(minHeightPx, Math.min(maxHeightPx, Math.round(maxHeightPx * 0.92)))
        : Math.max(
            minHeightPx,
            Math.min(maxHeightPx - Math.min(24, Math.max(0, maxHeightPx - minHeightPx)), Math.round(maxHeightPx * 0.74))
          );
  }

  const frameHeightPx = scaleToBoundsValue(
    clampedScale,
    minHeightPx,
    defaultHeightPx,
    maxHeightPx
  );
  const targetStageWidthPx = Math.round(frameHeightPx * effectiveAspect);
  const renderedStageWidthPx =
    outerWidth > 0 ? Math.min(targetStageWidthPx, availableFrameOuterWidth) : targetStageWidthPx;
  const renderedStageHeightPx = Math.max(
    80,
    Math.round(renderedStageWidthPx / effectiveAspect)
  );
  const stageScale = renderedStageWidthPx / stageGeometry.logicalWidth;

  resizeMetricsRef.current = {
    minHeightPx,
    defaultHeightPx,
    maxHeightPx,
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
    clampedScale < 0.35
      ? "Small"
      : clampedScale < 0.85
        ? "Medium"
        : clampedScale <= 1.15
          ? "Normal"
          : "Large";

  const applyDragClientY = (clientY: number) => {
    const active = dragStartRef.current;
    const {
      minHeightPx: curMin,
      defaultHeightPx: curDef,
      maxHeightPx: curMax,
      isCompactLayout: compact,
      onChangePreviewScale: notifyScale,
    } = resizeMetricsRef.current;
    if (!active || !notifyScale) return;
    const dy = clientY - active.startY;
    const sensitivity = compact ? 1.0 : 1.35;
    const nextHeight = Math.max(
      curMin,
      Math.min(curMax, active.startHeightPx + dy * sensitivity)
    );
    const nextScale = boundsValueToScale(nextHeight, curMin, curDef, curMax);
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
    const isDefault = Math.abs(clampedScale - DEFAULT_STAGE_PREVIEW_SCALE) < 0.03;
    onChangePreviewScale(isDefault ? 0.5 : DEFAULT_STAGE_PREVIEW_SCALE);
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
      onChangePreviewScale(
        Math.min(MAX_STAGE_PREVIEW_SCALE, Number((clampedScale + 0.05).toFixed(2)))
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      onChangePreviewScale(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onChangePreviewScale(MAX_STAGE_PREVIEW_SCALE);
    } else if (e.key === "0" || e.key === "Enter") {
      e.preventDefault();
      onChangePreviewScale(DEFAULT_STAGE_PREVIEW_SCALE);
    }
  };

  useEffect(() => {
    return () => {
      splitDragCleanupRef.current?.();
      if (splitRafRef.current !== null) {
        cancelAnimationFrame(splitRafRef.current);
      }
    };
  }, []);

  // Match exportVideo.ts split geometry for portrait ratios; use lower-third overlay for landscape/square
  const hasSubtitles =
    !hideCaptions && Boolean(hasGeneratedProject(project) && project.subtitles.length > 0);
  const useSplitSubtitleLayout = hasSubtitles && stageGeometry.isPortraitSplitFriendly;
  const useOverlaySubtitleLayout = hasSubtitles && !stageGeometry.isPortraitSplitFriendly;
  const logicalStageH = stageGeometry.logicalHeight;
  const activeVideoHeightPct = dragVideoHeightPct ?? (editSettings.videoHeightPct || 35);
  const clampedHeightPct = Math.max(26, Math.min(52, activeVideoHeightPct));
  const rawTopVideoH = useSplitSubtitleLayout
    ? Math.round((logicalStageH * clampedHeightPct) / 100)
    : logicalStageH;
  const exportTopVideoH = useSplitSubtitleLayout
    ? Math.max(200, Math.min(logicalStageH - 220, Math.round(rawTopVideoH / 2) * 2))
    : logicalStageH;
  const exportListH = Math.max(1, logicalStageH - exportTopVideoH);
  const topVideoHeightPct = (exportTopVideoH / logicalStageH) * 100;
  const snapGuideTopPct =
    ((Math.round(Math.round((logicalStageH * 35) / 100) / 2) * 2) / logicalStageH) * 100;

  const scheduleSplitPreview = (clientY: number) => {
    const frameEl = stageFrameRef.current;
    if (!frameEl) return;
    const rect = frameEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const rawPct = ((clientY - rect.top) / rect.height) * 100;
    const next = clampAndSnapVideoHeightPct(rawPct, 1.0);
    pendingSplitRef.current = next;
    if (splitRafRef.current === null) {
      splitRafRef.current = requestAnimationFrame(() => {
        splitRafRef.current = null;
        if (pendingSplitRef.current) {
          setDragVideoHeightPct(pendingSplitRef.current.pct);
          setIsSplitSnapped(pendingSplitRef.current.snapped);
        }
      });
    }
  };

  const endSplitDrag = () => {
    splitDragCleanupRef.current?.();
    splitDragCleanupRef.current = null;
    if (splitRafRef.current !== null) {
      cancelAnimationFrame(splitRafRef.current);
      splitRafRef.current = null;
    }
    const finalPct =
      pendingSplitRef.current?.pct ??
      dragVideoHeightPctRef.current ??
      Math.round(clampedHeightPct);
    pendingSplitRef.current = null;
    setDragVideoHeightPct(null);
    setIsDraggingSplit(false);
    setIsSplitSnapped(false);
    onChangeVideoHeightPctRef.current?.(Math.max(26, Math.min(52, Math.round(finalPct))));
  };

  const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!useSplitSubtitleLayout || !onChangeVideoHeightPct) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }

    splitDragCleanupRef.current?.();
    const pointerId = e.pointerId;
    setIsDraggingSplit(true);
    scheduleSplitPreview(e.clientY);

    const onWinPointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (ev.cancelable) ev.preventDefault();
      scheduleSplitPreview(ev.clientY);
    };
    const onWinPointerUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endSplitDrag();
    };
    const onWinTouchMove = (ev: TouchEvent) => {
      if (ev.cancelable) ev.preventDefault();
      if (ev.touches.length > 0) {
        scheduleSplitPreview(ev.touches[0].clientY);
      }
    };
    const onWinTouchEnd = () => {
      endSplitDrag();
    };

    window.addEventListener("pointermove", onWinPointerMove, { passive: false });
    window.addEventListener("pointerup", onWinPointerUp);
    window.addEventListener("pointercancel", onWinPointerUp);
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("touchend", onWinTouchEnd);
    window.addEventListener("touchcancel", onWinTouchEnd);

    splitDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onWinPointerMove);
      window.removeEventListener("pointerup", onWinPointerUp);
      window.removeEventListener("pointercancel", onWinPointerUp);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("touchend", onWinTouchEnd);
      window.removeEventListener("touchcancel", onWinTouchEnd);
    };
  };

  const handleSplitKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!useSplitSubtitleLayout || !onChangeVideoHeightPct) return;
    const basePct = Math.round(clampedHeightPct);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onChangeVideoHeightPct(Math.max(26, basePct - 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onChangeVideoHeightPct(Math.min(52, basePct + 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChangeVideoHeightPct(26);
    } else if (e.key === "End") {
      e.preventDefault();
      onChangeVideoHeightPct(52);
    } else if (e.key === "Enter" || e.key === "0") {
      e.preventDefault();
      onChangeVideoHeightPct(35);
    }
  };

  return (
    <div
      ref={stageOuterRef}
      className={`flex flex-col items-center justify-center w-full ${
        compactMobile ? "gap-2 lg:gap-2.5" : "gap-2.5"
      }`}
    >
      {/* Adaptive Video Frame matching Original video aspect ratio or selected preset */}
      <div
        ref={stageFrameRef}
        style={{
          width: `${renderedStageWidthPx}px`,
          height: `${renderedStageHeightPx}px`,
        }}
        className={`relative max-w-full rounded-lg overflow-hidden bg-white dark:bg-[#0d1022] flex flex-col shadow-md ${
          isResizing || isCompactLayout ? "transition-none" : "transition-[width,height] duration-150"
        }`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] z-20"
        />
        {!activeProject ? (
          onUploadVideo ? (
            <div
              className={`flex-1 flex flex-col items-center justify-center ${
                compactMobile ? "p-3 lg:p-5" : "p-5"
              }`}
            >
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
              <button
                type="button"
                onClick={() => uploadInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!isUploadDragOver) setIsUploadDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsUploadDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsUploadDragOver(false);
                  const file = e.dataTransfer?.files?.[0];
                  if (
                    file &&
                    (file.type.startsWith("video/") ||
                      /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name))
                  ) {
                    onUploadVideo(file);
                  }
                }}
                className={`group w-full h-full rounded-lg border border-dashed flex flex-col items-center justify-center gap-2 text-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 p-4 ${
                  isUploadDragOver
                    ? "border-teal-700 dark:border-teal-400 bg-teal-50/70 dark:bg-teal-950/35"
                    : "border-[#bcc9e6] dark:border-[#2e3644] bg-[#e7ecf8]/75 dark:bg-[#0d1015] hover:border-teal-700/60 dark:hover:border-teal-400/50 hover:bg-[#e6eaf0]/85 dark:hover:bg-[#12161d]"
                }`}
              >
                <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white/85 dark:bg-[#141933] flex items-center justify-center text-teal-700 dark:text-teal-400 transition-transform duration-150 group-hover:-translate-y-0.5 shrink-0">
                  <Upload className="w-4 h-4 lg:w-5 lg:h-5" />
                </div>
                <span className="font-display text-xs lg:text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                  Upload video
                </span>
                <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                  Click or drop video file
                </span>
              </button>
            </div>
          ) : (
            <div
              className={`flex-1 flex flex-col items-center justify-center text-center ${
                compactMobile ? "p-4 lg:p-8" : "p-8"
              }`}
            >
              <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#e7ecf8] dark:bg-[#141933] flex items-center justify-center mb-2.5 lg:mb-3 text-teal-700 dark:text-teal-400">
                <Play className="w-4 h-4 lg:w-5 lg:h-5" />
              </div>
              <p className="font-display text-xs lg:text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                9:16 Monitor
              </p>
            </div>
          )
        ) : activeProject.scenes.length === 0 ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center ${
              compactMobile ? "p-4 lg:p-8" : "p-8"
            }`}
          >
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#e7ecf8] dark:bg-[#141933] flex items-center justify-center mb-2.5 lg:mb-3 text-teal-700 dark:text-teal-400">
              <Play className="w-4 h-4 lg:w-5 lg:h-5" />
            </div>
            <p className="font-display text-xs lg:text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
              No clips kept
            </p>
            <p className="text-[11px] lg:text-xs text-[#4d597d] dark:text-[#919ec4] mt-1">
              Click Undo or Reset in the Timeline dock to restore clips
            </p>
          </div>
        ) : (
          <>
            {/* Top Video Window (Split mode for portrait ratios, full-frame for landscape/square or no subtitles) */}
            <div
              style={useSplitSubtitleLayout ? { height: `${topVideoHeightPct}%` } : undefined}
              className={`w-full bg-neutral-950 overflow-hidden ${
                useSplitSubtitleLayout ? "shrink-0" : "flex-1 h-full"
              }`}
            >
              <AppErrorBoundary fallbackLabel="Video preview error" compact>
                <ScenePlayer
                  ref={playerRef}
                  localUrl={activeProject.localUrl}
                  scenes={activeProject.scenes}
                  cutTime={subscribeCutTime ? 0 : safeCutTime}
                  getLiveCutTime={getLiveCutTime}
                  seekNonce={seekNonce}
                  isPlaying={isPlaying}
                  muted={muted}
                  voiceSettings={voiceSettings}
                  editSettings={editSettings}
                  onTimeUpdate={onTimeUpdate}
                  onPlayingChange={onPlayingChange}
                  onEnded={onEnded}
                />
              </AppErrorBoundary>
            </div>

            {/* Lower-Third Cinematic Subtitle Overlay (Scaled 1:1 with Logical Export Canvas) */}
            {useOverlaySubtitleLayout && activeSub && (() => {
              const fontMultiplier = resolveSubtitleFontMultiplier(editSettings);
              const fontStack = resolveSubtitleFontStack(editSettings.subtitleFontFamily);
              const theme = editSettings.subtitleTheme || "auto";
              const hl = editSettings.subtitleHighlightColor || "indigo";
              const cardStyle = editSettings.subtitleCardStyle || "card";
              const wordStyle = editSettings.subtitleWordStyle || "fill";
              const align = editSettings.subtitleAlign || "center";
              const lineSpacing = editSettings.subtitleLineSpacing || "normal";
              const cardRadius = Math.max(0, Math.min(28, editSettings.subtitleCardRadius ?? 18));
              const weightClass =
                editSettings.subtitleTextWeight === "bold"
                  ? "font-bold"
                  : editSettings.subtitleTextWeight === "normal"
                    ? "font-normal"
                    : "font-semibold";
              const showGloss = editSettings.showWordGloss !== false;
              const showBurmese = editSettings.showBurmeseLine !== false;
              const localElapsed = Math.max(0, highlightTime - activeSub.startTime);

              const activeWordBadgeClass = (() => {
                if (wordStyle === "underline") {
                  if (hl === "amber") return "text-amber-300 border-b-[3px] border-amber-400 rounded-none";
                  if (hl === "emerald") return "text-emerald-300 border-b-[3px] border-emerald-400 rounded-none";
                  if (hl === "rose") return "text-rose-300 border-b-[3px] border-rose-400 rounded-none";
                  return "text-teal-300 border-b-[3px] border-teal-400 rounded-none";
                }
                if (wordStyle === "glow") {
                  if (hl === "amber") return "bg-amber-400/28 text-amber-200 shadow-[0_0_16px_rgba(251,191,36,0.5)]";
                  if (hl === "emerald") return "bg-emerald-400/28 text-emerald-200 shadow-[0_0_16px_rgba(52,211,153,0.5)]";
                  if (hl === "rose") return "bg-rose-500/32 text-rose-100 shadow-[0_0_16px_rgba(244,63,94,0.55)]";
                  return "bg-teal-400/28 text-teal-100 shadow-[0_0_16px_rgba(78,126,247,0.55)]";
                }
                if (wordStyle === "text") {
                  if (hl === "amber") return "text-amber-400";
                  if (hl === "emerald") return "text-emerald-400";
                  if (hl === "rose") return "text-rose-400";
                  return "text-teal-300";
                }
                return hl === "amber"
                  ? "bg-amber-400 text-[#1c1917]"
                  : hl === "emerald"
                    ? "bg-emerald-400 text-[#052e16]"
                    : hl === "rose"
                      ? "bg-rose-500 text-white"
                      : "bg-teal-400 text-[#060918]";
              })();

              const isLightBox =
                (theme === "light" || theme === "warm") && cardStyle !== "minimal";
              const boxClass = (() => {
                if (cardStyle === "minimal") {
                  return "bg-transparent text-white drop-shadow-[0_3px_10px_rgba(0,0,0,0.92)]";
                }
                if (cardStyle === "outline") {
                  if (theme === "light") return "bg-white/95 text-[#0c1026] border-[3px] border-[#0c1026]";
                  if (theme === "warm") return "bg-[#fbf7ef]/95 text-[#1c1917] border-[3px] border-[#92400e]";
                  return "bg-[#070914]/90 text-white border-[3px] border-white/78";
                }
                if (cardStyle === "glass") {
                  if (theme === "light") return "bg-white/72 text-[#0c1026] border-[1.5px] border-white/75 backdrop-blur-md";
                  if (theme === "warm") return "bg-[#fbf7ef]/76 text-[#1c1917] border-[1.5px] border-[#e7dcc8]/85 backdrop-blur-md";
                  return "bg-[#090d22]/64 text-white border-[1.5px] border-white/28 backdrop-blur-md";
                }
                return theme === "light"
                  ? "bg-white/92 text-[#0c1026] border-[1.5px] border-[#d2dcf0]/90"
                  : theme === "warm"
                    ? "bg-[#fbf7ef]/94 text-[#1c1917] border-[1.5px] border-[#e7dcc8]/90"
                    : "bg-[#070914]/84 text-white border-[1.5px] border-white/16";
              })();

              const isPortraitOverlay = stageGeometry.aspect <= 0.85;
              const logicalBaseScale = Math.max(
                0.85,
                Math.min(1.2, stageGeometry.logicalWidth / (isPortraitOverlay ? 720 : 960))
              );
              const phoneticPx = Math.round(27 * fontMultiplier * logicalBaseScale);
              const glossPx = Math.round(18 * fontMultiplier * logicalBaseScale);
              const thaiPx = Math.round(21 * fontMultiplier * logicalBaseScale);
              const burmesePx = Math.round(23 * fontMultiplier * logicalBaseScale);
              const overlayRadius = Math.round(cardRadius * 0.9);
              const boxPadX = Math.round(22 * logicalBaseScale);
              const boxPadY = Math.round(
                (lineSpacing === "compact" ? 11 : lineSpacing === "relaxed" ? 18 : 14) *
                  logicalBaseScale
              );
              const wordGapX = Math.round(10 * logicalBaseScale);
              const wordGapY = Math.round(
                (lineSpacing === "compact" ? 6 : lineSpacing === "relaxed" ? 11 : 8) *
                  logicalBaseScale
              );
              const wordPadX = Math.round(8 * logicalBaseScale);
              const wordPadY = Math.round(3 * logicalBaseScale);
              const sectionGapY = Math.round(
                (lineSpacing === "compact" ? 6 : lineSpacing === "relaxed" ? 11 : 8) *
                  logicalBaseScale
              );
              const bottomMarginPx = Math.round(
                stageGeometry.logicalHeight * (isPortraitOverlay ? 0.055 : 0.04)
              );
              const scrimTopPadPx = Math.round(stageGeometry.logicalHeight * 0.1);

              return (
                <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
                  <div
                    style={{
                      width: `${stageGeometry.logicalWidth}px`,
                      height: `${stageGeometry.logicalHeight}px`,
                      transform: `scale(${stageScale}) translateZ(0)`,
                      transformOrigin: "top left",
                    }}
                    className="absolute top-0 left-0 flex flex-col justify-end items-center"
                  >
                    <div
                      style={{
                        paddingLeft: "28px",
                        paddingRight: "28px",
                        paddingTop: `${scrimTopPadPx}px`,
                        paddingBottom: `${bottomMarginPx}px`,
                      }}
                      className="w-full bg-gradient-to-t from-black/75 via-black/32 to-transparent flex justify-center"
                    >
                      <button
                        type="button"
                        onClick={() => onSelectSubtitle?.(activeSub.id, activeSub.startTime)}
                        style={{
                          fontFamily: fontStack,
                          borderRadius: cardStyle === "minimal" ? "0px" : `${overlayRadius}px`,
                          padding: `${boxPadY}px ${boxPadX}px`,
                          maxWidth: "92%",
                        }}
                        className={`pointer-events-auto shadow-xl cursor-pointer transition-colors ${
                          align === "left" ? "text-left" : "text-center"
                        } ${boxClass}`}
                      >
                        <div
                          style={{
                            columnGap: `${wordGapX}px`,
                            rowGap: `${wordGapY}px`,
                          }}
                          className={`flex flex-wrap items-start ${
                            align === "left" ? "justify-start" : "justify-center"
                          }`}
                        >
                          {activeSub.words.map((word, wi) => {
                            const isLastWord = wi === activeSub.words.length - 1;
                            const isWordSpoken =
                              localElapsed >= word.startOffsetSec &&
                              (isLastWord
                                ? localElapsed <= word.endOffsetSec
                                : localElapsed < word.endOffsetSec);
                            return (
                              <span
                                key={`${activeSub.id}-ov-${wi}`}
                                className={`inline-flex flex-col ${
                                  align === "left" ? "items-start" : "items-center"
                                }`}
                              >
                                <span
                                  style={{
                                    fontSize: `${phoneticPx}px`,
                                    lineHeight: 1.24,
                                    padding: `${wordPadY}px ${wordPadX}px`,
                                    borderRadius: wordStyle === "underline" ? "0px" : "7px",
                                  }}
                                  className={`${weightClass} ${
                                    isWordSpoken
                                      ? activeWordBadgeClass
                                      : isLightBox
                                        ? "text-[#0c1026]"
                                        : "text-white"
                                  }`}
                                >
                                  {word.phonetic}
                                </span>
                                {showGloss && word.burmeseGloss && (
                                  <span
                                    style={{
                                      fontSize: `${glossPx}px`,
                                      lineHeight: 1.25,
                                      marginTop: "4px",
                                    }}
                                    className={`font-myanmar ${
                                      isLightBox ? "text-[#4d597d]" : "text-white/78"
                                    }`}
                                  >
                                    {word.burmeseGloss}
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>

                        {editSettings.showThaiScript && activeSub.thaiScript && (
                          <p
                            style={{
                              fontSize: `${thaiPx}px`,
                              lineHeight: 1.35,
                              marginTop: `${sectionGapY}px`,
                              fontFamily: "'Noto Sans Thai', 'DM Sans', sans-serif",
                            }}
                            className={isLightBox ? "text-[#4d597d]" : "text-white/84"}
                          >
                            {activeSub.thaiScript}
                          </p>
                        )}

                        {showBurmese && activeSub.burmese && (
                          <p
                            style={{
                              fontSize: `${burmesePx}px`,
                              lineHeight: 1.4,
                              marginTop: `${sectionGapY}px`,
                            }}
                            className={`font-myanmar font-medium ${
                              isLightBox ? "text-[#1e293b]" : "text-white/96"
                            }`}
                          >
                            {activeSub.burmese}
                          </p>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Visual 35% Snap Guide & Draggable Video/Caption Split Handle (Portrait Split Mode) */}
            {useSplitSubtitleLayout && onChangeVideoHeightPct && (
              <>
                {isDraggingSplit && (
                  <div
                    aria-hidden="true"
                    style={{ top: `${snapGuideTopPct}%` }}
                    className={`pointer-events-none absolute inset-x-0 z-20 border-t border-dashed transition-colors ${
                      isSplitSnapped
                        ? "border-amber-500 dark:border-amber-300"
                        : "border-teal-600/55 dark:border-teal-400/55"
                    }`}
                  />
                )}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="Adjust top video height percentage (26% to 52%, double-click for 35%)"
                  aria-orientation="vertical"
                  aria-valuemin={26}
                  aria-valuemax={52}
                  aria-valuenow={Math.round(clampedHeightPct)}
                  title="Drag up/down to adjust video height (26%–52%) · Double-click for 35%"
                  style={{ top: `${topVideoHeightPct}%` }}
                  onPointerDown={handleSplitPointerDown}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onChangeVideoHeightPct(35);
                  }}
                  onKeyDown={handleSplitKeyDown}
                  className="group absolute inset-x-0 -translate-y-1/2 h-4 z-30 flex items-center justify-center cursor-ns-resize touch-none select-none focus-visible:outline-none"
                >
                  <span
                    className={`h-1 rounded-full transition-all shadow-xs ${
                      isDraggingSplit
                        ? isSplitSnapped
                          ? "w-14 bg-amber-500 dark:bg-amber-300"
                          : "w-14 bg-teal-600 dark:bg-teal-400"
                        : "w-9 bg-[#94a3b8]/85 dark:bg-[#4b588c]/85 group-hover:w-12 group-hover:bg-teal-600 dark:group-hover:bg-teal-400 group-focus-visible:w-14 group-focus-visible:bg-teal-600"
                    }`}
                  />
                  {isDraggingSplit && (
                    <span
                      className={`pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm ${
                        isSplitSnapped
                          ? "bg-amber-500 text-[#0c1026] dark:bg-amber-300"
                          : "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                      }`}
                    >
                      {isSplitSnapped ? "35% · Snap" : `${Math.round(clampedHeightPct)}%`}
                    </span>
                  )}
                </div>
              </>
            )}

            {/* Bottom Scrolling List Item View — portrait split-screen subtitle layout */}
            {useSplitSubtitleLayout && (() => {
              const fontMultiplier = resolveSubtitleFontMultiplier(editSettings);
              const fontStack = resolveSubtitleFontStack(editSettings.subtitleFontFamily);
              const theme = editSettings.subtitleTheme || "auto";
              const hl = editSettings.subtitleHighlightColor || "indigo";
              const cardStyle = editSettings.subtitleCardStyle || "card";
              const wordStyle = editSettings.subtitleWordStyle || "fill";
              const align = editSettings.subtitleAlign || "left";
              const isCentered = align === "center";
              const cardRadius = Math.max(0, Math.min(28, editSettings.subtitleCardRadius ?? 18));
              const spacingMode = editSettings.subtitleLineSpacing || "normal";
              const cardGapPx = spacingMode === "compact" ? 10 : spacingMode === "relaxed" ? 26 : 18;
              const cardPadY = spacingMode === "compact" ? 11 : spacingMode === "relaxed" ? 24 : 18;
              const weightClass =
                editSettings.subtitleTextWeight === "bold"
                  ? "font-bold"
                  : editSettings.subtitleTextWeight === "normal"
                    ? "font-normal"
                    : "font-semibold";
              const showGloss = editSettings.showWordGloss !== false;
              const showBurmese = editSettings.showBurmeseLine !== false;

              const containerThemeClass =
                theme === "light"
                  ? "bg-[#f8faff]"
                  : theme === "dark"
                    ? "bg-[#080b1a]"
                    : theme === "warm"
                      ? "bg-[#fbf7ef]"
                      : "bg-[#f8faff] dark:bg-[#080b1a]";

              const topDividerClass =
                theme === "light"
                  ? "border-t border-[#d2dcf0]"
                  : theme === "dark"
                    ? "border-t border-[#21284c]"
                    : theme === "warm"
                      ? "border-t border-[#e7dcc8]"
                      : "border-t border-[#d2dcf0] dark:border-[#21284c]";

              const getCardThemeClass = (isActive: boolean) => {
                if (cardStyle === "minimal") {
                  if (theme === "light") {
                    return isActive ? "bg-transparent border-b border-[#8da2ea]/55" : "bg-transparent opacity-60";
                  }
                  if (theme === "dark") {
                    return isActive ? "bg-transparent border-b border-[#4e7ef7]/45" : "bg-transparent opacity-55";
                  }
                  if (theme === "warm") {
                    return isActive ? "bg-transparent border-b border-[#dfae52]/60" : "bg-transparent opacity-60";
                  }
                  return isActive
                    ? "bg-transparent border-b border-[#8da2ea]/55 dark:border-[#4e7ef7]/45"
                    : "bg-transparent opacity-60";
                }
                if (cardStyle === "outline") {
                  if (theme === "light") {
                    return isActive
                      ? "bg-white border-[3px] border-[#0c1026]"
                      : "bg-white/60 border-2 border-[#bcc9e6]";
                  }
                  if (theme === "dark") {
                    return isActive
                      ? "bg-[#0c112b] border-[3px] border-white/85"
                      : "bg-[#0a0f24]/60 border-2 border-[#2f3a6e]";
                  }
                  if (theme === "warm") {
                    return isActive
                      ? "bg-[#fffdf8] border-[3px] border-[#92400e]"
                      : "bg-[#f4ede0]/60 border-2 border-[#d6c5a7]";
                  }
                  return isActive
                    ? "bg-white dark:bg-[#0c112b] border-[3px] border-[#0c1026] dark:border-white/85"
                    : "bg-white/60 dark:bg-[#0a0f24]/60 border-2 border-[#bcc9e6] dark:border-[#2f3a6e]";
                }
                if (cardStyle === "glass") {
                  if (theme === "light") {
                    return isActive
                      ? "bg-white/75 backdrop-blur-md border border-white shadow-[0_6px_22px_rgba(28,61,184,0.12)]"
                      : "bg-white/45 backdrop-blur-xs border border-[#dce4f5]";
                  }
                  if (theme === "dark") {
                    return isActive
                      ? "bg-[#17214d]/72 backdrop-blur-md border border-[#6e96ff]/40 shadow-[0_8px_26px_rgba(0,0,0,0.45)]"
                      : "bg-[#0e1430]/50 backdrop-blur-xs border border-white/10";
                  }
                  if (theme === "warm") {
                    return isActive
                      ? "bg-[#fffaf0]/80 backdrop-blur-md border border-[#dfae52]/65 shadow-[0_6px_20px_rgba(180,83,9,0.12)]"
                      : "bg-[#f4ede0]/55 backdrop-blur-xs border border-[#e5dac6]";
                  }
                  return isActive
                    ? "bg-white/75 dark:bg-[#17214d]/72 backdrop-blur-md border border-white dark:border-[#6e96ff]/40 shadow-[0_6px_22px_rgba(28,61,184,0.12)] dark:shadow-[0_8px_26px_rgba(0,0,0,0.45)]"
                    : "bg-white/45 dark:bg-[#0e1430]/50 backdrop-blur-xs border border-[#dce4f5] dark:border-white/10";
                }
                if (theme === "light") {
                  return isActive
                    ? "bg-white border-2 border-[#8da2ea]"
                    : "bg-white/75 border border-[#e2e8f5] hover:border-[#8da2ea]";
                }
                if (theme === "dark") {
                  return isActive
                    ? "bg-[#12183a] border-2 border-[#4e7ef7]/50"
                    : "bg-[#0d1229]/72 border border-[#1e264a] hover:border-[#4e7ef7]/35";
                }
                if (theme === "warm") {
                  return isActive
                    ? "bg-[#fffdf8] border-2 border-[#dfae52]"
                    : "bg-[#f4ede0]/72 border border-[#e5dac6] hover:border-[#dfae52]";
                }
                return isActive
                  ? "bg-white dark:bg-[#12183a] border-2 border-[#8da2ea] dark:border-[#4e7ef7]/50"
                  : "bg-white/75 dark:bg-[#0d1229]/72 border border-[#e2e8f5] dark:border-[#1e264a] hover:border-[#8da2ea] dark:hover:border-[#4e7ef7]/35";
              };

              const getAccentBarClass = (isActive: boolean) => {
                if (theme === "warm") {
                  return isActive ? "bg-[#b86310]" : "bg-[#dfd3be]";
                }
                if (theme === "light") {
                  return isActive ? "bg-[#1c3db8]" : "bg-[#e2e8f5]";
                }
                if (theme === "dark") {
                  return isActive ? "bg-[#5b85f7]" : "bg-[#1e264a]";
                }
                return isActive
                  ? "bg-[#1c3db8] dark:bg-[#5b85f7]"
                  : "bg-[#e2e8f5] dark:bg-[#1e264a]";
              };

              const spokenPillClass = (() => {
                if (wordStyle === "underline") {
                  if (hl === "emerald") {
                    if (theme === "dark") return "text-[#43b892] border-b-[3px] border-[#43b892] rounded-none";
                    if (theme === "light" || theme === "warm") return "text-[#0d7456] border-b-[3px] border-[#0d7456] rounded-none";
                    return "text-[#0d7456] dark:text-[#43b892] border-b-[3px] border-[#0d7456] dark:border-[#43b892] rounded-none";
                  }
                  if (hl === "indigo") {
                    if (theme === "dark") return "text-[#7ca3fb] border-b-[3px] border-[#5b85f7] rounded-none";
                    if (theme === "light" || theme === "warm") return "text-[#1c3db8] border-b-[3px] border-[#1c3db8] rounded-none";
                    return "text-[#1c3db8] dark:text-[#7ca3fb] border-b-[3px] border-[#1c3db8] dark:border-[#5b85f7] rounded-none";
                  }
                  if (hl === "rose") {
                    if (theme === "dark") return "text-[#f472b6] border-b-[3px] border-[#e879f9] rounded-none";
                    if (theme === "light" || theme === "warm") return "text-[#9d174d] border-b-[3px] border-[#be185d] rounded-none";
                    return "text-[#9d174d] dark:text-[#f472b6] border-b-[3px] border-[#be185d] dark:border-[#e879f9] rounded-none";
                  }
                  if (theme === "dark") return "text-[#fbbf24] border-b-[3px] border-[#fbbf24] rounded-none";
                  if (theme === "light" || theme === "warm") return "text-[#b45309] border-b-[3px] border-[#d97706] rounded-none";
                  return "text-[#b45309] dark:text-[#fbbf24] border-b-[3px] border-[#d97706] dark:border-[#fbbf24] rounded-none";
                }
                if (wordStyle === "glow") {
                  if (hl === "emerald") {
                    return "bg-emerald-500/22 text-emerald-700 dark:text-emerald-200 ring-1 ring-emerald-500/45 shadow-[0_0_14px_rgba(16,185,129,0.4)]";
                  }
                  if (hl === "indigo") {
                    return "bg-[#355feb]/22 text-[#1c3db8] dark:text-[#a8c3fa] ring-1 ring-[#4e7ef7]/50 shadow-[0_0_14px_rgba(78,126,247,0.45)]";
                  }
                  if (hl === "rose") {
                    return "bg-rose-500/22 text-rose-700 dark:text-rose-200 ring-1 ring-rose-500/45 shadow-[0_0_14px_rgba(244,63,94,0.42)]";
                  }
                  return "bg-amber-500/22 text-amber-800 dark:text-amber-200 ring-1 ring-amber-500/45 shadow-[0_0_14px_rgba(245,158,11,0.42)]";
                }
                if (wordStyle === "text") {
                  if (hl === "emerald") {
                    if (theme === "dark") return "text-[#34d399]";
                    if (theme === "light" || theme === "warm") return "text-[#059669]";
                    return "text-[#059669] dark:text-[#34d399]";
                  }
                  if (hl === "indigo") {
                    if (theme === "dark") return "text-[#7ca3fb]";
                    if (theme === "light" || theme === "warm") return "text-[#1c3db8]";
                    return "text-[#1c3db8] dark:text-[#7ca3fb]";
                  }
                  if (hl === "rose") {
                    if (theme === "dark") return "text-[#fb7185]";
                    if (theme === "light" || theme === "warm") return "text-[#be123c]";
                    return "text-[#be123c] dark:text-[#fb7185]";
                  }
                  if (theme === "dark") return "text-[#fbbf24]";
                  if (theme === "light" || theme === "warm") return "text-[#b45309]";
                  return "text-[#b45309] dark:text-[#fbbf24]";
                }
                if (hl === "emerald") {
                  if (theme === "dark") return "bg-[#127d5c] text-[#ffffff]";
                  if (theme === "light" || theme === "warm") return "bg-[#0d7456] text-[#ffffff]";
                  return "bg-[#0d7456] dark:bg-[#127d5c] text-[#ffffff]";
                }
                if (hl === "indigo") {
                  if (theme === "dark") return "bg-[#2952d6] text-[#ffffff]";
                  if (theme === "light" || theme === "warm") return "bg-[#1c3db8] text-[#ffffff]";
                  return "bg-[#1c3db8] dark:bg-[#2952d6] text-[#ffffff]";
                }
                if (hl === "rose") {
                  if (theme === "dark") return "bg-[#a12f88] text-[#ffffff]";
                  if (theme === "light" || theme === "warm") return "bg-[#8b2574] text-[#ffffff]";
                  return "bg-[#8b2574] dark:bg-[#a12f88] text-[#ffffff]";
                }
                if (theme === "dark") return "bg-[#cc801a] text-[#0f172a]";
                if (theme === "light" || theme === "warm") return "bg-[#b0580c] text-[#ffffff]";
                return "bg-[#b0580c] dark:bg-[#cc801a] text-[#ffffff] dark:text-[#0f172a]";
              })();

              const getWordClass = (isWordSpoken: boolean, isActive: boolean, wasWordSpoken: boolean) => {
                if (isWordSpoken) return spokenPillClass;
                if (isActive) {
                  if (wasWordSpoken) {
                    if (theme === "dark") return "text-[#8cb5f5]";
                    if (theme === "warm") return "text-[#944808]";
                    if (theme === "light") return "text-[#1938a8]";
                    return "text-[#1938a8] dark:text-[#8cb5f5]";
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
                    if (theme === "dark") return "text-[#43b892] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#0b664b] font-medium";
                    return "text-[#0b664b] dark:text-[#43b892] font-medium";
                  }
                  if (hl === "indigo") {
                    if (theme === "dark") return "text-[#80a6ff] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#1836a3] font-medium";
                    return "text-[#1836a3] dark:text-[#80a6ff] font-medium";
                  }
                  if (hl === "rose") {
                    if (theme === "dark") return "text-[#e386cf] font-medium";
                    if (theme === "light" || theme === "warm") return "text-[#7d1e68] font-medium";
                    return "text-[#7d1e68] dark:text-[#e386cf] font-medium";
                  }
                  if (theme === "dark") return "text-[#e5a64e] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#9c4b08] font-medium";
                  return "text-[#9c4b08] dark:text-[#e5a64e] font-medium";
                }
                if (isActive) {
                  if (theme === "dark") return "text-[#6c97f8] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#1c3db8] font-medium";
                  return "text-[#1c3db8] dark:text-[#6c97f8] font-medium";
                }
                if (theme === "dark") return "text-[#515e87] font-medium";
                if (theme === "warm") return "text-[#a8a29e] font-medium";
                if (theme === "light") return "text-[#94a3b8] font-medium";
                return "text-[#94a3b8] dark:text-[#515e87] font-medium";
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
                  return isActive ? "border-[#ebd197]" : "border-[#e7dcc8]";
                }
                if (theme === "dark") {
                  return isActive ? "border-[#4e7ef7]/28" : "border-[#1e264a]";
                }
                if (theme === "light") {
                  return isActive ? "border-[#d3dff8]" : "border-[#f1f5f9]";
                }
                return isActive
                  ? "border-[#d3dff8] dark:border-[#4e7ef7]/28"
                  : "border-[#f1f5f9] dark:border-[#1e264a]";
              };

              const getIndexClass = (isActive: boolean) => {
                if (isActive) {
                  if (theme === "warm") return "text-[#a3550b]";
                  if (theme === "dark") return "text-[#5b85f7]";
                  if (theme === "light") return "text-[#1c3db8]";
                  return "text-[#1c3db8] dark:text-[#5b85f7]";
                }
                if (theme === "dark") return "text-[#515e87]";
                if (theme === "warm") return "text-[#a8a29e]";
                if (theme === "light") return "text-[#94a3b8]";
                return "text-[#94a3b8] dark:text-[#515e87]";
              };

              const getBurmeseClass = (isActive: boolean) => {
                if (isActive) {
                  if (theme === "dark") return "text-[#99b8ff] font-medium";
                  if (theme === "light" || theme === "warm") return "text-[#122b87] font-medium";
                  return "text-[#122b87] dark:text-[#99b8ff] font-medium";
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
                  ref={subPanelRef}
                  style={{ transform: "translateZ(0)", contain: "layout paint" }}
                  className={`relative flex-1 w-full overflow-hidden ${topDividerClass} ${containerThemeClass}`}
                >
                  <div
                    ref={listContainerRef}
                    style={{
                      width: `${stageGeometry.logicalWidth}px`,
                      height: `${exportListH}px`,
                      transform: `scale(${stageScale}) translateZ(0)`,
                      transformOrigin: "top left",
                      padding: "34px 22px 0 22px",
                      gap: `${cardGapPx}px`,
                      fontFamily: fontStack,
                    }}
                    className={`absolute top-0 left-0 flex flex-col overflow-y-auto overflow-x-hidden no-scrollbar ${containerThemeClass}`}
                  >
                    {subtitles.map((sub, subIdx) => {
                      const isActive = activeSub?.id === sub.id;
                      const isStageSelected = selectedSubtitleId === sub.id;
                      const localElapsed = Math.max(0, highlightTime - sub.startTime);

                      return (
                        <button
                          key={sub.id}
                          ref={(node) => {
                            itemRefs.current[sub.id] = node;
                          }}
                          type="button"
                          aria-pressed={isStageSelected}
                          onPointerDown={(e) => {
                            if (e.button !== 0 && e.pointerType === "mouse") return;
                            suppressNextCardClickIdRef.current = null;
                            cardPointerDownRef.current = {
                              id: sub.id,
                              clientX: e.clientX,
                              clientY: e.clientY,
                              at: performance.now(),
                            };
                          }}
                          onPointerUp={(e) => {
                            const down = cardPointerDownRef.current;
                            cardPointerDownRef.current = null;
                            if (!down || down.id !== sub.id) return;
                            const dx = e.clientX - down.clientX;
                            const dy = e.clientY - down.clientY;
                            const durationMs = performance.now() - down.at;
                            suppressNextCardClickIdRef.current = sub.id;
                            if (isStageCleanClick(dx, dy, durationMs)) {
                              if (onSelectSubtitle) {
                                onSelectSubtitle(sub.id, sub.startTime);
                              } else {
                                onSeek(sub.startTime);
                              }
                            }
                          }}
                          onPointerCancel={() => {
                            cardPointerDownRef.current = null;
                          }}
                          onClick={(e) => {
                            if (suppressNextCardClickIdRef.current === sub.id) {
                              suppressNextCardClickIdRef.current = null;
                              return;
                            }
                            if (e.detail === 0) {
                              if (onSelectSubtitle) {
                                onSelectSubtitle(sub.id, sub.startTime);
                              } else {
                                onSeek(sub.startTime);
                              }
                            }
                          }}
                          style={{
                            borderRadius: cardStyle === "minimal" ? "0px" : `${cardRadius}px`,
                            padding:
                              cardStyle === "minimal"
                                ? `${cardPadY}px 18px`
                                : isCentered
                                  ? `${cardPadY}px 26px`
                                  : `${cardPadY}px 26px ${cardPadY + 2}px 32px`,
                          }}
                          className={`relative w-full shrink-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1c3db8] dark:focus-visible:ring-[#4e7ef7] ${
                            isCentered ? "text-center" : "text-left"
                          } ${getCardThemeClass(
                            isActive
                          )} ${
                            isStageSelected
                              ? "ring-2 ring-amber-500/90 dark:ring-amber-300/90 shadow-md"
                              : ""
                          }`}
                        >
                          {/* Accent Bar (shown in default card style when left-aligned) */}
                          {cardStyle === "card" && !isCentered && (
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
                          )}

                          {/* Line 1: Thai in English phonetics with word-by-word sync */}
                          <div
                            style={{
                              columnGap: "8px",
                              rowGap: `${Math.round(10 * fontMultiplier)}px`,
                            }}
                            className={`flex flex-wrap items-start ${
                              isCentered ? "justify-center" : "justify-start"
                            }`}
                          >
                            {(Array.isArray(sub.words) ? sub.words : []).map((word, wi, wordsArr) => {
                              const isLastWord = wi === wordsArr.length - 1;
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
                                  className={`inline-flex flex-col max-w-full ${
                                    isCentered ? "items-center" : "items-start"
                                  }`}
                                >
                                  <span
                                    style={{
                                      fontSize: `${phoneticPx}px`,
                                      padding: `${Math.round(4 * fontMultiplier)}px ${Math.round(
                                        9 * fontMultiplier
                                      )}px`,
                                      borderRadius: wordStyle === "underline" ? "0px" : "9px",
                                      lineHeight: 1.2,
                                    }}
                                    className={`${weightClass} tracking-tight max-w-full break-words ${getWordClass(
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
                                        paddingLeft: isCentered ? "0px" : `${Math.round(9 * fontMultiplier)}px`,
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
                                paddingLeft: isCentered ? "0px" : "4px",
                                fontSize: `${thaiPx}px`,
                                fontFamily: "'Noto Sans Thai', 'DM Sans', sans-serif",
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
                              className={`border-t flex items-baseline ${
                                isCentered ? "justify-center" : "justify-start"
                              } ${getDividerClass(isActive)}`}
                            >
                              {!isCentered && (
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
                              )}
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
                      style={{ height: `${Math.max(160, exportListH)}px` }}
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

      {/* Standalone Preview Resize Drag Bar + Compact Aspect Ratio Switcher */}
      {(onChangePreviewScale || (activeProject && onChangeAspectRatio)) && (
        <div
          role={onChangePreviewScale ? "slider" : undefined}
          tabIndex={onChangePreviewScale ? 0 : undefined}
          aria-label={
            onChangePreviewScale
              ? "Resize video preview (drag up to shrink, down to enlarge, double-click for 100%)"
              : undefined
          }
          aria-orientation={onChangePreviewScale ? "vertical" : undefined}
          aria-valuemin={onChangePreviewScale ? 0 : undefined}
          aria-valuemax={onChangePreviewScale ? 200 : undefined}
          aria-valuenow={onChangePreviewScale ? Math.round(clampedScale * 100) : undefined}
          title={
            onChangePreviewScale
              ? "Drag up to shrink · Drag down to enlarge (up to 200%) · Double-click for 100%"
              : undefined
          }
          onPointerDown={onChangePreviewScale ? handleDragPointerDown : undefined}
          onTouchStart={onChangePreviewScale ? handleDragTouchStart : undefined}
          onDoubleClick={onChangePreviewScale ? handleDragDoubleClick : undefined}
          onKeyDown={onChangePreviewScale ? handleDragKeyDown : undefined}
          className={`relative group w-full h-6 flex items-center justify-center ${
            onChangePreviewScale ? "cursor-ns-resize touch-none" : ""
          } select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
            compactMobile && !hasTransportBar
              ? "border-b border-[#d2dcf0] dark:border-[#21284c]"
              : ""
          }`}
        >
          {/* Left: Compact Aspect Ratio Switcher */}
          {activeProject && onChangeAspectRatio && (
            <div
              ref={ratioMenuRef}
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="absolute left-3 z-30 flex items-center"
            >
              <button
                type="button"
                onClick={() => setShowRatioMenu((v) => !v)}
                aria-expanded={showRatioMenu}
                aria-haspopup="menu"
                title="Change video aspect ratio"
                className={`h-5 px-1.5 rounded-sm border text-[10px] font-mono-tabular font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                  showRatioMenu || (editSettings.aspectRatio && editSettings.aspectRatio !== "original")
                    ? "border-teal-600/60 dark:border-teal-400/60 bg-teal-50/90 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300"
                    : "border-[#d2dcf0]/80 dark:border-[#21284c] bg-white/80 dark:bg-[#0d1022]/85 text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                <Ratio className="w-2.5 h-2.5 shrink-0" />
                <span>{stageGeometry.activeLabel}</span>
                <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-75" />
              </button>

              {showRatioMenu && (
                <div
                  role="menu"
                  aria-label="Aspect ratio presets"
                  className="absolute bottom-full left-0 mb-1.5 p-1.5 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white/98 dark:bg-[#0d1022]/98 shadow-lg backdrop-blur-sm flex flex-wrap items-center gap-1 w-max max-w-[calc(100vw-24px)] sm:max-w-[390px] z-40"
                >
                  {VIDEO_ASPECT_RATIO_OPTIONS.map((opt) => {
                    const active = (editSettings.aspectRatio || "original") === opt.id;
                    const optGeom = resolveStageCanvasGeometry(opt.id, detectedVideoDims);
                    const isTall916 = opt.id === "9:16" || opt.id === "9:16-overlay";
                    const isTall45 = opt.id === "4:5" || opt.id === "4:5-overlay";
                    const isPortraitVariant = isTall916 || isTall45;
                    const iconStyle = isTall916
                      ? "w-2.5 h-4"
                      : opt.id === "16:9"
                        ? "w-4 h-2.5"
                        : opt.id === "1:1"
                          ? "w-3 h-3"
                          : isTall45
                            ? "w-3 h-3.5"
                            : optGeom.aspect > 1.1
                              ? "w-4 h-2.5"
                              : optGeom.aspect < 0.9
                                ? "w-2.5 h-4"
                                : "w-3 h-3";
                    const showModeBadge = isPortraitVariant || hasSubtitles;
                    const modeBadgeText = optGeom.isPortraitSplitFriendly ? "Scroll" : "Overlay";

                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          onChangeAspectRatio(opt.id);
                          setShowRatioMenu(false);
                        }}
                        className={`h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                          active
                            ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918] font-semibold"
                            : "text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#f3f5fc] dark:hover:bg-[#141933]"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`relative rounded-[2px] border border-current shrink-0 overflow-hidden ${iconStyle}`}
                        >
                          {isPortraitVariant && optGeom.isPortraitSplitFriendly && (
                            <span className="absolute inset-x-0 top-[40%] h-[1px] bg-current opacity-80" />
                          )}
                          {isPortraitVariant && !optGeom.isPortraitSplitFriendly && (
                            <span className="absolute inset-x-[1.5px] bottom-[2px] h-[2px] rounded-[0.5px] bg-current opacity-85" />
                          )}
                        </span>
                        <span>
                          {opt.id === "original" && stageGeometry.detectedRatioLabel
                            ? `Original · ${stageGeometry.detectedRatioLabel}`
                            : opt.label}
                        </span>
                        {showModeBadge && (
                          <span className="text-[9px] opacity-75">
                            {modeBadgeText}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {onChangePreviewScale && (
            <>
              <span
                className={`h-1 rounded-full transition-all ${
                  isResizing
                    ? "w-16 bg-teal-700 dark:bg-teal-400"
                    : "w-10 bg-[#b8c2d0] dark:bg-[#2f3866] group-hover:w-14 group-hover:bg-teal-700/80 dark:group-hover:bg-teal-400/80"
                }`}
              />
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChangePreviewScale(DEFAULT_STAGE_PREVIEW_SCALE);
                }}
                title="Reset preview size to 100%"
                className={`absolute right-3 text-[10px] font-mono-tabular transition-colors cursor-pointer ${
                  Math.abs(clampedScale - DEFAULT_STAGE_PREVIEW_SCALE) >= 0.02
                    ? "text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                    : "text-[#64748b] dark:text-[#7c89b0]"
                }`}
              >
                {Math.round(clampedScale * 100)}%
              </button>
              {isResizing && (
                <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918] text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm">
                  {scaleLabel} · {Math.round(clampedScale * 100)}%
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Separate 9:16 Playback Controls Row */}
      {hasTransportBar && (
        <div
          className={`w-full flex items-center ${
            compactMobile
              ? "gap-2 lg:gap-2.5 border-t border-b rounded-none px-3.5 py-2"
              : "gap-2.5 border rounded-lg px-3 py-2"
          } border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022]`}
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
              compactMobile ? "w-8 h-8 lg:w-9 lg:h-9" : "w-9 h-9"
            } rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
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
              onChange={(e) => {
                const next = parseFloat(e.target.value);
                if (Number.isFinite(next)) onSeek(next);
              }}
              aria-label="Timeline scrubber"
              className="w-full h-1.5 rounded-full appearance-none bg-[#d2dcf0] dark:bg-[#21284c] cursor-pointer"
            />
            <div className="flex items-center justify-between text-[11px] text-[#4d597d] dark:text-[#919ec4] font-mono-tabular">
              <span ref={timeTextRef} className="truncate" />
              <span ref={pctTextRef} className="shrink-0 ml-1" />
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Unmute original audio" : "Mute original audio"}
            className={`${
              compactMobile ? "w-8 h-8 lg:w-9 lg:h-9" : "w-9 h-9"
            } rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
});
