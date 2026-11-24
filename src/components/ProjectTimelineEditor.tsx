import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
import {
  ChevronDown,
  ChevronUp,
  Film,
  List,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { SpeechRegion, SpeakingScene, SubtitleItem, VideoProject } from "../types";
import { ensureSceneIds, roundTenth } from "../utils/projectTimeline";
import {
  projectSpeechRegionsToCutTimeline,
  type CutSpeechRegion,
} from "../utils/audioSpeechAnalyzer";
import { findUnmatchedSpeechGaps, suggestTranscribeRange } from "../utils/subtitleState";
import { hasVerticalScrollRoom, scrollVerticalAncestors } from "../utils/timelineScroll";

interface ProjectTimelineEditorProps {
  project: VideoProject | null;
  cutTime: number;
  subscribeCutTime?: (listener: (sec: number) => void) => () => void;
  isPlaying: boolean;
  isActive?: boolean;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (sec: number) => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateScenes: (nextScenes: SpeakingScene[]) => void;
  onUpdateSubtitleTiming?: (id: string, startTime: number, endTime: number) => void;
  onShiftAllSubtitles?: (deltaSec: number) => void;
  onTranscribeRange?: (
    startSec: number,
    endSec: number
  ) => Promise<{ addedCount: number; message?: string } | void>;
  transcribingRange?: { startSec: number; endSec: number } | null;
  onRestoreSnapshot: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onGoToScenes?: () => void;
  dockMode?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  cutSpeechRegions?: CutSpeechRegion[];
}

interface ClipSegment {
  scene: SpeakingScene;
  sceneId: string;
  index: number;
  startSec: number;
  endSec: number;
  clipDur: number;
  cutStart: number;
  cutEnd: number;
}

interface UndoEntry {
  scenes: SpeakingScene[];
  subtitles: SubtitleItem[];
}

type DragMode =
  | {
      type: "scrub";
      pointerType: string;
      startClientX: number;
      startClientY: number;
      lastClientY: number;
      startCutTime: number;
      axis: "x" | "y" | "pending";
    }
  | {
      type: "trim-start";
      sceneId: string;
      startClientX: number;
      origStartSec: number;
      origEndSec: number;
      origCutStart: number;
    }
  | {
      type: "trim-end";
      sceneId: string;
      startClientX: number;
      origStartSec: number;
      origEndSec: number;
      origCutStart: number;
    }
  | {
      type: "sub-move";
      subId: string;
      subIndex: number;
      startClientX: number;
      origStartTime: number;
      origEndTime: number;
    }
  | {
      type: "sub-trim-start";
      subId: string;
      subIndex: number;
      startClientX: number;
      origStartTime: number;
      origEndTime: number;
    }
  | {
      type: "sub-trim-end";
      subId: string;
      subIndex: number;
      startClientX: number;
      origStartTime: number;
      origEndTime: number;
    };

function formatTimePrecise(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  const wholeSecs = Math.floor(rem);
  const tenths = Math.floor((rem - wholeSecs) * 10);
  return `${mins}:${String(wholeSecs).padStart(2, "0")}.${tenths}`;
}

function formatRulerTick(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function clampZoom(z: number): number {
  return Math.max(10, Math.min(160, z));
}

export function ProjectTimelineEditor({
  project,
  cutTime,
  subscribeCutTime,
  isPlaying,
  isActive = true,
  onTogglePlay,
  onPause,
  onSeek,
  onPlayFromTime,
  onUpdateScenes,
  onUpdateSubtitleTiming,
  onShiftAllSubtitles,
  onTranscribeRange,
  transcribingRange = null,
  onRestoreSnapshot,
  onResetTimeline,
  onGoToScenes,
  dockMode = false,
  isCollapsed = false,
  onToggleCollapse,
  cutSpeechRegions: controlledCutSpeechRegions,
}: ProjectTimelineEditorProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackSlideRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const [showDockScenes, setShowDockScenes] = useState(false);
  const [showRangeFill, setShowRangeFill] = useState(false);
  const [rangeStartVal, setRangeStartVal] = useState("0");
  const [rangeEndVal, setRangeEndVal] = useState("3");
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);

  const [pxPerSec, setPxPerSec] = useState(32);
  const [viewportWidth, setViewportWidth] = useState(560);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [activeSubId, setActiveSubId] = useState<string | null>(null);
  const [dragSubPreview, setDragSubPreview] = useState<{
    id: string;
    startTime: number;
    endTime: number;
  } | null>(null);
  const [trimPreview, setTrimPreview] = useState<{
    sceneId: string;
    mode: "trim-start" | "trim-end";
    origStartSec: number;
    origEndSec: number;
    origCutStart: number;
    origCutEnd: number;
    nextStartSec: number;
    nextEndSec: number;
  } | null>(null);
  const [liveScrubCutTime, setLiveScrubCutTime] = useState<number | null>(null);
  const [frozenTrackTime, setFrozenTrackTime] = useState<number | null>(null);
  const [dragBadge, setDragBadge] = useState<{ label: string; sec: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [baselineSubRegions, setBaselineSubRegions] = useState<SpeechRegion[]>([]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  const dragStateRef = useRef<DragMode | null>(null);
  const windowDragCleanupRef = useRef<(() => void) | null>(null);
  const pointerMoveHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const updateDragState = useCallback((next: DragMode | null) => {
    dragStateRef.current = next;
  }, []);
  const liveScrubCutRef = useRef<number | null>(null);
  liveScrubCutRef.current = liveScrubCutTime;
  const frozenTrackTimeRef = useRef<number | null>(null);
  const wheelTargetCutRef = useRef<{ cutTime: number; expiresAt: number } | null>(null);
  const wheelClearTimerRef = useRef<number | null>(null);
  const dragSubPreviewRef = useRef<{
    id: string;
    startTime: number;
    endTime: number;
  } | null>(null);
  dragSubPreviewRef.current = dragSubPreview;
  const trimPreviewRef = useRef<{
    sceneId: string;
    mode: "trim-start" | "trim-end";
    origStartSec: number;
    origEndSec: number;
    origCutStart: number;
    origCutEnd: number;
    nextStartSec: number;
    nextEndSec: number;
  } | null>(null);
  trimPreviewRef.current = trimPreview;
  const lastDragTargetRef = useRef<{ cutTime: number; sourceSec: number } | null>(null);
  const trimPreUndoRef = useRef<UndoEntry | null>(null);
  const lastSeekDispatchAtRef = useRef<number>(0);
  const seekThrottleTimerRef = useRef<number | null>(null);
  const queuedSeekSecRef = useRef<number | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; pxPerSec: number } | null>(null);
  const tappedClipRef = useRef<{ sceneId: string; startX: number; moved: boolean } | null>(null);
  const tappedSubRef = useRef<{
    subId: string;
    startTime: number;
    startX: number;
    moved: boolean;
  } | null>(null);

  const normalizedScenes = useMemo(
    () => (project ? ensureSceneIds(project.scenes) : []),
    [project]
  );

  const sourceDuration = useMemo(() => {
    if (!project) return 1;
    const maxSceneEnd = normalizedScenes.reduce((m, s) => Math.max(m, s.endSec), 0);
    return Math.max(1, project.sourceDurationSec || 0, maxSceneEnd);
  }, [project, normalizedScenes]);

  const { segments, totalCutDuration } = useMemo(() => {
    const list: ClipSegment[] = [];
    let cursor = 0;
    normalizedScenes.forEach((sc, idx) => {
      const dur = Math.max(0.1, sc.endSec - sc.startSec);
      const cutStart = cursor;
      const cutEnd = cursor + dur;
      const sceneId = sc.id || `proj-sc-${idx}`;
      list.push({
        scene: sc,
        sceneId,
        index: idx,
        startSec: sc.startSec,
        endSec: sc.endSec,
        clipDur: dur,
        cutStart,
        cutEnd,
      });
      cursor = cutEnd;
    });
    return { segments: list, totalCutDuration: cursor };
  }, [normalizedScenes]);

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const normalizedScenesRef = useRef(normalizedScenes);
  normalizedScenesRef.current = normalizedScenes;
  const projectRef = useRef(project);
  projectRef.current = project;
  const totalCutDurationRef = useRef(totalCutDuration);
  totalCutDurationRef.current = totalCutDuration;
  const cutTimeRef = useRef(cutTime);
  cutTimeRef.current = cutTime;

  // Reset undo & drag state only when switching to a genuinely different source project
  const projectIdentity = project
    ? `${project.sourceType}:${project.videoId || ""}:${project.localUrl || ""}:${project.title}`
    : "none";

  useEffect(() => {
    frozenTrackTimeRef.current = null;
    setFrozenTrackTime(null);
    setLiveScrubCutTime(null);
    wheelTargetCutRef.current = null;
    activePointersRef.current.clear();
    pinchStartRef.current = null;
    updateDragState(null);
    trimPreviewRef.current = null;
    setTrimPreview(null);
    setDragSubPreview(null);
    setDragBadge(null);
    setActiveSceneId(null);
    setActiveSubId(null);
    setShowRangeFill(false);
    setRangeNotice(null);
    setBaselineSubRegions(
      project?.subtitles.map((s) => ({
        sourceStartSec: s.sourceStartSec,
        sourceEndSec: s.sourceEndSec,
      })) ?? []
    );
    setUndoStack([]);
  }, [projectIdentity]);

  // Capture initial subtitle baseline if project mounted with subtitles after identity init
  useEffect(() => {
    if (baselineSubRegions.length === 0 && project && project.subtitles.length > 0) {
      setBaselineSubRegions(
        project.subtitles.map((s) => ({
          sourceStartSec: s.sourceStartSec,
          sourceEndSec: s.sourceEndSec,
        }))
      );
    }
  }, [baselineSubRegions.length, project]);

  // Clear activeSceneId only if the previously selected scene was removed (never auto-select on load)
  useEffect(() => {
    if (segments.length === 0) {
      setActiveSceneId(null);
    } else if (activeSceneId && !segments.some((s) => s.sceneId === activeSceneId)) {
      setActiveSceneId(null);
    }
  }, [segments, activeSceneId]);

  // Clear activeSubId if the subtitle no longer exists
  useEffect(() => {
    if (activeSubId && !project?.subtitles.some((s) => s.id === activeSubId)) {
      setActiveSubId(null);
    }
  }, [project?.subtitles, activeSubId]);

  // Measure timeline viewport width so center playhead stays exact
  useEffect(() => {
    if (isCollapsed) return;
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setViewportWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [projectIdentity, isCollapsed]);

  // Capture filmstrip frames for local videos; fallback thumbnail for YouTube
  useEffect(() => {
    if (!project) {
      setThumbnails([]);
      return;
    }

    if (project.sourceType !== "local" || !project.localUrl) {
      const fallback =
        project.keyframeUrls[0] ||
        (project.videoId ? `https://i.ytimg.com/vi/${project.videoId}/hqdefault.jpg` : "");
      setThumbnails(fallback ? [fallback] : []);
      return;
    }

    if (isCollapsed) return;

    let cancelled = false;
    const estDur = Math.max(1, project.sourceDurationSec || sourceDuration);
    const targetCount = Math.min(12, Math.max(6, Math.ceil(estDur / 6)));
    const hiddenVid = document.createElement("video");
    hiddenVid.muted = true;
    hiddenVid.playsInline = true;
    hiddenVid.preload = "metadata";

    const releaseHiddenVid = () => {
      hiddenVid.onloadeddata = null;
      hiddenVid.onerror = null;
      try {
        hiddenVid.pause();
        hiddenVid.removeAttribute("src");
        hiddenVid.load();
      } catch {
        // ignore
      }
    };

    const captureFrames = async () => {
      // Let primary 9:16 video stage initialize decoder cleanly first
      await new Promise((r) => setTimeout(r, 420));
      if (cancelled) return;
      hiddenVid.src = project.localUrl!;

      await new Promise<void>((resolve) => {
        if (hiddenVid.readyState >= 1) return resolve();
        hiddenVid.onloadeddata = () => resolve();
        hiddenVid.onerror = () => resolve();
        setTimeout(resolve, 2500);
      });
      if (cancelled) return;

      const actualDur =
        Number.isFinite(hiddenVid.duration) && hiddenVid.duration > 0
          ? hiddenVid.duration
          : estDur;
      const canvas = document.createElement("canvas");
      const cw = 96;
      const ch = 56;
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const frames: string[] = [];
      for (let i = 0; i < targetCount; i++) {
        if (cancelled) break;
        const t = Math.min(actualDur - 0.05, ((i + 0.5) / targetCount) * actualDur);
        hiddenVid.currentTime = Math.max(0, t);
        await new Promise<void>((res) => {
          const onSeeked = () => {
            hiddenVid.removeEventListener("seeked", onSeeked);
            res();
          };
          hiddenVid.addEventListener("seeked", onSeeked, { once: true });
          setTimeout(res, 450);
        });
        if (cancelled) break;
        try {
          ctx.drawImage(hiddenVid, 0, 0, cw, ch);
          frames.push(canvas.toDataURL("image/jpeg", 0.55));
          if (frames.length % 3 === 0 || frames.length === targetCount) {
            setThumbnails([...frames]);
          }
        } catch {
          break;
        }
      }
    };

    captureFrames().finally(releaseHiddenVid);

    return () => {
      cancelled = true;
      releaseHiddenVid();
    };
  }, [project?.sourceType, project?.localUrl, project?.videoId, isCollapsed]);

  // Smoothly throttle rapid drag seeks on Stage9x16 so YouTube/local video players stay fluid
  const dispatchSeek = useCallback(
    (targetCut: number, immediate = false) => {
      const maxCut = totalCutDurationRef.current;
      const clamped = Math.max(0, Math.min(maxCut, targetCut));
      const minIntervalMs = projectRef.current?.sourceType === "youtube" ? 110 : 28;
      const now = performance.now();

      if (immediate || now - lastSeekDispatchAtRef.current >= minIntervalMs) {
        if (seekThrottleTimerRef.current !== null) {
          window.clearTimeout(seekThrottleTimerRef.current);
          seekThrottleTimerRef.current = null;
        }
        queuedSeekSecRef.current = null;
        lastSeekDispatchAtRef.current = now;
        onSeek(clamped);
        return clamped;
      }

      queuedSeekSecRef.current = clamped;
      if (seekThrottleTimerRef.current === null) {
        const wait = Math.max(8, minIntervalMs - (now - lastSeekDispatchAtRef.current));
        seekThrottleTimerRef.current = window.setTimeout(() => {
          seekThrottleTimerRef.current = null;
          if (queuedSeekSecRef.current !== null) {
            const next = queuedSeekSecRef.current;
            queuedSeekSecRef.current = null;
            lastSeekDispatchAtRef.current = performance.now();
            onSeek(next);
          }
        }, wait);
      }
      return clamped;
    },
    [onSeek]
  );

  useEffect(() => {
    return () => {
      if (seekThrottleTimerRef.current !== null) {
        window.clearTimeout(seekThrottleTimerRef.current);
      }
      if (wheelClearTimerRef.current !== null) {
        window.clearTimeout(wheelClearTimerRef.current);
      }
    };
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const curProj = projectRef.current;
    if (!curProj) return;
    setUndoStack((prev) => [
      ...prev.slice(-29),
      {
        scenes: normalizedScenesRef.current.map((s) => ({ ...s })),
        subtitles: curProj.subtitles.map((sub) => ({
          ...sub,
          words: sub.words.map((w) => ({ ...w })),
        })),
      },
    ]);
  }, []);

  // Segment currently underneath the center playhead
  const segmentAtPlayhead = useMemo(() => {
    if (segments.length === 0) return null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (cutTime >= seg.cutStart && cutTime <= seg.cutEnd + 0.001) {
        return seg;
      }
    }
    return segments[segments.length - 1];
  }, [segments, cutTime]);

  const canSplitAtPlayhead = Boolean(
    segmentAtPlayhead &&
      cutTime > segmentAtPlayhead.cutStart + 0.4 &&
      cutTime < segmentAtPlayhead.cutEnd - 0.4
  );

  const handleSplitAtPlayhead = useCallback(() => {
    if (!segmentAtPlayhead || !canSplitAtPlayhead) return;
    if (isPlaying) onPause();

    const localOffset = cutTime - segmentAtPlayhead.cutStart;
    const splitSourceSec = roundTenth(segmentAtPlayhead.startSec + localOffset);
    if (
      splitSourceSec <= segmentAtPlayhead.startSec + 0.35 ||
      splitSourceSec >= segmentAtPlayhead.endSec - 0.35
    ) {
      return;
    }

    pushUndoSnapshot();

    const leftClip: SpeakingScene = {
      ...segmentAtPlayhead.scene,
      id: segmentAtPlayhead.sceneId,
      startSec: segmentAtPlayhead.startSec,
      endSec: splitSourceSec,
      durationSec: roundTenth(splitSourceSec - segmentAtPlayhead.startSec),
    };
    const rightId = `proj-sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rightClip: SpeakingScene = {
      ...segmentAtPlayhead.scene,
      id: rightId,
      startSec: splitSourceSec,
      endSec: segmentAtPlayhead.endSec,
      durationSec: roundTenth(segmentAtPlayhead.endSec - splitSourceSec),
    };

    const nextScenes = [
      ...normalizedScenes.slice(0, segmentAtPlayhead.index),
      leftClip,
      rightClip,
      ...normalizedScenes.slice(segmentAtPlayhead.index + 1),
    ];
    onUpdateScenes(nextScenes);
    setActiveSceneId(rightId);
  }, [
    segmentAtPlayhead,
    canSplitAtPlayhead,
    isPlaying,
    onPause,
    cutTime,
    pushUndoSnapshot,
    normalizedScenes,
    onUpdateScenes,
  ]);

  const targetClipForDelete = useMemo(() => {
    if (segments.length === 0) return null;
    return (
      segments.find((s) => s.sceneId === activeSceneId) ??
      segmentAtPlayhead ??
      segments[0]
    );
  }, [segments, activeSceneId, segmentAtPlayhead]);

  const handleDeleteClip = useCallback(
    (targetId?: string) => {
      const segToDelete = targetId
        ? segments.find((s) => s.sceneId === targetId)
        : targetClipForDelete;
      if (!segToDelete) return;

      if (isPlaying) onPause();
      pushUndoSnapshot();

      const nextScenes = normalizedScenes.filter((_, i) => i !== segToDelete.index);
      onUpdateScenes(nextScenes);

      const nextClip =
        nextScenes[Math.min(segToDelete.index, Math.max(0, nextScenes.length - 1))] ?? null;
      setActiveSceneId(nextClip?.id ?? null);

      const newMaxCut = nextScenes.reduce(
        (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
        0
      );
      const nextCut = Math.max(0, Math.min(newMaxCut, segToDelete.cutStart));
      dispatchSeek(nextCut, true);
    },
    [
      segments,
      targetClipForDelete,
      isPlaying,
      onPause,
      pushUndoSnapshot,
      normalizedScenes,
      onUpdateScenes,
      dispatchSeek,
    ]
  );

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    if (isPlaying) onPause();
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    onRestoreSnapshot(prev.scenes, prev.subtitles);
    setActiveSceneId((cur) => (cur && prev.scenes.some((s) => s.id === cur) ? cur : null));
  }, [undoStack, isPlaying, onPause, onRestoreSnapshot]);

  const handleRestoreOriginal = useCallback(() => {
    if (isPlaying) onPause();
    pushUndoSnapshot();
    onResetTimeline();
    dispatchSeek(0, true);
  }, [isPlaying, onPause, pushUndoSnapshot, onResetTimeline, dispatchSeek]);

  // Keyboard shortcuts: Space to Play/Pause, Delete/Backspace to remove selected clip
  useEffect(() => {
    if (!isActive || !project) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        onTogglePlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && targetClipForDelete) {
        e.preventDefault();
        handleDeleteClip(targetClipForDelete.sceneId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, project, onTogglePlay, targetClipForDelete, handleDeleteClip]);

  const trackCenterTime = frozenTrackTime ?? liveScrubCutTime ?? cutTime;
  const centerX = viewportWidth / 2;
  const trackWidth = Math.max(totalCutDuration * pxPerSec, 1);
  const trackTranslateX = centerX - trackCenterTime * pxPerSec;

  const timelineTransformConfigRef = useRef({
    centerX,
    pxPerSec,
    frozen: frozenTrackTime !== null,
  });
  timelineTransformConfigRef.current = {
    centerX,
    pxPerSec,
    frozen: frozenTrackTime !== null,
  };

  useIsomorphicLayoutEffect(() => {
    if (timeReadoutRef.current) {
      const safeCut = typeof cutTime === "number" && Number.isFinite(cutTime) ? Math.max(0, cutTime) : 0;
      timeReadoutRef.current.textContent = formatTimePrecise(safeCut);
    }
  }, [cutTime, project?.scenes.length]);

  useEffect(() => {
    if (!subscribeCutTime) return;
    return subscribeCutTime((rawLiveSec) => {
      const liveSec =
        typeof rawLiveSec === "number" && Number.isFinite(rawLiveSec) ? Math.max(0, rawLiveSec) : 0;
      const cfg = timelineTransformConfigRef.current;
      if (cfg.frozen || dragStateRef.current || liveScrubCutRef.current !== null) return;
      if (trackSlideRef.current) {
        const nextX = cfg.centerX - liveSec * cfg.pxPerSec;
        trackSlideRef.current.style.transform = `translate3d(${nextX}px, 0, 0)`;
      }
      if (timeReadoutRef.current) {
        timeReadoutRef.current.textContent = formatTimePrecise(liveSec);
      }
    });
  }, [subscribeCutTime]);

  const resolvedSpeechRegions = useMemo<SpeechRegion[]>(() => {
    if (project?.speechRegions && project.speechRegions.length > 0) {
      return project.speechRegions;
    }
    if (baselineSubRegions.length > 0) {
      return baselineSubRegions;
    }
    return (project?.subtitles ?? []).map((s) => ({
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec,
    }));
  }, [project?.speechRegions, baselineSubRegions, project?.subtitles]);

  const computedCutSpeechRegions = useMemo(() => {
    const primary = projectSpeechRegionsToCutTimeline(segments, resolvedSpeechRegions);
    if (primary.length > 0) return primary;
    const fallbackSubs =
      baselineSubRegions.length > 0
        ? baselineSubRegions
        : (project?.subtitles ?? []).map((s) => ({
            sourceStartSec: s.sourceStartSec,
            sourceEndSec: s.sourceEndSec,
          }));
    return projectSpeechRegionsToCutTimeline(segments, fallbackSubs);
  }, [segments, resolvedSpeechRegions, baselineSubRegions, project?.subtitles]);

  const cutSpeechRegions = controlledCutSpeechRegions ?? computedCutSpeechRegions;

  const unmatchedSpeechGaps = useMemo(
    () =>
      project
        ? findUnmatchedSpeechGaps(project.subtitles, cutSpeechRegions, totalCutDuration)
        : [],
    [project, cutSpeechRegions, totalCutDuration]
  );

  const openRangeFillPopover = useCallback(() => {
    setRangeNotice(null);
    const suggestion = suggestTranscribeRange(
      project?.subtitles ?? [],
      cutSpeechRegions,
      cutTime,
      totalCutDuration
    );
    setRangeStartVal(suggestion.startSec.toFixed(1));
    setRangeEndVal(suggestion.endSec.toFixed(1));
    setShowRangeFill(true);
  }, [project?.subtitles, cutSpeechRegions, cutTime, totalCutDuration]);

  const runRangeTranscribe = useCallback(
    async (rawStart: number, rawEnd: number) => {
      if (!onTranscribeRange || transcribingRange) return;
      const startSec = Math.max(0, Math.min(totalCutDuration, Number(rawStart) || 0));
      const endSec = Math.max(startSec + 0.3, Math.min(totalCutDuration, Number(rawEnd) || startSec + 2));
      if (isPlaying) {
        onPause();
      }
      setRangeNotice(null);
      onSeek(startSec);
      const res = await onTranscribeRange(startSec, endSec);
      if (res && typeof res.addedCount === "number" && res.addedCount === 0) {
        setRangeNotice(res.message || "No clear speech detected in that range.");
        setRangeStartVal(startSec.toFixed(1));
        setRangeEndVal(endSec.toFixed(1));
        setShowRangeFill(true);
      } else {
        setShowRangeFill(false);
        setRangeNotice(null);
      }
    },
    [onTranscribeRange, transcribingRange, totalCutDuration, isPlaying, onPause, onSeek]
  );

  const tickStepSec = useMemo(() => {
    if (pxPerSec >= 75) return 1;
    if (pxPerSec >= 34) return 2;
    if (pxPerSec >= 18) return 5;
    return 10;
  }, [pxPerSec]);

  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let s = 0; s <= totalCutDuration + 0.01; s += tickStepSec) {
      ticks.push(s);
    }
    return ticks;
  }, [totalCutDuration, tickStepSec]);

  const blurFocusedButton = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName === "BUTTON") {
      active.blur();
    }
  };

  const stopWindowPointerTracking = useCallback(() => {
    windowDragCleanupRef.current?.();
    windowDragCleanupRef.current = null;
  }, []);

  const startWindowPointerTracking = useCallback(() => {
    if (windowDragCleanupRef.current) return;
    const onWinMove = (ev: PointerEvent) => {
      pointerMoveHandlerRef.current(ev);
    };
    const onWinEnd = (ev: PointerEvent) => {
      pointerUpHandlerRef.current(ev);
    };
    const onWinTouchMove = (ev: TouchEvent) => {
      if (dragStateRef.current || activePointersRef.current.size > 0) {
        if (ev.cancelable) ev.preventDefault();
      }
    };
    const onWinBlur = () => {
      pointerUpHandlerRef.current({} as PointerEvent);
    };
    window.addEventListener("pointermove", onWinMove, { passive: false });
    window.addEventListener("pointerup", onWinEnd);
    window.addEventListener("pointercancel", onWinEnd);
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("blur", onWinBlur);
    windowDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onWinMove);
      window.removeEventListener("pointerup", onWinEnd);
      window.removeEventListener("pointercancel", onWinEnd);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("blur", onWinBlur);
    };
  }, []);

  useEffect(() => {
    return () => {
      stopWindowPointerTracking();
    };
  }, [stopWindowPointerTracking]);

  const handlePointerDownViewport = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();

    if (e.isPrimary) {
      activePointersRef.current.clear();
    }
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }

    startWindowPointerTracking();

    if (activePointersRef.current.size >= 2) {
      if (isPlaying) onPause();
      updateDragState(null);
      setDragBadge(null);
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      pinchStartRef.current = { dist, pxPerSec };
      return;
    }

    if (activePointersRef.current.size === 1) {
      const isMouse = e.pointerType === "mouse";
      if (isMouse && isPlaying) {
        onPause();
      }
      pinchStartRef.current = null;
      const startTime = liveScrubCutRef.current ?? cutTimeRef.current;
      const nextDrag: DragMode = {
        type: "scrub",
        pointerType: e.pointerType || "mouse",
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientY: e.clientY,
        startCutTime: startTime,
        axis: isMouse ? "x" : "pending",
      };
      updateDragState(nextDrag);
    }
  };

  const handlePointerDownTrimHandle = (
    e: React.PointerEvent<HTMLElement>,
    mode: "trim-start" | "trim-end",
    seg: ClipSegment
  ) => {
    e.stopPropagation();
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startWindowPointerTracking();
    if (isPlaying) onPause();

    const curProj = projectRef.current;
    trimPreUndoRef.current = curProj
      ? {
          scenes: normalizedScenesRef.current.map((s) => ({ ...s })),
          subtitles: curProj.subtitles.map((sub) => ({
            ...sub,
            words: sub.words.map((w) => ({ ...w })),
          })),
        }
      : null;

    const freezeCut = liveScrubCutRef.current ?? cutTimeRef.current;
    frozenTrackTimeRef.current = freezeCut;
    setActiveSceneId(seg.sceneId);
    setFrozenTrackTime(freezeCut);
    const initTrim = {
      sceneId: seg.sceneId,
      mode,
      origStartSec: seg.startSec,
      origEndSec: seg.endSec,
      origCutStart: seg.cutStart,
      origCutEnd: seg.cutEnd,
      nextStartSec: seg.startSec,
      nextEndSec: seg.endSec,
    };
    trimPreviewRef.current = initTrim;
    setTrimPreview(initTrim);
    updateDragState({
      type: mode,
      sceneId: seg.sceneId,
      startClientX: e.clientX,
      origStartSec: seg.startSec,
      origEndSec: seg.endSec,
      origCutStart: seg.cutStart,
    });
  };

  const handlePointerDownSubInteraction = (
    e: React.PointerEvent<HTMLElement>,
    mode: "sub-move" | "sub-trim-start" | "sub-trim-end",
    sub: SubtitleItem,
    subIndex: number
  ) => {
    e.stopPropagation();
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startWindowPointerTracking();
    if (isPlaying) onPause();

    const curProj = projectRef.current;
    trimPreUndoRef.current = curProj
      ? {
          scenes: normalizedScenesRef.current.map((s) => ({ ...s })),
          subtitles: curProj.subtitles.map((s) => ({
            ...s,
            words: s.words.map((w) => ({ ...w })),
          })),
        }
      : null;

    lastDragTargetRef.current = null;
    setActiveSubId(sub.id);
    setFrozenTrackTime(cutTimeRef.current);
    setDragSubPreview({
      id: sub.id,
      startTime: sub.startTime,
      endTime: sub.endTime,
    });
    updateDragState({
      type: mode,
      subId: sub.id,
      subIndex,
      startClientX: e.clientX,
      origStartTime: sub.startTime,
      origEndTime: sub.endTime,
    });
  };

  const handlePointerMoveViewport = (e: PointerEvent | React.PointerEvent<HTMLElement>) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (activePointersRef.current.size >= 2 && pinchStartRef.current) {
      if ("cancelable" in e && e.cancelable) e.preventDefault();
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const nextZoom = clampZoom(
        Math.round(pinchStartRef.current.pxPerSec * (dist / pinchStartRef.current.dist))
      );
      setPxPerSec(nextZoom);
      return;
    }

    const activeDrag = dragStateRef.current;
    if (!activeDrag) return;
    if ("cancelable" in e && e.cancelable) e.preventDefault();
    const dx = e.clientX - activeDrag.startClientX;

    if (activeDrag.type === "scrub") {
      if (activeDrag.axis === "pending") {
        const dy = e.clientY - activeDrag.startClientY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const dist = Math.hypot(dx, dy);
        if (dist < 7) return;
        const canScrollVertically = hasVerticalScrollRoom(viewportRef.current);
        if (canScrollVertically && absDy > absDx * 1.15) {
          activeDrag.axis = "y";
          scrollVerticalAncestors(viewportRef.current, -dy);
          activeDrag.lastClientY = e.clientY;
          tappedClipRef.current = null;
          tappedSubRef.current = null;
          return;
        } else {
          activeDrag.axis = "x";
          if (isPlaying) onPause();
        }
      }

      if (activeDrag.axis === "y") {
        const moveY = e.clientY - activeDrag.lastClientY;
        activeDrag.lastClientY = e.clientY;
        scrollVerticalAncestors(viewportRef.current, -moveY);
        return;
      }

      if (tappedClipRef.current && Math.abs(dx) > 5) {
        tappedClipRef.current.moved = true;
      }
      if (tappedSubRef.current && Math.abs(dx) > 5) {
        tappedSubRef.current.moved = true;
      }

      const dt = dx / pxPerSec;
      const nextCut = Math.max(
        0,
        Math.min(totalCutDurationRef.current, activeDrag.startCutTime - dt)
      );
      liveScrubCutRef.current = nextCut;
      setLiveScrubCutTime(nextCut);
      dispatchSeek(nextCut);
      return;
    }

    const dt = dx / pxPerSec;

    if (activeDrag.type === "trim-start") {
      const nextStart = roundTenth(
        Math.max(0, Math.min(activeDrag.origEndSec - 0.5, activeDrag.origStartSec + dt))
      );
      const nextPreview = {
        sceneId: activeDrag.sceneId,
        mode: "trim-start" as const,
        origStartSec: activeDrag.origStartSec,
        origEndSec: activeDrag.origEndSec,
        origCutStart: activeDrag.origCutStart,
        origCutEnd: activeDrag.origCutStart + Math.max(0.1, activeDrag.origEndSec - activeDrag.origStartSec),
        nextStartSec: nextStart,
        nextEndSec: activeDrag.origEndSec,
      };
      trimPreviewRef.current = nextPreview;
      setTrimPreview(nextPreview);
      setDragBadge({ label: "In", sec: nextStart });
      return;
    }

    if (activeDrag.type === "trim-end") {
      const nextEnd = roundTenth(
        Math.min(
          sourceDuration,
          Math.max(activeDrag.origStartSec + 0.5, activeDrag.origEndSec + dt)
        )
      );
      const nextPreview = {
        sceneId: activeDrag.sceneId,
        mode: "trim-end" as const,
        origStartSec: activeDrag.origStartSec,
        origEndSec: activeDrag.origEndSec,
        origCutStart: activeDrag.origCutStart,
        origCutEnd: activeDrag.origCutStart + Math.max(0.1, activeDrag.origEndSec - activeDrag.origStartSec),
        nextStartSec: activeDrag.origStartSec,
        nextEndSec: nextEnd,
      };
      trimPreviewRef.current = nextPreview;
      setTrimPreview(nextPreview);
      setDragBadge({ label: "Out", sec: nextEnd });
      return;
    }

    if (activeDrag.type === "sub-move") {
      const dur = Math.max(0.2, activeDrag.origEndTime - activeDrag.origStartTime);
      const maxTotal = Math.max(dur, totalCutDurationRef.current || dur);
      const nextStart = roundTenth(
        Math.max(0, Math.min(maxTotal - dur, activeDrag.origStartTime + dt))
      );
      const nextEnd = roundTenth(nextStart + dur);
      if (Math.abs(nextStart - activeDrag.origStartTime) >= 0.01) {
        const preview = { id: activeDrag.subId, startTime: nextStart, endTime: nextEnd };
        dragSubPreviewRef.current = preview;
        setDragSubPreview(preview);
        lastDragTargetRef.current = { cutTime: nextStart, sourceSec: nextStart };
        dispatchSeek(nextStart);
        setDragBadge({ label: `Sub #${activeDrag.subIndex + 1}`, sec: nextStart });
      }
      return;
    }

    if (activeDrag.type === "sub-trim-start") {
      const nextStart = roundTenth(
        Math.max(0, Math.min(activeDrag.origEndTime - 0.2, activeDrag.origStartTime + dt))
      );
      const preview = {
        id: activeDrag.subId,
        startTime: nextStart,
        endTime: activeDrag.origEndTime,
      };
      dragSubPreviewRef.current = preview;
      setDragSubPreview(preview);
      lastDragTargetRef.current = { cutTime: nextStart, sourceSec: nextStart };
      dispatchSeek(nextStart);
      setDragBadge({ label: `Sub #${activeDrag.subIndex + 1} In`, sec: nextStart });
      return;
    }

    if (activeDrag.type === "sub-trim-end") {
      const maxTotal = Math.max(activeDrag.origStartTime + 0.2, totalCutDurationRef.current);
      const nextEnd = roundTenth(
        Math.min(maxTotal, Math.max(activeDrag.origStartTime + 0.2, activeDrag.origEndTime + dt))
      );
      const previewCut = Math.max(activeDrag.origStartTime, nextEnd - 0.05);
      const preview = {
        id: activeDrag.subId,
        startTime: activeDrag.origStartTime,
        endTime: nextEnd,
      };
      dragSubPreviewRef.current = preview;
      setDragSubPreview(preview);
      lastDragTargetRef.current = { cutTime: previewCut, sourceSec: nextEnd };
      dispatchSeek(previewCut);
      setDragBadge({ label: `Sub #${activeDrag.subIndex + 1} Out`, sec: nextEnd });
    }
  };

  const handlePointerUpAny = useCallback(
    (e?: React.PointerEvent<HTMLElement> | PointerEvent) => {
      if (e && "pointerId" in e) {
        activePointersRef.current.delete(e.pointerId);
        if (activePointersRef.current.size < 2) {
          pinchStartRef.current = null;
        }
      } else {
        activePointersRef.current.clear();
        pinchStartRef.current = null;
      }

      const activeDrag = dragStateRef.current;
      if (!activeDrag) {
        tappedClipRef.current = null;
        tappedSubRef.current = null;
        if (activePointersRef.current.size === 0) {
          stopWindowPointerTracking();
        }
        return;
      }
      dragStateRef.current = null;

      let subTapSeekTarget: number | null = null;
      if (activeDrag.type === "scrub") {
        const hadClipTap = Boolean(tappedClipRef.current && !tappedClipRef.current.moved);
        const hadSubTap = Boolean(tappedSubRef.current && !tappedSubRef.current.moved);
        const isUnmovedTouchTap =
          activeDrag.axis === "pending" ||
          (activeDrag.axis === "x" && e && Math.abs(e.clientX - activeDrag.startClientX) <= 5);

        if (hadClipTap && tappedClipRef.current) {
          const tappedId = tappedClipRef.current.sceneId;
          setActiveSceneId((cur) => (cur === tappedId ? null : tappedId));
        } else if (hadSubTap && tappedSubRef.current) {
          setActiveSubId(tappedSubRef.current.subId);
          subTapSeekTarget = tappedSubRef.current.startTime;
        } else if (isUnmovedTouchTap && !hadClipTap && !hadSubTap) {
          setActiveSceneId(null);
          setActiveSubId(null);
        }
      }
      tappedClipRef.current = null;
      tappedSubRef.current = null;

      if (activeDrag.type === "scrub") {
        const finalScrubCut = liveScrubCutRef.current;
        liveScrubCutRef.current = null;
        setLiveScrubCutTime(null);

        if (subTapSeekTarget !== null) {
          queuedSeekSecRef.current = null;
          dispatchSeek(subTapSeekTarget, true);
        } else if (activeDrag.axis === "x" && finalScrubCut !== null) {
          queuedSeekSecRef.current = null;
          dispatchSeek(finalScrubCut, true);
        } else if (queuedSeekSecRef.current !== null) {
          dispatchSeek(queuedSeekSecRef.current, true);
        }
      } else if (
        activeDrag.type === "sub-move" ||
        activeDrag.type === "sub-trim-start" ||
        activeDrag.type === "sub-trim-end"
      ) {
        const preview = dragSubPreviewRef.current;
        const target = lastDragTargetRef.current;
        if (
          preview &&
          target &&
          trimPreUndoRef.current &&
          (Math.abs(preview.startTime - activeDrag.origStartTime) >= 0.01 ||
            Math.abs(preview.endTime - activeDrag.origEndTime) >= 0.01)
        ) {
          const snapshot = trimPreUndoRef.current;
          setUndoStack((prev) => [...prev.slice(-29), snapshot]);
          onUpdateSubtitleTiming?.(preview.id, preview.startTime, preview.endTime);
          dispatchSeek(target.cutTime, true);
        } else if (activeDrag.type === "sub-move" && !target) {
          dispatchSeek(activeDrag.origStartTime, true);
        }
        trimPreUndoRef.current = null;
        lastDragTargetRef.current = null;
        dragSubPreviewRef.current = null;
        setDragSubPreview(null);
        setFrozenTrackTime(null);
      } else {
        const preview = trimPreviewRef.current;
        trimPreviewRef.current = null;
        setTrimPreview(null);
        const stayFrozen = frozenTrackTimeRef.current;
        frozenTrackTimeRef.current = null;
        setFrozenTrackTime(null);

        if (
          preview &&
          trimPreUndoRef.current &&
          (Math.abs(preview.nextStartSec - preview.origStartSec) >= 0.01 ||
            Math.abs(preview.nextEndSec - preview.origEndSec) >= 0.01)
        ) {
          const snapshot = trimPreUndoRef.current;
          setUndoStack((prev) => [...prev.slice(-29), snapshot]);
          const nextScenes = normalizedScenesRef.current.map((sc) =>
            sc.id === preview.sceneId
              ? {
                  ...sc,
                  startSec: preview.nextStartSec,
                  endSec: preview.nextEndSec,
                  durationSec: roundTenth(preview.nextEndSec - preview.nextStartSec),
                }
              : sc
          );
          onUpdateScenes(nextScenes);
          const newMaxCut = nextScenes.reduce(
            (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
            0
          );
          const stayCut = Math.max(0, Math.min(newMaxCut, stayFrozen ?? cutTimeRef.current));
          dispatchSeek(stayCut, true);
        }
        trimPreUndoRef.current = null;
        lastDragTargetRef.current = null;
      }

      setDragBadge(null);
      updateDragState(null);
      if (activePointersRef.current.size === 0) {
        stopWindowPointerTracking();
      }
    },
    [dispatchSeek, onUpdateScenes, onUpdateSubtitleTiming, stopWindowPointerTracking, updateDragState]
  );

  pointerMoveHandlerRef.current = handlePointerMoveViewport;
  pointerUpHandlerRef.current = handlePointerUpAny;

  // Two-finger trackpad pinch-to-zoom (ctrlKey + wheel) & horizontal/vertical scroll scrub
  const wheelStateRef = useRef({ pxPerSec, dispatchSeek, isPlaying, onPause });
  wheelStateRef.current = { pxPerSec, dispatchSeek, isPlaying, onPause };
  useEffect(() => {
    if (isCollapsed) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.008);
        setPxPerSec((z) => clampZoom(Math.round(z * factor)));
        return;
      }
      const isHorizontalScroll =
        (Math.abs(e.deltaX) >= 0.5 && Math.abs(e.deltaX) >= Math.abs(e.deltaY) * 0.65) ||
        (e.shiftKey && Math.abs(e.deltaY) > 0);
      if (!isHorizontalScroll) {
        // Allow vertical wheel/trackpad scrolling to scroll the page/panel vertically
        return;
      }
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 0.05) return;
      e.preventDefault();
      const {
        pxPerSec: pps,
        dispatchSeek: seek,
        isPlaying: playing,
        onPause: pause,
      } = wheelStateRef.current;
      if (playing) pause();

      const now = performance.now();
      const baseCut =
        wheelTargetCutRef.current && wheelTargetCutRef.current.expiresAt > now
          ? wheelTargetCutRef.current.cutTime
          : liveScrubCutRef.current ?? cutTimeRef.current;
      const next = Math.max(0, Math.min(totalCutDurationRef.current, baseCut + delta / pps));
      wheelTargetCutRef.current = { cutTime: next, expiresAt: now + 240 };
      liveScrubCutRef.current = next;
      setLiveScrubCutTime(next);
      seek(next);

      if (wheelClearTimerRef.current !== null) {
        window.clearTimeout(wheelClearTimerRef.current);
      }
      wheelClearTimerRef.current = window.setTimeout(() => {
        wheelClearTimerRef.current = null;
        liveScrubCutRef.current = null;
        setLiveScrubCutTime(null);
      }, 220);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [projectIdentity, isCollapsed]);

  // Empty "No video" state when subtitles have not been generated yet
  if (!project) {
    if (dockMode) {
      return (
        <div className="border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden">
          <div className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-md bg-teal-50 dark:bg-teal-950/60 border border-teal-200/70 dark:border-teal-500/25 flex items-center justify-center text-teal-700 dark:text-teal-400 shrink-0">
                <Film className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                  Timeline Dock
                </p>
                <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4] truncate">
                  Upload a video and generate subtitles in Upload &amp; Cut to unlock the multi-track timeline.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {onGoToScenes && (
                <button
                  type="button"
                  onClick={onGoToScenes}
                  className="h-8 px-3.5 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                >
                  <span>Upload &amp; Cut</span>
                </button>
              )}
              {onToggleCollapse && (
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  aria-label={isCollapsed ? "Expand timeline dock" : "Collapse timeline dock"}
                  className="h-8 w-8 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] flex items-center justify-center cursor-pointer transition-colors"
                >
                  {isCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-4 pb-6">
        <div className="w-full aspect-video rounded-lg border border-dashed border-[#bcc9e6] dark:border-[#2e3644] bg-white dark:bg-[#0d1022] flex flex-col items-center justify-center text-center p-6 gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-50 dark:bg-teal-950/60 border border-teal-200/70 dark:border-teal-500/25 flex items-center justify-center text-teal-700 dark:text-teal-400">
            <Film className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-sm">
            <p className="font-display text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
              No video
            </p>
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4] leading-relaxed">
              Generate subtitles first to edit your 9:16 video on the timeline before exporting.
            </p>
          </div>
          {onGoToScenes && (
            <button
              type="button"
              onClick={onGoToScenes}
              className="mt-1 h-9 px-4 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors"
            >
              <span>Upload &amp; Cut</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        dockMode
          ? "border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden flex flex-col"
          : "flex flex-col gap-3.5 pb-6"
      }
    >
      {/* Generated 9:16 Video Summary Header (Standard Mode) */}
      {!dockMode && (
        <div className="px-3 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
              {project.title}
            </p>
            <p className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
              9:16 Subtitle Video · {segments.length} {segments.length === 1 ? "clip" : "clips"} ·{" "}
              {roundTenth(totalCutDuration)}s
            </p>
          </div>
        </div>
      )}

      {/* Transport & Split / Delete Cut Controls */}
      <div
        className={
          dockMode
            ? `px-4 py-1.5 flex flex-wrap items-center justify-between gap-2 bg-[#f3f5fc] dark:bg-[#0d1022] ${
                !isCollapsed || showDockScenes ? "border-b border-[#d2dcf0] dark:border-[#21284c]" : ""
              }`
            : "flex flex-wrap items-center justify-between gap-2 px-0.5"
        }
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {dockMode && (
            <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400 shrink-0">
              Timeline
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              onTogglePlay();
            }}
            disabled={segments.length === 0}
            aria-label={isPlaying ? "Pause video" : "Play video"}
            className="h-7 w-7 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] flex items-center justify-center disabled:opacity-40 cursor-pointer shrink-0 transition-colors"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
          </button>

          <span className="text-xs font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc] shrink-0">
            <span ref={timeReadoutRef} />
            <span className="text-[#4d597d] dark:text-[#919ec4]">
              {" "}
              / {formatTimePrecise(totalCutDuration)}
            </span>
          </span>

          {dockMode && (
            <span className="hidden xl:inline text-[11px] text-[#4d597d] dark:text-[#919ec4] truncate max-w-[260px]">
              · {project.title}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              handleSplitAtPlayhead();
            }}
            disabled={!canSplitAtPlayhead}
            title="Split clip at center playhead"
            className="h-7 px-2.5 rounded-md bg-teal-700 text-white hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>Split</span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              handleDeleteClip();
            }}
            disabled={!targetClipForDelete}
            title="Delete selected clip"
            className="h-7 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              handleUndo();
            }}
            disabled={undoStack.length === 0}
            title="Undo last edit"
            aria-label="Undo last edit"
            className="h-7 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              handleRestoreOriginal();
            }}
            title="Reset timeline edits"
            aria-label="Reset timeline edits"
            className="h-7 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {onShiftAllSubtitles && (
            <div
              role="group"
              aria-label="Subtitle timing micro-nudge"
              className="inline-flex items-center border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] rounded-md overflow-hidden"
            >
              <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#4d597d] dark:text-[#919ec4] select-none">
                Sub
              </span>
              <button
                type="button"
                disabled={!project.subtitles.length}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onShiftAllSubtitles(-0.1);
                }}
                title="Nudge all subtitles -0.1s"
                aria-label="Shift all subtitles -0.1s"
                className="h-7 px-1.5 border-l border-[#d2dcf0] dark:border-[#21284c] text-[11px] font-mono-tabular font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
              >
                -0.1s
              </button>
              <button
                type="button"
                disabled={!project.subtitles.length}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onShiftAllSubtitles(0.1);
                }}
                title="Nudge all subtitles +0.1s"
                aria-label="Shift all subtitles +0.1s"
                className="h-7 px-1.5 border-l border-[#d2dcf0] dark:border-[#21284c] text-[11px] font-mono-tabular font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
              >
                +0.1s
              </button>
            </div>
          )}

          <div className="inline-flex items-center border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] rounded-md overflow-hidden ml-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(Math.round(z * 0.75)));
              }}
              aria-label="Zoom out timeline"
              className="h-7 w-7 flex items-center justify-center text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] cursor-pointer transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(Math.round(z * 1.35)));
              }}
              aria-label="Zoom in timeline"
              className="h-7 w-7 flex items-center justify-center border-l border-[#d2dcf0] dark:border-[#21284c] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] cursor-pointer transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {onTranscribeRange && (
            <button
              type="button"
              disabled={segments.length === 0 || Boolean(transcribingRange)}
              onClick={(e) => {
                e.currentTarget.blur();
                if (showRangeFill) {
                  setShowRangeFill(false);
                  setRangeNotice(null);
                } else {
                  openRangeFillPopover();
                }
              }}
              title="AI transcribe missing speech in a time range"
              className={`h-7 px-2.5 rounded-md border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors ${
                showRangeFill || transcribingRange
                  ? "border-teal-600/70 bg-teal-50 text-teal-800 dark:border-teal-400/70 dark:bg-teal-950/60 dark:text-teal-200"
                  : unmatchedSpeechGaps.length > 0
                    ? "border-amber-500/60 bg-amber-50/90 text-amber-900 hover:bg-amber-100 dark:border-amber-400/50 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/50"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142]"
              }`}
            >
              {transcribingRange ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{transcribingRange ? "Transcribing…" : "AI Fill"}</span>
              {!transcribingRange && unmatchedSpeechGaps.length > 0 && (
                <span className="px-1 py-0.2 rounded bg-amber-600/15 dark:bg-amber-400/20 text-[10px] font-mono-tabular font-bold">
                  {unmatchedSpeechGaps.length}
                </span>
              )}
            </button>
          )}

          {dockMode && (
              <button
              type="button"
              onClick={() => setShowDockScenes((v) => !v)}
              title="Show or hide kept clips list"
              className={`h-7 px-2.5 rounded-md border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                showDockScenes
                  ? "border-teal-600/70 bg-teal-50 text-teal-800 dark:border-teal-400/70 dark:bg-teal-950/60 dark:text-teal-200"
                  : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142]"
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>Clips ({segments.length})</span>
            </button>
          )}

          {dockMode && onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={isCollapsed ? "Expand timeline dock" : "Collapse timeline dock"}
              aria-label={isCollapsed ? "Expand timeline dock" : "Collapse timeline dock"}
              className="h-7 w-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] flex items-center justify-center cursor-pointer transition-colors"
            >
              {isCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>

      {onTranscribeRange && showRangeFill && (
        <div
          className={`flex flex-wrap items-center gap-2 text-xs bg-[#eef2fc] dark:bg-[#10152e] border-b border-[#d2dcf0] dark:border-[#21284c] ${
            dockMode ? "px-4 py-1.5" : "px-2.5 py-2 rounded-md border"
          }`}
        >
          <span className="font-semibold text-teal-800 dark:text-teal-300 flex items-center gap-1 shrink-0">
            <Sparkles className="w-3 h-3" />
            Transcribe Range
          </span>
          <label className="flex items-center gap-1 text-[11px] text-[#4d597d] dark:text-[#919ec4]">
            Start
            <input
              type="number"
              step="0.1"
              min="0"
              max={totalCutDuration}
              value={rangeStartVal}
              onChange={(e) => {
                setRangeStartVal(e.target.value);
                setRangeNotice(null);
              }}
              className="w-16 h-6 px-1.5 rounded border border-[#bcc9e6] dark:border-[#2a3461] bg-white dark:bg-[#090d20] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-[11px]"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-[#4d597d] dark:text-[#919ec4]">
            End
            <input
              type="number"
              step="0.1"
              min="0"
              max={totalCutDuration}
              value={rangeEndVal}
              onChange={(e) => {
                setRangeEndVal(e.target.value);
                setRangeNotice(null);
              }}
              className="w-16 h-6 px-1.5 rounded border border-[#bcc9e6] dark:border-[#2a3461] bg-white dark:bg-[#090d20] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-[11px]"
            />
          </label>
          <button
            type="button"
            onClick={openRangeFillPopover}
            className="h-6 px-2 rounded border border-[#bcc9e6] dark:border-[#2a3461] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer"
          >
            Playhead Gap
          </button>
          {unmatchedSpeechGaps.slice(0, 4).map((gap, idx) => (
            <button
              key={`tl-gap-${gap.startSec}-${gap.endSec}-${idx}`}
              type="button"
              disabled={Boolean(transcribingRange)}
              onClick={() => void runRangeTranscribe(gap.startSec, gap.endSec)}
              title={`Fill ${formatTimePrecise(gap.startSec)} – ${formatTimePrecise(gap.endSec)}`}
              className="h-6 px-2 rounded border border-amber-500/50 bg-amber-50 hover:bg-amber-100 dark:border-amber-400/40 dark:bg-amber-950/40 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-200 font-mono-tabular text-[10px] cursor-pointer disabled:opacity-40"
            >
              Gap {gap.startSec.toFixed(1)}s–{gap.endSec.toFixed(1)}s
            </button>
          ))}
          <div className="flex items-center gap-1.5 ml-auto">
            {rangeNotice && (
              <span className="text-[11px] text-amber-800 dark:text-amber-300 font-medium">
                {rangeNotice}
              </span>
            )}
            <button
              type="button"
              disabled={Boolean(transcribingRange)}
              onClick={() =>
                void runRangeTranscribe(parseFloat(rangeStartVal), parseFloat(rangeEndVal))
              }
              className="h-6 px-2.5 rounded bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] font-semibold text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              {transcribingRange ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              <span>{transcribingRange ? "Transcribing…" : "Transcribe"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRangeFill(false);
                setRangeNotice(null);
              }}
              className="h-6 px-2 rounded text-[11px] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Fixed-Center-Playhead Split & Delete Timeline with Dedicated Bottom Scroll Space */}
      {(!dockMode || !isCollapsed) && (
        <div
          ref={viewportRef}
          onPointerDown={handlePointerDownViewport}
          className={`relative overflow-hidden select-none touch-none [&_*]:touch-none cursor-grab active:cursor-grabbing bg-[#e7ecf8] dark:bg-[#050712] ${
            dockMode
              ? "h-48"
              : "h-64 rounded-lg border border-[#d2dcf0] dark:border-[#21284c]"
          }`}
        >
        {/* Full-Width Stationary Ruler Bar Background */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-6 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95"
        />

        {/* Moving Timeline Content Track */}
        <div
          ref={trackSlideRef}
          style={{
            width: `${trackWidth}px`,
            transform: `translate3d(${trackTranslateX}px, 0, 0)`,
          }}
          className="absolute inset-y-0 left-0 will-change-transform"
        >
          {/* Time Ruler Ticks (Cut Timeline Seconds) */}
          <div className="relative h-6">
            {rulerTicks.map((s) => (
              <div
                key={s}
                style={{ left: `${s * pxPerSec}px` }}
                className="absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none"
              >
                <span className="text-[10px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] pl-1 leading-none pb-1">
                  {formatRulerTick(s)}
                </span>
                <div className="w-px h-1.5 bg-[#bcc9e6] dark:bg-[#2f3866]" />
              </div>
            ))}
          </div>

          {/* Kept Video Clips Track */}
          <div className="relative h-16 mt-2">
            {segments.map((seg, idx) => {
              const activeTrim = trimPreview?.sceneId === seg.sceneId ? trimPreview : null;
              const deltaStart = activeTrim ? activeTrim.nextStartSec - activeTrim.origStartSec : 0;
              const deltaEnd = activeTrim ? activeTrim.nextEndSec - activeTrim.origEndSec : 0;
              const leftPx = (seg.cutStart + deltaStart) * pxPerSec;
              const rightPx = (seg.cutEnd + deltaEnd) * pxPerSec;
              const widthPx = Math.max(18, rightPx - leftPx);
              const displayDur = activeTrim
                ? Math.max(0.1, activeTrim.nextEndSec - activeTrim.nextStartSec)
                : seg.clipDur;
              const isSelected = seg.sceneId === activeSceneId;

              const slotCount = Math.max(2, Math.min(18, Math.ceil(widthPx / 52)));
              const clipThumbs =
                thumbnails.length > 0
                  ? Array.from({ length: slotCount }, (_, slotIdx) => {
                      const effectiveStart = activeTrim ? activeTrim.nextStartSec : seg.startSec;
                      const sampleSourceSec =
                        effectiveStart + ((slotIdx + 0.5) / slotCount) * displayDur;
                      const thumbIdx = Math.max(
                        0,
                        Math.min(
                          thumbnails.length - 1,
                          Math.floor((sampleSourceSec / sourceDuration) * thumbnails.length)
                        )
                      );
                      return thumbnails[thumbIdx];
                    })
                  : [];

              return (
                <div
                  key={seg.sceneId}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                  onPointerDown={(e) => {
                    tappedClipRef.current = {
                      sceneId: seg.sceneId,
                      startX: e.clientX,
                      moved: false,
                    };
                  }}
                  className={`absolute inset-y-0 rounded-md overflow-hidden transition-shadow cursor-pointer ${
                    activeTrim
                      ? "z-20 shadow-md"
                      : isSelected
                        ? "z-10 shadow-md"
                        : "ring-1 ring-neutral-400/70 dark:ring-neutral-700/90 hover:ring-neutral-500"
                  }`}
                >
                  {/* Clip Filmstrip Frames */}
                  <div className="absolute inset-0 bg-neutral-900 flex">
                    {clipThumbs.length > 0 ? (
                      clipThumbs.map((src, tIdx) => (
                        <img
                          key={tIdx}
                          src={src}
                          alt=""
                          draggable={false}
                          referrerPolicy="no-referrer"
                          className="h-full flex-1 min-w-0 object-cover pointer-events-none"
                        />
                      ))
                    ) : (
                      <div className="w-full h-full bg-gradient-to-r from-neutral-800 via-neutral-700 to-neutral-800" />
                    )}
                  </div>

                  {/* Subtle Label Inside Clip */}
                  <div
                    className={`pointer-events-none relative pt-1 flex items-center justify-between text-[10px] font-mono-tabular font-semibold text-white ${
                      isSelected ? "px-4" : "px-2"
                    }`}
                  >
                    <span className="px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-xs truncate">
                      #{idx + 1} · {roundTenth(displayDur)}s
                    </span>
                  </div>

                  {/* Seamless Non-Overlapping Selection Frame & Edge Trim Handles */}
                  {isSelected && (
                    <>
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 left-3.5 right-3.5 h-[2px] bg-teal-600 dark:bg-teal-400 z-20"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 left-3.5 right-3.5 h-[2px] bg-teal-600 dark:bg-teal-400 z-20"
                      />
                      <div
                        role="slider"
                        aria-label={`Scene ${idx + 1} start handle`}
                        aria-valuemin={0}
                        aria-valuemax={seg.endSec}
                        aria-valuenow={seg.startSec}
                        onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-start", seg)}
                        className="absolute left-0 inset-y-0 w-3.5 bg-teal-700 dark:bg-teal-400 text-white dark:text-[#060918] flex items-center justify-center cursor-ew-resize touch-none z-20"
                      >
                        <div className="w-0.5 h-5 rounded-full bg-current opacity-95" />
                      </div>
                      <div
                        role="slider"
                        aria-label={`Scene ${idx + 1} end handle`}
                        aria-valuemin={seg.startSec}
                        aria-valuemax={sourceDuration}
                        aria-valuenow={seg.endSec}
                        onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-end", seg)}
                        className="absolute right-0 inset-y-0 w-3.5 bg-teal-700 dark:bg-teal-400 text-white dark:text-[#060918] flex items-center justify-center cursor-ew-resize touch-none z-20"
                      >
                        <div className="w-0.5 h-5 rounded-full bg-current opacity-95" />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Interactive Subtitles Track + Underlying Original Speech & Waveform Markers */}
          <div className="relative h-16 mt-2">
            {/* Background Speech Bands (align vertically behind subtitles so handles snap visually) */}
            <div className="pointer-events-none absolute inset-0">
              {cutSpeechRegions.map((sr, srIdx) => {
                const leftPx = sr.cutStart * pxPerSec;
                const widthPx = Math.max(4, (sr.cutEnd - sr.cutStart) * pxPerSec);
                const alignedLeft =
                  Boolean(dragSubPreview) &&
                  (Math.abs(dragSubPreview!.startTime - sr.cutStart) <= 0.12 ||
                    Math.abs(dragSubPreview!.endTime - sr.cutStart) <= 0.12);
                const alignedRight =
                  Boolean(dragSubPreview) &&
                  (Math.abs(dragSubPreview!.endTime - sr.cutEnd) <= 0.12 ||
                    Math.abs(dragSubPreview!.startTime - sr.cutEnd) <= 0.12);
                const isEdgeAligned = alignedLeft || alignedRight;

                return (
                  <div
                    key={`sr-${srIdx}-${sr.cutStart.toFixed(2)}`}
                    style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                    className={`absolute inset-y-0 transition-colors ${
                      isEdgeAligned
                        ? "bg-amber-600/22 dark:bg-amber-500/20"
                        : "bg-amber-600/12 dark:bg-amber-500/10"
                    }`}
                  >
                    <div
                      className={`absolute inset-y-0 left-0 w-[1.5px] ${
                        alignedLeft
                          ? "bg-amber-700/85 dark:bg-amber-400/85"
                          : "bg-amber-700/40 dark:bg-amber-500/35"
                      }`}
                    />
                    <div
                      className={`absolute inset-y-0 right-0 w-[1.5px] ${
                        alignedRight
                          ? "bg-amber-700/85 dark:bg-amber-400/85"
                          : "bg-amber-700/40 dark:bg-amber-500/35"
                      }`}
                    />
                  </div>
                );
              })}

              {/* Lower Initial Subtitle Area Highlight Bars (no gray track background) */}
              <div className="absolute inset-x-0 bottom-0.5 h-3">
                {cutSpeechRegions.map((sr, srIdx) => {
                  const leftPx = sr.cutStart * pxPerSec;
                  const widthPx = Math.max(4, (sr.cutEnd - sr.cutStart) * pxPerSec);
                  return (
                    <div
                      key={`sr-bar-${srIdx}-${sr.cutStart.toFixed(2)}`}
                      style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                      className="absolute inset-y-0 rounded-[3px] bg-amber-600/45 dark:bg-amber-500/40 border border-amber-800/45 dark:border-amber-400/45"
                    />
                  );
                })}
              </div>
            </div>

            {/* Unmatched Speech Gap Quick-Fill Highlights */}
            {onTranscribeRange &&
              unmatchedSpeechGaps.map((gap, gapIdx) => {
                const leftPx = gap.startSec * pxPerSec;
                const widthPx = Math.max(20, gap.durationSec * pxPerSec);
                const isGapBusy =
                  Boolean(transcribingRange) &&
                  Math.abs(transcribingRange!.startSec - gap.startSec) < 0.25 &&
                  Math.abs(transcribingRange!.endSec - gap.endSec) < 0.25;
                return (
                  <button
                    key={`unmatched-gap-${gapIdx}-${gap.startSec.toFixed(2)}`}
                    type="button"
                    disabled={Boolean(transcribingRange)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runRangeTranscribe(gap.startSec, gap.endSec);
                    }}
                    style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                    title={`Unmatched speech (${formatTimePrecise(gap.startSec)} – ${formatTimePrecise(gap.endSec)}). Click to AI fill.`}
                    className={`absolute top-0 h-10 rounded-md border border-dashed flex items-center justify-center gap-1 px-1.5 overflow-hidden transition-colors cursor-pointer z-[5] disabled:opacity-60 ${
                      isGapBusy
                        ? "border-teal-600 bg-teal-500/20 text-teal-800 dark:border-teal-400 dark:bg-teal-500/25 dark:text-teal-200"
                        : "border-amber-600/75 bg-amber-500/15 hover:bg-amber-500/28 text-amber-900 dark:border-amber-400/70 dark:bg-amber-500/15 dark:hover:bg-amber-500/25 dark:text-amber-200"
                    }`}
                  >
                    {isGapBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    ) : (
                      <Sparkles className="w-3 h-3 shrink-0" />
                    )}
                    {widthPx >= 52 && (
                      <span className="text-[10px] font-semibold truncate">
                        {isGapBusy ? "Filling…" : "AI Fill"}
                      </span>
                    )}
                  </button>
                );
              })}

            {/* Upper Subtitle Clips Row */}
            {project.subtitles.map((sub, subIdx) => {
              const preview = dragSubPreview?.id === sub.id ? dragSubPreview : null;
              const startTime = preview ? preview.startTime : sub.startTime;
              const endTime = preview ? preview.endTime : sub.endTime;
              const dur = Math.max(0.2, endTime - startTime);
              const leftPx = startTime * pxPerSec;
              const widthPx = Math.max(22, dur * pxPerSec);
              const isSelected = sub.id === activeSubId;
              const isAtPlayhead = cutTime >= startTime && cutTime <= endTime;

              return (
                <div
                  key={sub.id}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                  onPointerDown={(e) => {
                    if (isSelected && onUpdateSubtitleTiming) {
                      handlePointerDownSubInteraction(e, "sub-move", sub, subIdx);
                    } else {
                      tappedSubRef.current = {
                        subId: sub.id,
                        startTime: sub.startTime,
                        startX: e.clientX,
                        moved: false,
                      };
                    }
                  }}
                  title={`#${subIdx + 1} (${formatTimePrecise(startTime)} – ${formatTimePrecise(endTime)}): ${sub.burmese || sub.thaiPhonetic}`}
                  className={`absolute top-0 h-10 rounded-md overflow-hidden flex items-center transition-shadow ${
                    isSelected
                      ? "bg-[#1c3db8] dark:bg-[#264cd6] text-white px-4 z-10 shadow-sm cursor-grab active:cursor-grabbing touch-none"
                      : isAtPlayhead
                        ? "bg-[#e6ecfc] dark:bg-[#101c45] text-[#142d87] dark:text-[#a8c3fa] px-2 ring-1 ring-[#264cd6]/70 dark:ring-[#4e7ef7]/60 cursor-pointer"
                        : "bg-white/95 dark:bg-[#141933]/95 text-[#0c1026] dark:text-[#f3f5fc] px-2 ring-1 ring-[#bcc9e6] dark:ring-[#2f3866] hover:ring-[#264cd6]/60 cursor-pointer"
                  }`}
                >
                  <div className="pointer-events-none flex items-center gap-1.5 min-w-0 w-full">
                    <span
                      className={`text-[10px] font-mono-tabular font-bold shrink-0 ${
                        isSelected
                          ? "text-[#d5e2fc]"
                          : "text-[#1c3db8] dark:text-[#7ca3fb]"
                      }`}
                    >
                      S{subIdx + 1}
                    </span>
                    <span className="text-[11px] font-medium truncate">
                      {sub.burmese || sub.thaiPhonetic}
                    </span>
                  </div>

                  {isSelected && onUpdateSubtitleTiming && (
                    <>
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 left-3 right-3 h-[2px] bg-[#89aef9] dark:bg-[#93b5fa]/85 z-20"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 left-3 right-3 h-[2px] bg-[#89aef9] dark:bg-[#93b5fa]/85 z-20"
                      />
                      <div
                        role="slider"
                        aria-label={`Subtitle ${subIdx + 1} start handle`}
                        aria-valuemin={0}
                        aria-valuemax={endTime}
                        aria-valuenow={startTime}
                        onPointerDown={(e) =>
                          handlePointerDownSubInteraction(e, "sub-trim-start", sub, subIdx)
                        }
                        className="absolute left-0 inset-y-0 w-3 bg-[#132b85] dark:bg-[#4e7ef7] text-white dark:text-[#060918] flex items-center justify-center cursor-ew-resize touch-none z-20"
                      >
                        <div className="w-0.5 h-4 rounded-full bg-current opacity-90" />
                      </div>
                      <div
                        role="slider"
                        aria-label={`Subtitle ${subIdx + 1} end handle`}
                        aria-valuemin={startTime}
                        aria-valuemax={totalCutDuration}
                        aria-valuenow={endTime}
                        onPointerDown={(e) =>
                          handlePointerDownSubInteraction(e, "sub-trim-end", sub, subIdx)
                        }
                        className="absolute right-0 inset-y-0 w-3 bg-[#132b85] dark:bg-[#4e7ef7] text-white dark:text-[#060918] flex items-center justify-center cursor-ew-resize touch-none z-20"
                      >
                        <div className="w-0.5 h-4 rounded-full bg-current opacity-90" />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Dedicated Open Scroll Space Below Clips & Subtitles */}
          <div
            aria-hidden="true"
            className="h-14 mt-2 border-t border-dashed border-[#bcc9e6] dark:border-[#21284c]"
          />
        </div>

        {/* Fixed Center Playhead Line */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center"
        >
          <div className="w-3 h-3 rounded-b-sm bg-teal-700 dark:bg-teal-400 shadow-sm" />
          <div className="w-[2px] flex-1 bg-teal-700 dark:bg-teal-400 shadow-[0_0_5px_rgba(28,61,184,0.38)]" />
        </div>

        {/* Live Trim Timestamp Badge */}
        {dragBadge && (
          <div className="pointer-events-none absolute top-2 right-2.5 z-30 px-2 py-0.5 rounded bg-[#070814]/90 text-white text-[11px] font-mono-tabular shadow">
            {dragBadge.label}: {formatTimePrecise(dragBadge.sec)}
          </div>
        )}

      </div>
      )}

      {/* Kept Scenes Summary List (inline below in standard mode, or toggled drawer in dockMode) */}
      {(!dockMode || showDockScenes) && (
      <div
        className={
          dockMode
            ? "border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] max-h-36 overflow-y-auto studio-scrollbar"
            : "border-y border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden"
        }
      >
        {segments.length === 0 ? (
          <div className="p-4 text-center space-y-2">
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
              All clips were deleted. Restore the original clips to split and keep the parts you want.
            </p>
            <button
              type="button"
              onClick={handleRestoreOriginal}
              className="h-8 px-3 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Original Clips</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c]">
            {segments.map((seg, idx) => {
              const isSelected = seg.sceneId === activeSceneId;
              const dur = roundTenth(seg.clipDur);
              return (
                <div
                  key={seg.sceneId}
                  onClick={() => {
                    if (isPlaying) onPause();
                    setActiveSceneId(seg.sceneId);
                    dispatchSeek(seg.cutStart, true);
                  }}
                  className={`px-3.5 py-2 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-teal-50/70 dark:bg-teal-950/30"
                      : "bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#141933]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`text-[11px] font-mono-tabular font-semibold shrink-0 ${
                        isSelected ? "text-teal-700 dark:text-teal-400" : "text-[#4d597d] dark:text-[#919ec4]"
                      }`}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                      Clip {idx + 1}
                    </span>
                    <span className="text-xs font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
                      {formatTimePrecise(seg.startSec)} – {formatTimePrecise(seg.endSec)}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.currentTarget.blur();
                        setActiveSceneId(seg.sceneId);
                        onPlayFromTime(seg.cutStart);
                      }}
                      title={`Play Clip ${idx + 1}`}
                      aria-label={`Play Clip ${idx + 1}`}
                      className="p-1 text-[#4d597d] hover:text-teal-700 dark:text-[#919ec4] dark:hover:text-teal-400 transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-xs font-mono-tabular font-medium text-[#0c1026] dark:text-[#f3f5fc]">
                      {dur}s
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.currentTarget.blur();
                        handleDeleteClip(seg.sceneId);
                      }}
                      aria-label={`Delete clip ${idx + 1}`}
                      className="p-1 text-[#4d597d] dark:text-[#919ec4] hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
