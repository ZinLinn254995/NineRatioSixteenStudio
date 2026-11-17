import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  ActiveMediaSource,
  SceneSelection,
  VideoEditSettings,
  VoiceSettings,
} from "../types";
import { buildCssFilterString, buildCssTransformString } from "../utils/videoFilters";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { applyVoiceEffectsToVideoElement, resumeAllVoiceContexts } from "../utils/webAudioVoice";

interface LocalVideoTimelineEditorProps {
  media: ActiveMediaSource;
  scenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes?: (scenes: SceneSelection[]) => void;
  onDetectedDuration?: (dur: number) => void;
}

interface ClipSegment {
  scene: SceneSelection;
  index: number;
  startSec: number;
  endSec: number;
  clipDur: number;
  cutStart: number;
  cutEnd: number;
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

function roundTenth(sec: number): number {
  return Math.round(sec * 10) / 10;
}

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

export function LocalVideoTimelineEditor({
  media,
  scenes,
  voiceSettings,
  editSettings,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onDetectedDuration,
}: LocalVideoTimelineEditorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [sourceDuration, setSourceDuration] = useState<number>(() =>
    Math.max(1, media.durationSec || 30)
  );
  const [cutTime, setCutTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(32);
  const [viewportWidth, setViewportWidth] = useState(560);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragMode | null>(null);
  const [frozenTrackTime, setFrozenTrackTime] = useState<number | null>(null);
  const [dragBadge, setDragBadge] = useState<{ label: string; sec: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<SceneSelection[][]>([]);

  const dragStateRef = useRef<DragMode | null>(null);
  dragStateRef.current = dragState;
  const lastDragTargetRef = useRef<{ cutTime: number; sourceSec: number } | null>(null);
  const trimPreUndoRef = useRef<SceneSelection[] | null>(null);
  const pendingSeekSecRef = useRef<number | null>(null);
  const seekRafRef = useRef<number>(0);
  const activePlaybackIdxRef = useRef<number>(0);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; pxPerSec: number } | null>(null);
  const tappedClipRef = useRef<{ sceneId: string; startX: number; moved: boolean } | null>(null);

  // Packed magnetic cut-timeline segments built strictly from remaining scenes
  const { segments, totalCutDuration } = useMemo(() => {
    const list: ClipSegment[] = [];
    let cursor = 0;
    scenes.forEach((sc, idx) => {
      const dur = Math.max(0.1, sc.endSec - sc.startSec);
      const cutStart = cursor;
      const cutEnd = cursor + dur;
      list.push({
        scene: sc,
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
  }, [scenes]);

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const totalCutDurationRef = useRef(totalCutDuration);
  totalCutDurationRef.current = totalCutDuration;
  const cutTimeRef = useRef(cutTime);
  cutTimeRef.current = cutTime;

  // Map packed cut-timeline position -> source video timestamp
  const mapCutTimeToSource = useCallback(
    (targetCutTime: number): { segIndex: number; sourceSec: number } => {
      const segs = segmentsRef.current;
      if (segs.length === 0) return { segIndex: 0, sourceSec: 0 };
      const clamped = Math.max(0, Math.min(totalCutDurationRef.current, targetCutTime));
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (clamped < seg.cutEnd - 0.0005 || i === segs.length - 1) {
          const offset = Math.max(0, Math.min(seg.clipDur, clamped - seg.cutStart));
          return {
            segIndex: i,
            sourceSec: Math.min(seg.endSec, seg.startSec + offset),
          };
        }
      }
      return { segIndex: 0, sourceSec: segs[0].startSec };
    },
    []
  );

  // Reset only when switching to a different local video URL
  useEffect(() => {
    setIsPlaying(false);
    setCutTime(0);
    setFrozenTrackTime(null);
    setDragState(null);
    setUndoStack([]);
    pendingSeekSecRef.current = null;
    activePlaybackIdxRef.current = 0;
    setSourceDuration(Math.max(1, media.durationSec || 30));
  }, [media.localUrl]);

  // Keep activeSceneId synced to existing scenes
  useEffect(() => {
    if (scenes.length === 0) {
      setActiveSceneId(null);
    } else if (!activeSceneId || !scenes.some((s) => s.id === activeSceneId)) {
      setActiveSceneId(scenes[0].id);
    }
  }, [scenes, activeSceneId]);

  // Clamp cutTime if clips were deleted or shortened
  useEffect(() => {
    if (dragStateRef.current) return;
    if (cutTime > totalCutDuration) {
      setCutTime(totalCutDuration);
    }
  }, [totalCutDuration, cutTime]);

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
  }, []);

  // Capture lightweight filmstrip thumbnails across the full source video
  useEffect(() => {
    if (!media.localUrl || sourceDuration <= 0) {
      setThumbnails([]);
      return;
    }

    let cancelled = false;
    const targetCount = Math.min(24, Math.max(10, Math.ceil(sourceDuration / 4)));
    const hiddenVid = document.createElement("video");
    hiddenVid.muted = true;
    hiddenVid.playsInline = true;
    hiddenVid.preload = "auto";
    hiddenVid.src = media.localUrl;

    const captureFrames = async () => {
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
      hiddenVid.removeAttribute("src");
      hiddenVid.load();
    });

    return () => {
      cancelled = true;
      hiddenVid.removeAttribute("src");
      hiddenVid.load();
    };
  }, [media.localUrl, sourceDuration]);

  // Voice & speed sync (only attach WebAudio graph when effects are active)
  const hasVoiceEffects =
    Math.abs(voiceSettings.pitchSemitones) >= 0.08 ||
    Math.abs(voiceSettings.tone) > 0 ||
    voiceSettings.echo > 0 ||
    voiceSettings.robot > 0;
  const voiceAttachedRef = useRef(false);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const speed = getEffectivePlaybackSpeed(
      "local",
      editSettings.playbackSpeed,
      voiceSettings.speed
    );
    vid.preservesPitch = true;
    (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    vid.playbackRate = speed;
    if (hasVoiceEffects || voiceAttachedRef.current) {
      voiceAttachedRef.current = true;
      applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);
    }
  }, [voiceSettings, editSettings.playbackSpeed, isPlaying, hasVoiceEffects]);

  // Coalesce rapid drag seeks so the HTML5 video decoder never stalls on queued seeks
  const scheduleSourcePreviewSeek = useCallback(
    (sourceSec: number) => {
      const vid = videoRef.current;
      if (!vid) return;
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.02), sourceSec));
      pendingSeekSecRef.current = clamped;

      if (seekRafRef.current) return;
      seekRafRef.current = requestAnimationFrame(() => {
        seekRafRef.current = 0;
        const v = videoRef.current;
        const next = pendingSeekSecRef.current;
        if (!v || next === null) return;
        if (!v.seeking) {
          pendingSeekSecRef.current = null;
          if (Math.abs(v.currentTime - next) > 0.01) {
            v.currentTime = next;
          }
        }
      });
    },
    [sourceDuration]
  );

  useEffect(() => {
    return () => {
      if (seekRafRef.current) cancelAnimationFrame(seekRafRef.current);
    };
  }, []);

  // 60fps packed cut-timeline playback loop (skips deleted sections seamlessly!)
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const vid = videoRef.current;
      const segs = segmentsRef.current;
      if (vid && segs.length > 0 && !vid.paused && !vid.seeking) {
        const idx = Math.min(activePlaybackIdxRef.current, segs.length - 1);
        const seg = segs[idx];
        const srcT = vid.currentTime;

        if (srcT < seg.startSec - 0.18) {
          vid.currentTime = seg.startSec;
        } else if (srcT >= seg.endSec - 0.03) {
          if (idx + 1 < segs.length) {
            const nextIdx = idx + 1;
            const nextSeg = segs[nextIdx];
            activePlaybackIdxRef.current = nextIdx;
            // Only seek when there is an actual cut gap; contiguous splits flow smoothly
            if (Math.abs(nextSeg.startSec - srcT) > 0.18) {
              vid.currentTime = nextSeg.startSec;
            }
            setCutTime(nextSeg.cutStart);
          } else {
            vid.pause();
            setIsPlaying(false);
            setCutTime(totalCutDurationRef.current);
            return;
          }
        } else {
          const offset = Math.max(0, Math.min(seg.clipDur, srcT - seg.startSec));
          setCutTime(seg.cutStart + offset);
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const seekCutTo = useCallback(
    (targetCut: number, pauseFirst = false) => {
      const maxCut = totalCutDurationRef.current;
      const clampedCut = Math.max(0, Math.min(maxCut, targetCut));
      const { segIndex, sourceSec } = mapCutTimeToSource(clampedCut);
      activePlaybackIdxRef.current = segIndex;

      const vid = videoRef.current;
      if (vid) {
        if (pauseFirst && !vid.paused) {
          vid.pause();
        }
        scheduleSourcePreviewSeek(sourceSec);
      }
      setCutTime(clampedCut);
      return clampedCut;
    },
    [mapCutTimeToSource, scheduleSourcePreviewSeek]
  );

  const playFromCutTime = useCallback(
    (explicitCutTime?: number) => {
      const vid = videoRef.current;
      const segs = segmentsRef.current;
      if (!vid || segs.length === 0) return;

      if (hasVoiceEffects || voiceAttachedRef.current) {
        resumeAllVoiceContexts();
      }

      const maxCut = totalCutDurationRef.current;
      const startCut =
        typeof explicitCutTime === "number"
          ? Math.max(0, Math.min(Math.max(0, maxCut - 0.05), explicitCutTime))
          : cutTimeRef.current >= maxCut - 0.06
            ? 0
            : cutTimeRef.current;

      const { segIndex, sourceSec } = mapCutTimeToSource(startCut);
      activePlaybackIdxRef.current = segIndex;
      pendingSeekSecRef.current = null;
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
      vid.currentTime = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
      setCutTime(startCut);

      const playPromise = vid.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            setIsPlaying(!vid.paused);
          })
          .catch(() => {
            setIsPlaying(!vid.paused);
          });
      } else {
        setIsPlaying(!vid.paused);
      }
    },
    [hasVoiceEffects, mapCutTimeToSource, sourceDuration]
  );

  const togglePlay = useCallback(() => {
    const vid = videoRef.current;
    if (!vid || segmentsRef.current.length === 0) return;
    if (vid.paused || vid.ended) {
      playFromCutTime();
    } else {
      vid.pause();
      setIsPlaying(false);
    }
  }, [playFromCutTime]);

  const applyScenesMutation = useCallback(
    (nextScenes: SceneSelection[], recordUndo = true) => {
      if (recordUndo) {
        setUndoStack((prev) => [...prev.slice(-29), scenes.map((s) => ({ ...s }))]);
      }
      if (onReplaceScenes) {
        onReplaceScenes(nextScenes);
      } else {
        // Fallback if parent didn't pass onReplaceScenes
        nextScenes.forEach((ns) => {
          const existing = scenes.find((s) => s.id === ns.id);
          if (existing) onUpdateScene(ns.id, ns.startSec, ns.endSec);
        });
      }
    },
    [scenes, onReplaceScenes, onUpdateScene]
  );

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
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    const localOffset = cutTime - segmentAtPlayhead.cutStart;
    const splitSourceSec = roundTenth(segmentAtPlayhead.startSec + localOffset);
    if (
      splitSourceSec <= segmentAtPlayhead.startSec + 0.35 ||
      splitSourceSec >= segmentAtPlayhead.endSec - 0.35
    ) {
      return;
    }

    const leftClip: SceneSelection = {
      id: segmentAtPlayhead.scene.id,
      startSec: segmentAtPlayhead.startSec,
      endSec: splitSourceSec,
    };
    const rightClip: SceneSelection = {
      id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      startSec: splitSourceSec,
      endSec: segmentAtPlayhead.endSec,
    };

    const nextScenes = [
      ...scenes.slice(0, segmentAtPlayhead.index),
      leftClip,
      rightClip,
      ...scenes.slice(segmentAtPlayhead.index + 1),
    ];
    applyScenesMutation(nextScenes, true);
    setActiveSceneId(rightClip.id);
  }, [segmentAtPlayhead, canSplitAtPlayhead, cutTime, scenes, applyScenesMutation]);

  const targetClipForDelete = useMemo(() => {
    if (segments.length === 0) return null;
    return (
      segments.find((s) => s.scene.id === activeSceneId) ??
      segmentAtPlayhead ??
      segments[0]
    );
  }, [segments, activeSceneId, segmentAtPlayhead]);

  const handleDeleteClip = useCallback(
    (targetId?: string) => {
      const segToDelete = targetId
        ? segments.find((s) => s.scene.id === targetId)
        : targetClipForDelete;
      if (!segToDelete) return;

      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }

      const nextScenes = scenes.filter((s) => s.id !== segToDelete.scene.id);
      if (onReplaceScenes) {
        applyScenesMutation(nextScenes, true);
      } else {
        onRemoveScene(segToDelete.scene.id);
      }

      const nextClip =
        nextScenes[Math.min(segToDelete.index, Math.max(0, nextScenes.length - 1))] ?? null;
      setActiveSceneId(nextClip ? nextClip.id : null);

      const newMaxCut = nextScenes.reduce(
        (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
        0
      );
      const nextCut = Math.max(0, Math.min(newMaxCut, segToDelete.cutStart));
      setCutTime(nextCut);

      if (nextClip && videoRef.current) {
        // Preview the new frame at the junction
        const idxInNext = Math.max(0, Math.min(segToDelete.index, nextScenes.length - 1));
        const jumpSource = nextScenes[idxInNext]?.startSec ?? 0;
        scheduleSourcePreviewSeek(jumpSource);
      }
    },
    [
      segments,
      targetClipForDelete,
      scenes,
      onReplaceScenes,
      onRemoveScene,
      applyScenesMutation,
      scheduleSourcePreviewSeek,
    ]
  );

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    if (onReplaceScenes) {
      onReplaceScenes(prev);
    }
    setActiveSceneId(prev[0]?.id ?? null);
  }, [undoStack, onReplaceScenes]);

  const handleRestoreFullVideo = useCallback(() => {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    const fullClip: SceneSelection = {
      id: `sc-${Date.now()}`,
      startSec: 0,
      endSec: roundTenth(sourceDuration),
    };
    applyScenesMutation([fullClip], scenes.length > 0);
    setActiveSceneId(fullClip.id);
    seekCutTo(0, true);
  }, [sourceDuration, applyScenesMutation, scenes.length, seekCutTo]);

  // Keyboard shortcuts: Space to Play/Pause, Delete/Backspace to remove selected clip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && targetClipForDelete) {
        e.preventDefault();
        handleDeleteClip(targetClipForDelete.scene.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, targetClipForDelete, handleDeleteClip]);

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

  // Multi-touch pinch + scrub start on timeline viewport (including empty scroll track below clips)
  const handlePointerDownViewport = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();

    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }

    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }

    if (activePointersRef.current.size === 2) {
      // Switch cleanly into two-finger pinch-to-zoom mode
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
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    trimPreUndoRef.current = scenes.map((s) => ({ ...s }));
    setActiveSceneId(seg.scene.id);
    setFrozenTrackTime(cutTimeRef.current);
    setDragState({
      type: mode,
      sceneId: seg.scene.id,
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

    // Two-finger touchscreen pinch-to-zoom
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
      seekCutTo(nextCut);
      return;
    }

    if (activeDrag.type === "trim-start") {
      const nextStart = roundTenth(
        Math.max(0, Math.min(activeDrag.origEndSec - 0.5, activeDrag.origStartSec + dt))
      );
      lastDragTargetRef.current = {
        cutTime: activeDrag.origCutStart,
        sourceSec: nextStart,
      };
      onUpdateScene(activeDrag.sceneId, nextStart, activeDrag.origEndSec);
      scheduleSourcePreviewSeek(nextStart);
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
      lastDragTargetRef.current = {
        cutTime: activeDrag.origCutStart + nextClipDur,
        sourceSec: nextEnd,
      };
      onUpdateScene(activeDrag.sceneId, activeDrag.origStartSec, nextEnd);
      scheduleSourcePreviewSeek(nextEnd);
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

      if (activeDrag.type !== "scrub") {
        if (trimPreUndoRef.current && lastDragTargetRef.current) {
          const snapshot = trimPreUndoRef.current;
          setUndoStack((prev) => [...prev.slice(-29), snapshot]);
        }
        trimPreUndoRef.current = null;

        const target = lastDragTargetRef.current;
        if (target) {
          setCutTime(target.cutTime);
          const vid = videoRef.current;
          if (vid) {
            const actualDur =
              Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
            pendingSeekSecRef.current = null;
            vid.currentTime = Math.max(
              0,
              Math.min(Math.max(0, actualDur - 0.02), target.sourceSec)
            );
          }
        }
        lastDragTargetRef.current = null;
        setFrozenTrackTime(null);
      }
      setDragBadge(null);
      setDragState(null);
    },
    [sourceDuration]
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

  // Two-finger trackpad pinch-to-zoom (ctrlKey + wheel) & two-finger horizontal/vertical scroll scrub
  const wheelStateRef = useRef({ pxPerSec, seekCutTo });
  wheelStateRef.current = { pxPerSec, seekCutTo };
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
      const { pxPerSec: pps, seekCutTo: seek } = wheelStateRef.current;
      seek(cutTimeRef.current + delta / pps, true);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="flex flex-col gap-3.5">
      {/* Live Synced Video Viewport */}
      <div
        onClick={togglePlay}
        className="relative w-full aspect-video rounded-xl overflow-hidden bg-neutral-950 border border-neutral-200 dark:border-neutral-800 cursor-pointer group"
      >
        {media.localUrl && (
          <video
            ref={videoRef}
            src={media.localUrl}
            playsInline
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (d && Number.isFinite(d) && d > 0) {
                setSourceDuration(d);
                onDetectedDuration?.(roundTenth(d));
                // Sync full-video initial clip endSec to exact metadata duration if untouched
                if (
                  scenes.length === 1 &&
                  scenes[0].startSec === 0 &&
                  Math.abs(scenes[0].endSec - (media.durationSec || d)) < 0.25 &&
                  Math.abs(scenes[0].endSec - roundTenth(d)) > 0.05
                ) {
                  onUpdateScene(scenes[0].id, 0, roundTenth(d));
                }
              }
            }}
            onEnded={() => setIsPlaying(false)}
            onSeeked={(e) => {
              const next = pendingSeekSecRef.current;
              if (next !== null && Math.abs(e.currentTarget.currentTime - next) > 0.04) {
                pendingSeekSecRef.current = null;
                e.currentTarget.currentTime = next;
              }
            }}
            onPlay={(e) => {
              if (hasVoiceEffects || voiceAttachedRef.current) {
                resumeAllVoiceContexts();
                voiceAttachedRef.current = true;
                applyVoiceEffectsToVideoElement(e.currentTarget, voiceSettings, true);
              }
              e.currentTarget.preservesPitch = true;
              e.currentTarget.playbackRate = getEffectivePlaybackSpeed(
                "local",
                editSettings.playbackSpeed,
                voiceSettings.speed
              );
              setIsPlaying(true);
            }}
            onPause={() => setIsPlaying(false)}
            style={{
              transform: buildCssTransformString(editSettings),
              filter: buildCssFilterString(editSettings),
            }}
            className="w-full h-full object-contain bg-black origin-center transition-transform duration-75"
          />
        )}

        {editSettings.vignette > 0 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(circle, transparent 42%, rgba(0,0,0,${(
                (editSettings.vignette / 100) * 0.85
              ).toFixed(2)}) 100%)`,
            }}
          />
        )}

        {!isPlaying && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15 group-hover:bg-black/25 transition-colors">
            <div className="w-12 h-12 rounded-full bg-black/70 text-white flex items-center justify-center backdrop-blur-xs">
              <Play className="w-5 h-5 ml-0.5" />
            </div>
          </div>
        )}

        {dragBadge && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-md bg-black/80 text-white text-xs font-mono-tabular">
            {dragBadge.label}: {formatTimePrecise(dragBadge.sec)}
          </div>
        )}
      </div>

      {/* Transport & Split / Delete Cut Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              togglePlay();
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
              handleRestoreFullVideo();
            }}
            title="Reset to full video"
            aria-label="Reset to full video"
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

          {/* Kept Video Clips Track (ONLY the scenes you keep — zero overlay boxes!) */}
          <div className="relative h-16 mt-2">
            {segments.map((seg, idx) => {
              const leftPx = seg.cutStart * pxPerSec;
              const widthPx = Math.max(18, seg.clipDur * pxPerSec);
              const isSelected = seg.scene.id === activeSceneId;

              // Slice thumbnails matching this clip's [startSec .. endSec] range
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
                  key={seg.scene.id}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                  onPointerDown={(e) => {
                    tappedClipRef.current = {
                      sceneId: seg.scene.id,
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

        {/* Bottom Free-Scroll Zone Hint */}
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-2.5 py-0.5 rounded-full bg-black/55 text-white/90 text-[10px] whitespace-nowrap">
          {segments.length === 0
            ? "No clips kept · Click Reset to restore full video"
            : "Drag open space below to scroll timeline · Pinch with two fingers to zoom"}
        </div>
      </div>

      {/* Kept Scenes Summary List */}
      <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
        {segments.length === 0 ? (
          <div className="p-5 text-center space-y-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              All clips were deleted. Restore the full video to split and keep the scenes you want.
            </p>
            <button
              type="button"
              onClick={handleRestoreFullVideo}
              className="h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Full Video</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {segments.map((seg, idx) => {
              const isSelected = seg.scene.id === activeSceneId;
              const dur = roundTenth(seg.clipDur);
              return (
                <div
                  key={seg.scene.id}
                  onClick={() => {
                    setActiveSceneId(seg.scene.id);
                    seekCutTo(seg.cutStart, true);
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
                        setActiveSceneId(seg.scene.id);
                        playFromCutTime(seg.cutStart);
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
                        handleDeleteClip(seg.scene.id);
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
