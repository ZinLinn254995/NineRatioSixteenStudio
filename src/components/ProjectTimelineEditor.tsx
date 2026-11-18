import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { SpeakingScene, SubtitleItem, VideoProject } from "../types";
import { ensureSceneIds, roundTenth } from "../utils/projectTimeline";

interface ProjectTimelineEditorProps {
  project: VideoProject | null;
  cutTime: number;
  isPlaying: boolean;
  isActive?: boolean;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (sec: number) => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateScenes: (nextScenes: SpeakingScene[]) => void;
  onRestoreSnapshot: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onGoToScenes?: () => void;
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
      startClientX: number;
      startCutTime: number;
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
  isPlaying,
  isActive = true,
  onTogglePlay,
  onPause,
  onSeek,
  onPlayFromTime,
  onUpdateScenes,
  onRestoreSnapshot,
  onResetTimeline,
  onGoToScenes,
}: ProjectTimelineEditorProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [pxPerSec, setPxPerSec] = useState(32);
  const [viewportWidth, setViewportWidth] = useState(560);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragMode | null>(null);
  const [frozenTrackTime, setFrozenTrackTime] = useState<number | null>(null);
  const [dragBadge, setDragBadge] = useState<{ label: string; sec: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  const dragStateRef = useRef<DragMode | null>(null);
  dragStateRef.current = dragState;
  const lastDragTargetRef = useRef<{ cutTime: number; sourceSec: number } | null>(null);
  const trimPreUndoRef = useRef<UndoEntry | null>(null);
  const lastSeekDispatchAtRef = useRef<number>(0);
  const seekThrottleTimerRef = useRef<number | null>(null);
  const queuedSeekSecRef = useRef<number | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; pxPerSec: number } | null>(null);
  const tappedClipRef = useRef<{ sceneId: string; startX: number; moved: boolean } | null>(null);

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
    setFrozenTrackTime(null);
    setDragState(null);
    setDragBadge(null);
    setUndoStack([]);
  }, [projectIdentity]);

  // Keep activeSceneId synced to existing scenes
  useEffect(() => {
    if (segments.length === 0) {
      setActiveSceneId(null);
    } else if (!activeSceneId || !segments.some((s) => s.sceneId === activeSceneId)) {
      setActiveSceneId(segments[0].sceneId);
    }
  }, [segments, activeSceneId]);

  // Measure timeline viewport width so center playhead stays exact
  useEffect(() => {
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
  }, [projectIdentity]);

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

    let cancelled = false;
    const targetCount = Math.min(24, Math.max(10, Math.ceil(sourceDuration / 4)));
    const hiddenVid = document.createElement("video");
    hiddenVid.muted = true;
    hiddenVid.playsInline = true;
    hiddenVid.preload = "metadata";

    const captureFrames = async () => {
      await new Promise((r) => setTimeout(r, 180));
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
          : sourceDuration;
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
          if (frames.length % 4 === 0 || frames.length === targetCount) {
            setThumbnails([...frames]);
          }
        } catch {
          break;
        }
      }
    };

    captureFrames().finally(() => {
      hiddenVid.onloadeddata = null;
      hiddenVid.onerror = null;
      hiddenVid.removeAttribute("src");
    });

    return () => {
      cancelled = true;
      hiddenVid.onloadeddata = null;
      hiddenVid.onerror = null;
      hiddenVid.removeAttribute("src");
    };
  }, [project?.sourceType, project?.localUrl, project?.videoId, project?.keyframeUrls, sourceDuration]);

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
    setActiveSceneId(prev.scenes[0]?.id ?? null);
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

  const trackCenterTime = frozenTrackTime ?? cutTime;
  const centerX = viewportWidth / 2;
  const trackWidth = Math.max(totalCutDuration * pxPerSec, 1);
  const trackTranslateX = centerX - trackCenterTime * pxPerSec;

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

  const handlePointerDownViewport = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();

    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (isPlaying) onPause();

    if (activePointersRef.current.size === 2) {
      dragStateRef.current = null;
      setDragState(null);
      setDragBadge(null);
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      pinchStartRef.current = { dist, pxPerSec };
      return;
    }

    if (activePointersRef.current.size === 1) {
      pinchStartRef.current = null;
      setDragState({
        type: "scrub",
        startClientX: e.clientX,
        startCutTime: cutTimeRef.current,
      });
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

    setActiveSceneId(seg.sceneId);
    setFrozenTrackTime(cutTimeRef.current);
    setDragState({
      type: mode,
      sceneId: seg.sceneId,
      startClientX: e.clientX,
      origStartSec: seg.startSec,
      origEndSec: seg.endSec,
      origCutStart: seg.cutStart,
    });
  };

  const handlePointerMoveViewport = (e: React.PointerEvent<HTMLElement>) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (activePointersRef.current.size >= 2 && pinchStartRef.current) {
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
    const dx = e.clientX - activeDrag.startClientX;
    if (tappedClipRef.current && Math.abs(dx) > 5) {
      tappedClipRef.current.moved = true;
    }
    const dt = dx / pxPerSec;

    if (activeDrag.type === "scrub") {
      const nextCut = Math.max(
        0,
        Math.min(totalCutDurationRef.current, activeDrag.startCutTime - dt)
      );
      dispatchSeek(nextCut);
      return;
    }

    if (activeDrag.type === "trim-start") {
      const nextStart = roundTenth(
        Math.max(0, Math.min(activeDrag.origEndSec - 0.5, activeDrag.origStartSec + dt))
      );
      const nextScenes = normalizedScenesRef.current.map((sc) =>
        sc.id === activeDrag.sceneId
          ? {
              ...sc,
              startSec: nextStart,
              durationSec: roundTenth(activeDrag.origEndSec - nextStart),
            }
          : sc
      );
      lastDragTargetRef.current = {
        cutTime: activeDrag.origCutStart,
        sourceSec: nextStart,
      };
      onUpdateScenes(nextScenes);
      dispatchSeek(activeDrag.origCutStart);
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
      const nextClipDur = Math.max(0.5, nextEnd - activeDrag.origStartSec);
      const nextScenes = normalizedScenesRef.current.map((sc) =>
        sc.id === activeDrag.sceneId
          ? {
              ...sc,
              endSec: nextEnd,
              durationSec: roundTenth(nextClipDur),
            }
          : sc
      );
      const previewCut = Math.max(0, activeDrag.origCutStart + nextClipDur - 0.05);
      lastDragTargetRef.current = {
        cutTime: activeDrag.origCutStart + nextClipDur,
        sourceSec: nextEnd,
      };
      onUpdateScenes(nextScenes);
      dispatchSeek(previewCut);
      setDragBadge({ label: "Out", sec: nextEnd });
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
        return;
      }
      dragStateRef.current = null;

      if (activeDrag.type === "scrub" && tappedClipRef.current && !tappedClipRef.current.moved) {
        setActiveSceneId(tappedClipRef.current.sceneId);
      }
      tappedClipRef.current = null;

      if (activeDrag.type === "scrub") {
        if (queuedSeekSecRef.current !== null) {
          dispatchSeek(queuedSeekSecRef.current, true);
        }
      } else {
        if (trimPreUndoRef.current && lastDragTargetRef.current) {
          const snapshot = trimPreUndoRef.current;
          setUndoStack((prev) => [...prev.slice(-29), snapshot]);
        }
        trimPreUndoRef.current = null;

        const target = lastDragTargetRef.current;
        if (target) {
          dispatchSeek(target.cutTime, true);
        }
        lastDragTargetRef.current = null;
        setFrozenTrackTime(null);
      }

      setDragBadge(null);
      setDragState(null);
    },
    [dispatchSeek]
  );

  // Safety fallback if pointerup happens outside captured element
  useEffect(() => {
    if (!dragState) return;
    const onWinUp = (ev: PointerEvent) => handlePointerUpAny(ev);
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinUp);
    return () => {
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinUp);
    };
  }, [dragState, handlePointerUpAny]);

  // Two-finger trackpad pinch-to-zoom (ctrlKey + wheel) & horizontal/vertical scroll scrub
  const wheelStateRef = useRef({ pxPerSec, dispatchSeek, isPlaying, onPause });
  wheelStateRef.current = { pxPerSec, dispatchSeek, isPlaying, onPause };
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.008);
        setPxPerSec((z) => clampZoom(Math.round(z * factor)));
        return;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 1) return;
      e.preventDefault();
      const {
        pxPerSec: pps,
        dispatchSeek: seek,
        isPlaying: playing,
        onPause: pause,
      } = wheelStateRef.current;
      if (playing) pause();
      seek(cutTimeRef.current + delta / pps);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [projectIdentity]);

  // Empty "No video" state when subtitles have not been generated yet
  if (!project) {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <div className="w-full aspect-video rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 flex flex-col items-center justify-center text-center p-6 gap-3">
          <div className="w-10 h-10 rounded-full bg-neutral-200/80 dark:bg-neutral-800 flex items-center justify-center text-neutral-700 dark:text-neutral-200">
            <Film className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-sm">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              No video
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
              Generate subtitles first to edit your 9:16 video on the timeline before downloading.
            </p>
          </div>
          {onGoToScenes && (
            <button
              type="button"
              onClick={onGoToScenes}
              className="mt-1 h-9 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap cursor-pointer hover:opacity-90 transition-opacity"
            >
              <span>Go to Watch & Scenes</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 pb-6">
      {/* Generated 9:16 Video Summary Header */}
      <div className="px-3.5 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {project.title}
          </p>
          <p className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400">
            9:16 Subtitle Video · {segments.length} {segments.length === 1 ? "scene" : "scenes"} ·{" "}
            {roundTenth(totalCutDuration)}s
          </p>
        </div>
      </div>

      {/* Transport & Split / Delete Cut Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              onTogglePlay();
            }}
            disabled={segments.length === 0}
            aria-label={isPlaying ? "Pause video" : "Play video"}
            className="h-8 w-8 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 flex items-center justify-center hover:opacity-90 disabled:opacity-40 cursor-pointer shrink-0"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
          </button>

          <span className="text-xs font-mono-tabular text-neutral-900 dark:text-neutral-100">
            {formatTimePrecise(cutTime)}
            <span className="text-neutral-400 dark:text-neutral-500">
              {" "}
              / {formatTimePrecise(totalCutDuration)}
            </span>
          </span>
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
            className="h-8 px-2.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
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
            className="h-8 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
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
            className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
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
            className="h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <div className="inline-flex items-center border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden ml-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(Math.round(z * 0.75)));
              }}
              aria-label="Zoom out timeline"
              className="h-8 w-7 flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer"
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
              className="h-8 w-7 flex items-center justify-center border-l border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Fixed-Center-Playhead Split & Delete Timeline with Dedicated Bottom Scroll Space */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDownViewport}
        onPointerMove={handlePointerMoveViewport}
        onPointerUp={handlePointerUpAny}
        onPointerCancel={handlePointerUpAny}
        onLostPointerCapture={handlePointerUpAny}
        className="relative h-48 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing"
      >
        {/* Moving Timeline Content Track */}
        <div
          style={{
            width: `${trackWidth}px`,
            transform: `translate3d(${trackTranslateX}px, 0, 0)`,
          }}
          className="absolute inset-y-0 left-0 will-change-transform"
        >
          {/* Time Ruler Ticks (Cut Timeline Seconds) */}
          <div className="relative h-6 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/90 dark:bg-neutral-950/90">
            {rulerTicks.map((s) => (
              <div
                key={s}
                style={{ left: `${s * pxPerSec}px` }}
                className="absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none"
              >
                <span className="text-[10px] font-mono-tabular text-neutral-500 dark:text-neutral-400 pl-1 leading-none pb-1">
                  {formatRulerTick(s)}
                </span>
                <div className="w-px h-1.5 bg-neutral-300 dark:bg-neutral-700" />
              </div>
            ))}
          </div>

          {/* Kept Video Clips Track */}
          <div className="relative h-16 mt-2">
            {segments.map((seg, idx) => {
              const leftPx = seg.cutStart * pxPerSec;
              const widthPx = Math.max(18, seg.clipDur * pxPerSec);
              const isSelected = seg.sceneId === activeSceneId;

              const slotCount = Math.max(2, Math.min(18, Math.ceil(widthPx / 52)));
              const clipThumbs =
                thumbnails.length > 0
                  ? Array.from({ length: slotCount }, (_, slotIdx) => {
                      const sampleSourceSec =
                        seg.startSec + ((slotIdx + 0.5) / slotCount) * seg.clipDur;
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
                  className={`absolute inset-y-0 rounded-md overflow-visible transition-shadow cursor-pointer ${
                    isSelected
                      ? "ring-2 ring-indigo-500 dark:ring-indigo-400 z-10 shadow-sm"
                      : "ring-1 ring-neutral-400/70 dark:ring-neutral-600/80 hover:ring-neutral-500"
                  }`}
                >
                  {/* Clip Filmstrip Frames */}
                  <div className="absolute inset-0 rounded-md overflow-hidden bg-neutral-800 flex">
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
                      <div className="w-full h-full bg-gradient-to-r from-neutral-700 via-neutral-600 to-neutral-700" />
                    )}
                  </div>

                  {/* Subtle Label Inside Clip */}
                  <div className="pointer-events-none relative px-2 pt-1 flex items-center justify-between text-[10px] font-mono-tabular font-semibold text-white">
                    <span className="px-1.5 py-0.5 rounded bg-black/65 backdrop-blur-xs truncate">
                      #{idx + 1} · {roundTenth(seg.clipDur)}s
                    </span>
                  </div>

                  {/* Left Start Trim Handle */}
                  {isSelected && (
                    <div
                      role="slider"
                      aria-label={`Scene ${idx + 1} start handle`}
                      aria-valuemin={0}
                      aria-valuemax={seg.endSec}
                      aria-valuenow={seg.startSec}
                      onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-start", seg)}
                      className="absolute left-0 inset-y-0 w-3.5 -translate-x-1/2 rounded-l-md bg-indigo-600 text-white shadow flex items-center justify-center cursor-ew-resize z-20"
                    >
                      <div className="w-0.5 h-5 rounded-full bg-white/90" />
                    </div>
                  )}

                  {/* Right End Trim Handle */}
                  {isSelected && (
                    <div
                      role="slider"
                      aria-label={`Scene ${idx + 1} end handle`}
                      aria-valuemin={seg.startSec}
                      aria-valuemax={sourceDuration}
                      aria-valuenow={seg.endSec}
                      onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-end", seg)}
                      className="absolute right-0 inset-y-0 w-3.5 translate-x-1/2 rounded-r-md bg-indigo-600 text-white shadow flex items-center justify-center cursor-ew-resize z-20"
                    >
                      <div className="w-0.5 h-5 rounded-full bg-white/90" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Dedicated One-Clip-Height Open Scroll Space Below Clips */}
          <div
            aria-hidden="true"
            className="h-20 mt-2 border-t border-dashed border-neutral-300/70 dark:border-neutral-700/70"
          />
        </div>

        {/* Fixed Center Playhead Line */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center"
        >
          <div className="w-3 h-3 rounded-b-sm bg-neutral-950 dark:bg-white shadow-sm" />
          <div className="w-[2px] flex-1 bg-neutral-950 dark:bg-white shadow-[0_0_6px_rgba(0,0,0,0.45)]" />
        </div>

        {/* Live Trim Timestamp Badge */}
        {dragBadge && (
          <div className="pointer-events-none absolute top-2 right-2.5 z-30 px-2 py-0.5 rounded-md bg-black/80 text-white text-[11px] font-mono-tabular shadow">
            {dragBadge.label}: {formatTimePrecise(dragBadge.sec)}
          </div>
        )}

        {/* Bottom Free-Scroll Zone Hint */}
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-2.5 py-0.5 rounded-full bg-black/55 text-white/90 text-[10px] whitespace-nowrap">
          {segments.length === 0
            ? "No clips kept · Click Reset to restore scenes"
            : "Drag open space below to scroll timeline · Pinch with two fingers to zoom"}
        </div>
      </div>

      {/* Kept Scenes Summary List */}
      <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
        {segments.length === 0 ? (
          <div className="p-5 text-center space-y-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              All clips were deleted. Restore the original scenes to split and keep the clips you want.
            </p>
            <button
              type="button"
              onClick={handleRestoreOriginal}
              className="h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Original Scenes</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
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
                      ? "bg-indigo-50/70 dark:bg-indigo-950/30"
                      : "bg-white dark:bg-neutral-950 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isSelected ? "bg-indigo-600 dark:bg-indigo-400" : "bg-neutral-400"
                      }`}
                    />
                    <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                      Scene {idx + 1}
                    </span>
                    <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400">
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
                      title={`Play Scene ${idx + 1}`}
                      aria-label={`Play Scene ${idx + 1}`}
                      className="p-1 text-neutral-500 hover:text-indigo-600 dark:text-neutral-400 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-xs font-mono-tabular font-medium text-neutral-700 dark:text-neutral-300">
                      {dur}s
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.currentTarget.blur();
                        handleDeleteClip(seg.sceneId);
                      }}
                      aria-label={`Delete scene ${idx + 1}`}
                      className="p-1 text-neutral-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
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
    </div>
  );
}
