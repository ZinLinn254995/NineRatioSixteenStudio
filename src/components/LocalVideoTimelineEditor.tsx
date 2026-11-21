import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ActiveMediaSource, SceneSelection } from "../types";
import { hasVerticalScrollRoom, scrollVerticalAncestors } from "../utils/timelineScroll";

interface LocalVideoTimelineEditorProps {
  media: ActiveMediaSource;
  scenes: SceneSelection[];
  clipSubtitleCounts?: Record<string, number>;
  regeneratingClipId?: string | null;
  regeneratingClipPercent?: number | null;
  isProcessingAll?: boolean;
  onGenerateSingleClip?: (sceneId: string) => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes?: (scenes: SceneSelection[]) => void;
  onDetectedDuration?: (dur: number) => void;
  isTabActive?: boolean;
  mobileStageTarget?: HTMLElement | null;
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
  clipSubtitleCounts,
  regeneratingClipId = null,
  regeneratingClipPercent = null,
  isProcessingAll = false,
  onGenerateSingleClip,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onDetectedDuration,
  isTabActive = true,
  mobileStageTarget = null,
}: LocalVideoTimelineEditorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isTabActiveRef = useRef(isTabActive);
  isTabActiveRef.current = isTabActive;

  const [sourceDuration, setSourceDuration] = useState<number>(() =>
    Math.max(1, media.durationSec || 30)
  );
  const sourceDurationRef = useRef(sourceDuration);
  sourceDurationRef.current = sourceDuration;
  const [cutTime, setCutTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(32);
  const [viewportWidth, setViewportWidth] = useState(560);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
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
  const [frozenTrackTime, setFrozenTrackTime] = useState<number | null>(null);
  const [dragBadge, setDragBadge] = useState<{ label: string; sec: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<SceneSelection[][]>([]);
  const [playError, setPlayError] = useState<string | null>(null);

  const dragStateRef = useRef<DragMode | null>(null);
  const windowDragCleanupRef = useRef<(() => void) | null>(null);
  const pointerMoveHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const updateDragState = useCallback((next: DragMode | null) => {
    dragStateRef.current = next;
  }, []);
  const frozenTrackTimeRef = useRef<number | null>(null);
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
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const lastDragTargetRef = useRef<{ cutTime: number; sourceSec: number } | null>(null);
  const trimPreUndoRef = useRef<SceneSelection[] | null>(null);
  const pendingSeekSecRef = useRef<number | null>(null);
  const pendingPlayRef = useRef<boolean>(false);
  const playAttemptPendingRef = useRef<boolean>(false);
  const reloadAttemptedRef = useRef<boolean>(false);
  const seekSettleUntilRef = useRef<number>(0);
  const lastSeekFixAtRef = useRef<number>(0);
  const seekRafRef = useRef<number>(0);
  const activePlaybackIdxRef = useRef<number>(0);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; pxPerSec: number } | null>(null);
  const tappedClipRef = useRef<{ sceneId: string; startX: number; moved: boolean } | null>(null);
  const wheelTargetCutRef = useRef<{ cutTime: number; expiresAt: number } | null>(null);

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
    frozenTrackTimeRef.current = null;
    setFrozenTrackTime(null);
    activePointersRef.current.clear();
    pinchStartRef.current = null;
    updateDragState(null);
    trimPreviewRef.current = null;
    setTrimPreview(null);
    setActiveSceneId(null);
    wheelTargetCutRef.current = null;
    setPlayError(null);
    setUndoStack([]);
    pendingSeekSecRef.current = null;
    pendingPlayRef.current = false;
    playAttemptPendingRef.current = false;
    reloadAttemptedRef.current = false;
    seekSettleUntilRef.current = 0;
    activePlaybackIdxRef.current = 0;
    const safeDur = Number.isFinite(media.durationSec) && media.durationSec > 0 ? media.durationSec : 30;
    setSourceDuration(Math.max(1, safeDur));
  }, [media.localUrl]);

  // Pause timeline playback and clean up active drag/pointer state when hidden,
  // and recover any browser-evicted media pipeline when returning to this tab
  useEffect(() => {
    if (!isTabActive) {
      pendingPlayRef.current = false;
      playAttemptPendingRef.current = false;
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      setIsPlaying(false);
      windowDragCleanupRef.current?.();
      windowDragCleanupRef.current = null;
      activePointersRef.current.clear();
      pinchStartRef.current = null;
      tappedClipRef.current = null;
      trimPreUndoRef.current = null;
      trimPreviewRef.current = null;
      setTrimPreview(null);
      frozenTrackTimeRef.current = null;
      setFrozenTrackTime(null);
      setDragBadge(null);
      updateDragState(null);
      return;
    }

    const vid = videoRef.current;
    if (
      vid &&
      media.localUrl &&
      (vid.error ||
        vid.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
        vid.networkState === HTMLMediaElement.NETWORK_EMPTY)
    ) {
      reloadAttemptedRef.current = false;
      pendingSeekSecRef.current = mapCutTimeToSource(cutTimeRef.current).sourceSec;
      try {
        vid.load();
      } catch {
        // ignore
      }
    }
  }, [isTabActive, media.localUrl, mapCutTimeToSource, updateDragState]);

  // Clear activeSceneId only if the selected scene was removed (never auto-select clips)
  useEffect(() => {
    if (scenes.length === 0) {
      setActiveSceneId(null);
    } else if (activeSceneId && !scenes.some((s) => s.id === activeSceneId)) {
      setActiveSceneId(null);
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
    const estDur = sourceDurationRef.current;
    if (!media.localUrl || estDur <= 0) {
      setThumbnails([]);
      return;
    }

    let cancelled = false;
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
      // Give the primary preview <video> element priority before decoding filmstrip frames
      await new Promise((r) => setTimeout(r, 260));
      if (cancelled) return;
      hiddenVid.src = media.localUrl!;

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
          : sourceDurationRef.current;
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
  }, [media.localUrl]);

  // Coalesce rapid drag seeks so the HTML5 video decoder never stalls on queued seeks
  const scheduleSourcePreviewSeek = useCallback(
    (sourceSec: number) => {
      const vid = videoRef.current;
      if (!vid) return;
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.02), sourceSec));
      pendingSeekSecRef.current = clamped;
      if (vid.readyState < 1) return;

      if (seekRafRef.current) return;
      seekRafRef.current = requestAnimationFrame(() => {
        seekRafRef.current = 0;
        const v = videoRef.current;
        const next = pendingSeekSecRef.current;
        if (!v || next === null || v.readyState < 1) return;
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
      if (vid && segs.length > 0 && !vid.paused && !vid.seeking && vid.readyState >= 1) {
        const idx = Math.min(activePlaybackIdxRef.current, segs.length - 1);
        const seg = segs[idx];
        const srcT = vid.currentTime;
        const now = performance.now();

        if (srcT < seg.startSec - 0.18 && now >= seekSettleUntilRef.current) {
          if (now - lastSeekFixAtRef.current > 500) {
            lastSeekFixAtRef.current = now;
            seekSettleUntilRef.current = now + 650;
            vid.currentTime = seg.startSec;
          }
        } else if (srcT >= seg.endSec - 0.03 && now >= seekSettleUntilRef.current) {
          if (idx + 1 < segs.length) {
            const nextIdx = idx + 1;
            const nextSeg = segs[nextIdx];
            activePlaybackIdxRef.current = nextIdx;
            // Only seek when there is an actual cut gap; contiguous splits flow smoothly
            if (Math.abs(nextSeg.startSec - srcT) > 0.18) {
              lastSeekFixAtRef.current = now;
              seekSettleUntilRef.current = now + 650;
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
      cutTimeRef.current = clampedCut;
      setCutTime(clampedCut);
      return clampedCut;
    },
    [mapCutTimeToSource, scheduleSourcePreviewSeek]
  );

  const playFromCutTime = useCallback(
    (explicitCutTime?: number) => {
      if (!isTabActiveRef.current) return;
      const vid = videoRef.current;
      const segs = segmentsRef.current;
      if (!vid || segs.length === 0) return;

      setPlayError(null);
      vid.muted = false;

      const maxCut = totalCutDurationRef.current;
      const startCut =
        typeof explicitCutTime === "number"
          ? Math.max(0, Math.min(Math.max(0, maxCut - 0.05), explicitCutTime))
          : cutTimeRef.current >= maxCut - 0.06
            ? 0
            : cutTimeRef.current;

      const { segIndex, sourceSec } = mapCutTimeToSource(startCut);
      activePlaybackIdxRef.current = segIndex;
      setCutTime(startCut);

      // Recover automatically if browser evicted background/idle video decoder
      if (
        vid.error ||
        vid.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
        vid.networkState === HTMLMediaElement.NETWORK_EMPTY
      ) {
        reloadAttemptedRef.current = true;
        pendingSeekSecRef.current = sourceSec;
        pendingPlayRef.current = true;
        playAttemptPendingRef.current = false;
        setIsPlaying(true);
        try {
          vid.load();
        } catch {
          // ignore
        }
        return;
      }

      if (vid.readyState >= 1) {
        const actualDur =
          Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
        const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
        pendingSeekSecRef.current = null;
        if (Math.abs(vid.currentTime - clamped) > 0.08) {
          seekSettleUntilRef.current = performance.now() + 650;
          vid.currentTime = clamped;
        } else {
          seekSettleUntilRef.current = 0;
        }
      } else {
        pendingSeekSecRef.current = sourceSec;
      }

      pendingPlayRef.current = true;
      playAttemptPendingRef.current = true;
      const playPromise = vid.play();
      setIsPlaying(true);
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            playAttemptPendingRef.current = false;
            pendingPlayRef.current = false;
            if (!isTabActiveRef.current) {
              vid.pause();
              setIsPlaying(false);
              return;
            }
            setIsPlaying(!vid.paused);
          })
          .catch((err: unknown) => {
            playAttemptPendingRef.current = false;
            if (!isTabActiveRef.current) {
              pendingPlayRef.current = false;
              setIsPlaying(false);
              return;
            }
            const errName = err instanceof DOMException ? err.name : "";
            if (errName === "AbortError") {
              pendingPlayRef.current = true;
              return;
            }
            if (vid.error && !reloadAttemptedRef.current) {
              reloadAttemptedRef.current = true;
              pendingSeekSecRef.current = sourceSec;
              pendingPlayRef.current = true;
              try {
                vid.load();
                return;
              } catch {
                // fall through
              }
            }
            if (!vid.muted) {
              vid.muted = true;
              playAttemptPendingRef.current = true;
              vid
                .play()
                .then(() => {
                  playAttemptPendingRef.current = false;
                  pendingPlayRef.current = false;
                  if (!isTabActiveRef.current) {
                    vid.pause();
                    setIsPlaying(false);
                    return;
                  }
                  setIsPlaying(!vid.paused);
                })
                .catch((err2: unknown) => {
                  playAttemptPendingRef.current = false;
                  const err2Name = err2 instanceof DOMException ? err2.name : "";
                  if (err2Name === "AbortError" && isTabActiveRef.current) {
                    pendingPlayRef.current = true;
                    return;
                  }
                  pendingPlayRef.current = false;
                  setIsPlaying(false);
                  setPlayError("Tap the video to play or check the video format.");
                });
            } else {
              pendingPlayRef.current = false;
              setIsPlaying(false);
              setPlayError("Could not play this video file.");
            }
          });
      } else {
        playAttemptPendingRef.current = false;
        pendingPlayRef.current = false;
        if (!isTabActiveRef.current) {
          vid.pause();
          setIsPlaying(false);
          return;
        }
        setIsPlaying(!vid.paused);
      }
    },
    [mapCutTimeToSource, sourceDuration]
  );

  const togglePlay = useCallback(() => {
    if (!isTabActiveRef.current) return;
    const vid = videoRef.current;
    if (!vid || segmentsRef.current.length === 0) return;
    if (vid.paused || vid.ended || vid.error) {
      playFromCutTime();
    } else {
      pendingPlayRef.current = false;
      playAttemptPendingRef.current = false;
      vid.pause();
      setIsPlaying(false);
    }
  }, [playFromCutTime]);

  const applyPendingSeekAndPlay = useCallback((vidEl: HTMLVideoElement) => {
    const next = pendingSeekSecRef.current;
    if (next !== null && vidEl.readyState >= 1) {
      const d = vidEl.duration;
      const maxSeek = Number.isFinite(d) && d > 0 ? Math.max(0, d - 0.02) : next + 1;
      const clamped = Math.max(0, Math.min(maxSeek, next));
      pendingSeekSecRef.current = null;
      if (Math.abs(vidEl.currentTime - clamped) > 0.04) {
        seekSettleUntilRef.current = performance.now() + 650;
        vidEl.currentTime = clamped;
      }
    }
    if (pendingPlayRef.current && isTabActiveRef.current && vidEl.paused && vidEl.readyState >= 1) {
      pendingPlayRef.current = false;
      playAttemptPendingRef.current = true;
      vidEl
        .play()
        .then(() => {
          playAttemptPendingRef.current = false;
          if (!isTabActiveRef.current) {
            vidEl.pause();
            setIsPlaying(false);
            return;
          }
          setIsPlaying(!vidEl.paused);
        })
        .catch((err: unknown) => {
          playAttemptPendingRef.current = false;
          if (!isTabActiveRef.current) {
            setIsPlaying(false);
            return;
          }
          const errName = err instanceof DOMException ? err.name : "";
          if (errName === "AbortError") {
            pendingPlayRef.current = true;
            return;
          }
          if (vidEl.error && !reloadAttemptedRef.current) {
            reloadAttemptedRef.current = true;
            pendingPlayRef.current = true;
            try {
              vidEl.load();
              return;
            } catch {
              // fall through
            }
          }
          if (!vidEl.muted) {
            vidEl.muted = true;
            playAttemptPendingRef.current = true;
            vidEl
              .play()
              .then(() => {
                playAttemptPendingRef.current = false;
                if (!isTabActiveRef.current) {
                  vidEl.pause();
                  setIsPlaying(false);
                  return;
                }
                setIsPlaying(!vidEl.paused);
              })
              .catch((err2: unknown) => {
                playAttemptPendingRef.current = false;
                const err2Name = err2 instanceof DOMException ? err2.name : "";
                if (err2Name === "AbortError" && isTabActiveRef.current) {
                  pendingPlayRef.current = true;
                  return;
                }
                setIsPlaying(false);
                setPlayError("Tap the video to play or check the video format.");
              });
          } else {
            setIsPlaying(false);
            setPlayError("Could not play this video file.");
          }
        });
    }
  }, []);

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
    setActiveSceneId((cur) => (cur && prev.some((s) => s.id === cur) ? cur : null));
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
    setActiveSceneId(null);
    seekCutTo(0, true);
  }, [sourceDuration, applyScenesMutation, scenes.length, seekCutTo]);

  // Keyboard shortcuts: Space to Play/Pause, Delete/Backspace to remove selected clip
  useEffect(() => {
    if (!isTabActive) return;
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
  }, [isTabActive, togglePlay, targetClipForDelete, handleDeleteClip]);

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

  // Multi-touch pinch + scrub start on timeline viewport (including empty scroll track below clips)
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
      // Switch cleanly into two-finger pinch-to-zoom mode
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      updateDragState(null);
      setDragBadge(null);
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      pinchStartRef.current = { dist, pxPerSec };
      return;
    }

    if (activePointersRef.current.size === 1) {
      const isMouse = e.pointerType === "mouse";
      if (isMouse && videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      pinchStartRef.current = null;
      const nextDrag: DragMode = {
        type: "scrub",
        pointerType: e.pointerType || "mouse",
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientY: e.clientY,
        startCutTime: cutTimeRef.current,
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
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    const freezeCut = cutTimeRef.current;
    frozenTrackTimeRef.current = freezeCut;
    trimPreUndoRef.current = scenes.map((s) => ({ ...s }));
    setActiveSceneId(seg.scene.id);
    setFrozenTrackTime(freezeCut);
    const initTrim = {
      sceneId: seg.scene.id,
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
      sceneId: seg.scene.id,
      startClientX: e.clientX,
      origStartSec: seg.startSec,
      origEndSec: seg.endSec,
      origCutStart: seg.cutStart,
    });
  };

  const handlePointerMoveViewport = (e: PointerEvent | React.PointerEvent<HTMLElement>) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger touchscreen pinch-to-zoom
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
          return;
        } else {
          activeDrag.axis = "x";
          if (videoRef.current && !videoRef.current.paused) {
            videoRef.current.pause();
          }
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
      const dt = dx / pxPerSec;
      const nextCut = Math.max(
        0,
        Math.min(totalCutDurationRef.current, activeDrag.startCutTime - dt)
      );
      seekCutTo(nextCut);
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
        if (activePointersRef.current.size === 0) {
          stopWindowPointerTracking();
        }
        return;
      }
      dragStateRef.current = null;

      if (activeDrag.type === "scrub") {
        const hadClipTap = Boolean(tappedClipRef.current && !tappedClipRef.current.moved);
        const isUnmovedTouchTap =
          activeDrag.axis === "pending" ||
          (activeDrag.axis === "x" && e && Math.abs(e.clientX - activeDrag.startClientX) <= 5);
        if (hadClipTap && tappedClipRef.current) {
          const tappedId = tappedClipRef.current.sceneId;
          setActiveSceneId((cur) => (cur === tappedId ? null : tappedId));
        } else if (isUnmovedTouchTap && !hadClipTap) {
          setActiveSceneId(null);
        }
      }
      tappedClipRef.current = null;

      if (activeDrag.type !== "scrub") {
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
          const nextScenes = scenesRef.current.map((sc) =>
            sc.id === preview.sceneId
              ? { ...sc, startSec: preview.nextStartSec, endSec: preview.nextEndSec }
              : sc
          );
          onUpdateScene(preview.sceneId, preview.nextStartSec, preview.nextEndSec);

          const newMaxCut = nextScenes.reduce(
            (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
            0
          );
          const stayCut = Math.max(0, Math.min(newMaxCut, stayFrozen ?? cutTimeRef.current));
          cutTimeRef.current = stayCut;
          setCutTime(stayCut);

          let cursor = 0;
          let mappedSource = nextScenes[0]?.startSec ?? 0;
          for (let i = 0; i < nextScenes.length; i++) {
            const sc = nextScenes[i];
            const dur = Math.max(0.1, sc.endSec - sc.startSec);
            if (stayCut < cursor + dur - 0.0005 || i === nextScenes.length - 1) {
              const offset = Math.max(0, Math.min(dur, stayCut - cursor));
              mappedSource = Math.min(sc.endSec, sc.startSec + offset);
              activePlaybackIdxRef.current = i;
              break;
            }
            cursor += dur;
          }

          const vid = videoRef.current;
          if (vid) {
            const actualDur =
              Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceDuration;
            pendingSeekSecRef.current = null;
            vid.currentTime = Math.max(
              0,
              Math.min(Math.max(0, actualDur - 0.02), mappedSource)
            );
          }
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
    [onUpdateScene, sourceDuration, stopWindowPointerTracking, updateDragState]
  );

  pointerMoveHandlerRef.current = handlePointerMoveViewport;
  pointerUpHandlerRef.current = handlePointerUpAny;

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
      const { pxPerSec: pps, seekCutTo: seek } = wheelStateRef.current;
      const now = performance.now();
      const baseCut =
        wheelTargetCutRef.current && wheelTargetCutRef.current.expiresAt > now
          ? wheelTargetCutRef.current.cutTime
          : cutTimeRef.current;
      const next = Math.max(0, Math.min(totalCutDurationRef.current, baseCut + delta / pps));
      wheelTargetCutRef.current = { cutTime: next, expiresAt: now + 240 };
      seek(next, true);
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
  }, []);

  const videoViewportNode = (
    <div
      onClick={togglePlay}
      className={`relative w-full rounded-lg overflow-hidden bg-[#04050e] border border-[#d2dcf0] dark:border-[#21284c] cursor-pointer group ${
        mobileStageTarget ? "h-full" : "max-w-xl mx-auto aspect-video"
      }`}
    >
      {media.localUrl ? (
        <video
          key={media.localUrl}
          ref={videoRef}
          src={media.localUrl}
          preload={isTabActive ? "auto" : "metadata"}
          playsInline
          onLoadedData={() => setPlayError(null)}
          onLoadedMetadata={(e) => {
            setPlayError(null);
            const vidEl = e.currentTarget;
            const d = vidEl.duration;
            if (Number.isFinite(d) && d > 0) {
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
            applyPendingSeekAndPlay(vidEl);
          }}
          onCanPlay={(e) => {
            setPlayError(null);
            applyPendingSeekAndPlay(e.currentTarget);
          }}
          onEnded={() => {
            pendingPlayRef.current = false;
            playAttemptPendingRef.current = false;
            setIsPlaying(false);
          }}
          onSeeked={(e) => {
            seekSettleUntilRef.current = 0;
            applyPendingSeekAndPlay(e.currentTarget);
          }}
          onPlay={(e) => {
            setPlayError(null);
            reloadAttemptedRef.current = false;
            playAttemptPendingRef.current = false;
            pendingPlayRef.current = false;
            e.currentTarget.preservesPitch = true;
            e.currentTarget.playbackRate = 1;
            setIsPlaying(true);
          }}
          onPause={(e) => {
            const v = e.currentTarget;
            if (v.seeking || v.ended || playAttemptPendingRef.current || pendingPlayRef.current) {
              return;
            }
            setIsPlaying(false);
          }}
          onError={(e) => {
            playAttemptPendingRef.current = false;
            const v = e.currentTarget;
            if (!reloadAttemptedRef.current && media.localUrl && pendingPlayRef.current) {
              reloadAttemptedRef.current = true;
              try {
                v.load();
                return;
              } catch {
                // fall through
              }
            }
            pendingPlayRef.current = false;
            setIsPlaying(false);
            setPlayError("Could not load or play this local video file.");
          }}
          className="w-full h-full object-contain bg-black"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center p-4 text-center">
          <p className="text-xs text-neutral-300">
            Local video is not linked. Link or re-upload the video file to preview.
          </p>
        </div>
      )}

      {!isPlaying && media.localUrl && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/15 group-hover:bg-black/25 transition-colors">
          <div className="w-12 h-12 rounded-full bg-black/70 text-white flex items-center justify-center backdrop-blur-xs">
            <Play className="w-5 h-5 ml-0.5" />
          </div>
          {playError && (
            <span className="px-2.5 py-1 rounded-md bg-black/80 text-white text-[11px]">
              {playError}
            </span>
          )}
        </div>
      )}

      {dragBadge && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-md bg-black/80 text-white text-xs font-mono-tabular">
          {dragBadge.label}: {formatTimePrecise(dragBadge.sec)}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* Live Synced Video Viewport */}
      {mobileStageTarget ? createPortal(videoViewportNode, mobileStageTarget) : videoViewportNode}

      {/* Transport & Split / Delete Cut Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              togglePlay();
            }}
            disabled={segments.length === 0}
            aria-label={isPlaying ? "Pause video" : "Play video"}
            className="h-8 w-8 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] flex items-center justify-center disabled:opacity-40 cursor-pointer shrink-0 transition-colors"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
          </button>

          <span className="text-xs font-mono-tabular text-[#0c1026] dark:text-[#f3f5fc]">
            {formatTimePrecise(cutTime)}
            <span className="text-[#4d597d] dark:text-[#919ec4]">
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
            className="h-8 px-2.5 rounded-md bg-teal-700 text-white hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
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
            className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900 text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
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
            className="h-8 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
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
            className="h-8 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <div className="inline-flex items-center border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] rounded-md overflow-hidden ml-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(Math.round(z * 0.75)));
              }}
              aria-label="Zoom out timeline"
              className="h-8 w-7 flex items-center justify-center text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] cursor-pointer transition-colors"
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
              className="h-8 w-7 flex items-center justify-center border-l border-[#d2dcf0] dark:border-[#21284c] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] cursor-pointer transition-colors"
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
        className="relative h-48 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-[#e7ecf8] dark:bg-[#050712] overflow-hidden select-none touch-none [&_*]:touch-none cursor-grab active:cursor-grabbing"
      >
        {/* Full-Width Stationary Ruler Bar Background */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-6 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95"
        />

        {/* Moving Timeline Content Track */}
        <div
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

          {/* Kept Video Clips Track (ONLY the scenes you keep — zero overlay boxes!) */}
          <div className="relative h-16 mt-2">
            {segments.map((seg, idx) => {
              const activeTrim = trimPreview?.sceneId === seg.scene.id ? trimPreview : null;
              const deltaStart = activeTrim ? activeTrim.nextStartSec - activeTrim.origStartSec : 0;
              const deltaEnd = activeTrim ? activeTrim.nextEndSec - activeTrim.origEndSec : 0;
              const leftPx = (seg.cutStart + deltaStart) * pxPerSec;
              const rightPx = (seg.cutEnd + deltaEnd) * pxPerSec;
              const widthPx = Math.max(18, rightPx - leftPx);
              const displayDur = activeTrim
                ? Math.max(0.1, activeTrim.nextEndSec - activeTrim.nextStartSec)
                : seg.clipDur;
              const isSelected = seg.scene.id === activeSceneId;

              // Slice thumbnails matching this clip's [startSec .. endSec] range
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
                  key={seg.scene.id}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                  onPointerDown={(e) => {
                    tappedClipRef.current = {
                      sceneId: seg.scene.id,
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

          {/* Dedicated One-Clip-Height Open Scroll Space Below Clips */}
          <div
            aria-hidden="true"
            className="h-20 mt-2 border-t border-dashed border-[#bcc9e6] dark:border-[#2a313e]"
          />
        </div>

        {/* Fixed Center Playhead Line */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center"
        >
          <div className="w-3 h-3 rounded-b-sm bg-teal-700 dark:bg-teal-400 shadow-sm" />
          <div className="w-[2px] flex-1 bg-teal-700 dark:bg-teal-400 shadow-[0_0_6px_rgba(15,118,110,0.45)]" />
        </div>

      </div>

      {/* Kept Scenes Summary List */}
      <div className="border-y border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden">
        {segments.length === 0 ? (
          <div className="p-5 text-center space-y-2">
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
              All clips were deleted. Restore the full video to split and keep the clips you want.
            </p>
            <button
              type="button"
              onClick={handleRestoreFullVideo}
              className="h-8 px-3 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Full Video</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c]">
            {segments.map((seg, idx) => {
              const isSelected = seg.scene.id === activeSceneId;
              const dur = roundTenth(seg.clipDur);
              const subCount = clipSubtitleCounts?.[seg.scene.id] ?? 0;
              const hasExistingSubs = subCount > 0;
              const isRegeneratingThis = regeneratingClipId === seg.scene.id;
              const busyElsewhere = isProcessingAll || (Boolean(regeneratingClipId) && !isRegeneratingThis);

              return (
                <div
                  key={seg.scene.id}
                  onClick={() => {
                    setActiveSceneId(seg.scene.id);
                    seekCutTo(seg.cutStart, true);
                  }}
                  className={`px-3 py-2 flex items-center justify-between gap-2.5 cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-teal-50/70 dark:bg-teal-950/30"
                      : "bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#141933]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-[11px] font-mono-tabular font-semibold shrink-0 ${
                        isSelected ? "text-teal-700 dark:text-teal-400" : "text-[#4d597d] dark:text-[#919ec4]"
                      }`}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] whitespace-nowrap">
                      Clip {idx + 1}
                    </span>
                    <span className="text-xs font-mono-tabular text-[#4d597d] dark:text-[#919ec4] truncate">
                      {formatTimePrecise(seg.startSec)} – {formatTimePrecise(seg.endSec)}
                    </span>
                    {hasExistingSubs && (
                      <span className="text-[11px] font-mono-tabular text-teal-700 dark:text-teal-400 whitespace-nowrap shrink-0">
                        · {subCount} sub
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                    {onGenerateSingleClip && (
                      <button
                        type="button"
                        disabled={busyElsewhere || isRegeneratingThis}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.currentTarget.blur();
                          setActiveSceneId(seg.scene.id);
                          onGenerateSingleClip(seg.scene.id);
                        }}
                        title={
                          hasExistingSubs
                            ? `Replace subtitles for Clip ${idx + 1}`
                            : `Generate subtitles for Clip ${idx + 1}`
                        }
                        aria-label={
                          hasExistingSubs
                            ? `Replace subtitles for Clip ${idx + 1}`
                            : `Generate subtitles for Clip ${idx + 1}`
                        }
                        className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:border-teal-700/50 dark:hover:border-teal-400/50 hover:text-teal-700 dark:hover:text-teal-400 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      >
                        {isRegeneratingThis ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-teal-700 dark:text-teal-400 shrink-0" />
                            <span className="font-mono-tabular">
                              {typeof regeneratingClipPercent === "number"
                                ? `${regeneratingClipPercent}%`
                                : "..."}
                            </span>
                          </>
                        ) : hasExistingSubs ? (
                          <>
                            <RefreshCw className="w-3 h-3 shrink-0" />
                            <span>Replace</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3 h-3 shrink-0" />
                            <span>Generate</span>
                          </>
                        )}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.currentTarget.blur();
                        setActiveSceneId(seg.scene.id);
                        playFromCutTime(seg.cutStart);
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
                      disabled={isRegeneratingThis}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.currentTarget.blur();
                        handleDeleteClip(seg.scene.id);
                      }}
                      aria-label={`Delete clip ${idx + 1}`}
                      className="p-1 text-[#4d597d] dark:text-[#919ec4] hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors cursor-pointer"
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
