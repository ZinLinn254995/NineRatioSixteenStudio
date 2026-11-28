import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Eraser,
  Film,
  Flag,
  GripHorizontal,
  Link2,
  Loader2,
  Merge,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type {
  SpeechRegion,
  SpeakingScene,
  SubtitleItem,
  VideoProject,
} from "../types";
import { ensureSceneIds, roundTenth } from "../utils/projectTimeline";
import { hasGeneratedProject, hasProjectMedia } from "../utils/projectState";
import {
  projectSpeechRegionsToCutTimeline,
  type CutSpeechRegion,
} from "../utils/audioSpeechAnalyzer";
import { findUnmatchedSpeechGaps, suggestTranscribeRange } from "../utils/subtitleState";
import { hasVerticalScrollRoom, scrollVerticalAncestors } from "../utils/timelineScroll";
import {
  getPassiveTimelineThumbs,
  subscribePassiveTimelineThumbs,
} from "../utils/timelineThumbBus";

interface ProjectTimelineEditorProps {
  project: VideoProject | null;
  cutTime: number;
  subscribeCutTime?: (listener: (sec: number) => void) => () => void;
  isPlaying: boolean;
  isActive?: boolean;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (sec: number, opts?: { live?: boolean }) => void;
  onScrubbingChange?: (active: boolean) => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateScenes: (nextScenes: SpeakingScene[]) => void;
  onUpdateSubtitleTiming?: (id: string, startTime: number, endTime: number) => void;
  onAddSubtitle?: (
    input: {
      startTime: number;
      endTime: number;
      thaiPhonetic: string;
      burmese: string;
      originalSpokenText?: string;
    },
    opts?: { select?: boolean; seekToStart?: boolean }
  ) => void;
  onOpenPasteTranscript?: () => void;
  onClearAllSubtitles?: () => void;
  onEditSubtitle?: (id: string) => void;
  onDeleteSubtitle?: (id: string) => void;
  onSplitSubtitle?: (id: string) => void;
  onMergeSubtitleWithNext?: (id: string) => void;
  onShiftAllSubtitles?: (deltaSec: number) => void;
  onTranscribeRange?: (
    startSec: number,
    endSec: number
  ) => Promise<{ addedCount: number; message?: string } | void>;
  transcribingRange?: { startSec: number; endSec: number } | null;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onRestoreSnapshot?: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onGoToScenes?: () => void;
  onAddMediaClip?: (files: FileList | File[]) => void;
  dockMode?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  cutSpeechRegions?: CutSpeechRegion[];
  clipSubtitleCounts?: Record<string, number>;
  regeneratingClipId?: string | null;
  regeneratingClipPercent?: number | null;
  onGenerateSingleClip?: (sceneId: string) => void;
  onPreviewSourceSeek?: (sourceSec: number | null, opts?: { skipResync?: boolean }) => void;
  selectedSubtitleId?: string | null;
  onSelectSubtitle?: (id: string | null, opts?: { scrollList?: boolean }) => void;
  hideUndoRedo?: boolean;
  compactMobileExpanded?: boolean;
  hideHeader?: boolean;
  hideTransport?: boolean;
  hideCaptions?: boolean;
  showSubtitleTrack?: boolean;
  fillHeight?: boolean;
  compactDock?: boolean;
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
  maxSourceSec: number;
}

interface TimelineThumbFrame {
  sourceSec: number;
  url: string;
}

type DragMode =
  | {
      type: "scrub";
      pointerType: string;
      startClientX: number;
      scrubAnchorClientX: number;
      startClientY: number;
      lastClientY: number;
      startCutTime: number;
      axis: "x" | "y" | "pending";
      wasPlayingBeforeScrub: boolean;
    }
  | {
      type: "trim-start";
      sceneId: string;
      startClientX: number;
      origStartSec: number;
      origEndSec: number;
      origCutStart: number;
      isImage?: boolean;
    }
  | {
      type: "trim-end";
      sceneId: string;
      startClientX: number;
      origStartSec: number;
      origEndSec: number;
      origCutStart: number;
      maxEndSec: number;
      isImage?: boolean;
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
    }
  | {
      type: "clip-reorder";
      sceneId: string;
      fromIndex: number;
      toIndex: number;
      pointerId: number;
      startClientX: number;
      currentClientX: number;
    };

interface ClipReorderState {
  sceneId: string;
  fromIndex: number;
  toIndex: number;
  pointerLocalX: number;
}

const CLIP_LONG_PRESS_MS = 320;
const REORDER_TILE_W = 68;
const REORDER_TILE_H = 52;
const REORDER_TILE_GAP = 10;
const REORDER_TILE_STRIDE = REORDER_TILE_W + REORDER_TILE_GAP;
const REORDER_STRIP_PAD = 16;

function formatTimePrecise(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  const wholeSecs = Math.floor(rem);
  const tenths = Math.floor((rem - wholeSecs) * 10);
  return `${mins}:${String(wholeSecs).padStart(2, "0")}.${tenths}`;
}

const MIN_TIMELINE_ZOOM = 0.15;
const MAX_TIMELINE_ZOOM = 160;

function formatRulerTick(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function clampZoom(z: number, minZoom = MIN_TIMELINE_ZOOM): number {
  const floor = Math.max(MIN_TIMELINE_ZOOM, minZoom);
  const clamped = Math.max(floor, Math.min(MAX_TIMELINE_ZOOM, z));
  return clamped < 4
    ? Math.round(clamped * 100) / 100
    : Math.round(clamped * 10) / 10;
}

function computeTimelineSpanPx(
  startSec: number,
  endSec: number,
  pxPerSec: number,
  maxEndSec?: number
): { leftPx: number; widthPx: number } {
  const safeStart = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const rawEnd = Number.isFinite(endSec) ? endSec : safeStart;
  const cappedEnd =
    typeof maxEndSec === "number" && Number.isFinite(maxEndSec)
      ? Math.min(rawEnd, maxEndSec)
      : rawEnd;
  const safeEnd = Math.max(safeStart, cappedEnd);
  const leftPx = safeStart * pxPerSec;
  const rightPx = safeEnd * pxPerSec;
  const widthPx = Math.max(2, rightPx - leftPx);
  return { leftPx, widthPx };
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
  onScrubbingChange,
  onPlayFromTime,
  onUpdateScenes,
  onUpdateSubtitleTiming,
  onAddSubtitle,
  onOpenPasteTranscript,
  onClearAllSubtitles,
  onEditSubtitle,
  onDeleteSubtitle,
  onSplitSubtitle,
  onMergeSubtitleWithNext,
  onShiftAllSubtitles,
  onTranscribeRange,
  transcribingRange = null,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onResetTimeline,
  onGoToScenes,
  onAddMediaClip,
  dockMode = false,
  isCollapsed = false,
  onToggleCollapse,
  cutSpeechRegions: controlledCutSpeechRegions,
  onPreviewSourceSeek,
  selectedSubtitleId,
  onSelectSubtitle,
  hideUndoRedo = false,
  compactMobileExpanded = false,
  hideHeader = false,
  hideTransport = false,
  hideCaptions = false,
  showSubtitleTrack = false,
  fillHeight = false,
  compactDock = false,
}: ProjectTimelineEditorProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackSlideRef = useRef<HTMLDivElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tracksScrollRef = useRef<HTMLDivElement | null>(null);
  const addMediaInputRef = useRef<HTMLInputElement | null>(null);
  const userScrolledTracksYRef = useRef(false);
  const isUserScrubbingRef = useRef(false);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const [showRangeFill, setShowRangeFill] = useState(false);
  const [rangeStartVal, setRangeStartVal] = useState("0");
  const [rangeEndVal, setRangeEndVal] = useState("3");
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);

  const [pxPerSec, setPxPerSec] = useState(32);
  const [viewportWidth, setViewportWidth] = useState(560);
  const [viewportHeight, setViewportHeight] = useState(224);
  const [trackScrollTop, setTrackScrollTop] = useState<number>(82);
  const [, setThumbBusVersion] = useState(0);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [localActiveSubId, setLocalActiveSubId] = useState<string | null>(null);
  const activeSubId =
    selectedSubtitleId !== undefined ? selectedSubtitleId : localActiveSubId;
  const selectSub = useCallback(
    (id: string | null, opts?: { scrollList?: boolean }) => {
      setLocalActiveSubId(id);
      onSelectSubtitle?.(id, opts);
    },
    [onSelectSubtitle]
  );
  const [showMergeChoice, setShowMergeChoice] = useState(false);
  const [newSubMarkStartSec, setNewSubMarkStartSec] = useState<number | null>(null);
  const newSubMarkStartRef = useRef<number | null>(null);
  newSubMarkStartRef.current = newSubMarkStartSec;
  const newSubPreviewBarRef = useRef<HTMLDivElement | null>(null);
  const newSubEndDurRef = useRef<HTMLSpanElement | null>(null);
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
  const [frozenTrackTime, setFrozenTrackTime] = useState<number | null>(null);
  const [dragBadge, setDragBadge] = useState<{ label: string; sec: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<TimelineThumbFrame[]>([]);
  const [thumbAspect, setThumbAspect] = useState<number>(9 / 16);
  const [baselineSubRegions, setBaselineSubRegions] = useState<SpeechRegion[]>([]);

  const dragStateRef = useRef<DragMode | null>(null);
  const windowDragCleanupRef = useRef<(() => void) | null>(null);
  const pointerMoveHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerCancelHandlerRef = useRef<(e?: PointerEvent) => void>(() => {});
  const updateDragState = useCallback((next: DragMode | null) => {
    dragStateRef.current = next;
  }, []);
  const liveScrubCutRef = useRef<number | null>(null);
  const frozenTrackTimeRef = useRef<number | null>(null);
  const wheelTargetCutRef = useRef<{ cutTime: number; expiresAt: number } | null>(null);
  const wheelClearTimerRef = useRef<number | null>(null);
  const wheelWasPlayingRef = useRef<boolean>(false);
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
  const lastSeekDispatchAtRef = useRef<number>(0);
  const seekThrottleTimerRef = useRef<number | null>(null);
  const queuedSeekSecRef = useRef<number | null>(null);
  const onPreviewSourceSeekRef = useRef(onPreviewSourceSeek);
  onPreviewSourceSeekRef.current = onPreviewSourceSeek;
  const lastPreviewSeekAtRef = useRef<number>(0);
  const previewSeekTimerRef = useRef<number | null>(null);
  const queuedPreviewSourceSecRef = useRef<number | null>(null);
  const isPreviewOverrideActiveRef = useRef<boolean>(false);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ dist: number; pxPerSec: number } | null>(null);
  const tappedClipRef = useRef<{ sceneId: string; startX: number; moved: boolean } | null>(null);
  const tappedSubRef = useRef<{
    subId: string;
    startTime: number;
    startX: number;
    moved: boolean;
  } | null>(null);
  const [clipReorder, setClipReorder] = useState<ClipReorderState | null>(null);
  const clipReorderRef = useRef<ClipReorderState | null>(null);
  const [reorderHint, setReorderHint] = useState<string | null>(null);
  const reorderHintTimerRef = useRef<number | null>(null);
  const reorderStripRef = useRef<HTMLDivElement | null>(null);
  const reorderTrackRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPendingRef = useRef<{
    sceneId: string;
    index: number;
    pointerId: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  const activeTimelineProject = hasProjectMedia(project) ? project : null;
  const isDraft = Boolean(activeTimelineProject?.isDraft);

  const normalizedScenes = useMemo(
    () => (activeTimelineProject ? ensureSceneIds(activeTimelineProject.scenes) : []),
    [activeTimelineProject]
  );

  const sourceDuration = useMemo(() => {
    if (!activeTimelineProject) return 1;
    const maxPrimaryEnd = normalizedScenes.reduce(
      (m, s) => (!s.mediaUrl || s.mediaUrl === activeTimelineProject.localUrl ? Math.max(m, s.endSec) : m),
      0
    );
    return Math.max(1, activeTimelineProject.sourceDurationSec || 0, maxPrimaryEnd);
  }, [activeTimelineProject, normalizedScenes]);

  const { segments, totalCutDuration } = useMemo(() => {
    const list: ClipSegment[] = [];
    let cursor = 0;
    normalizedScenes.forEach((sc, idx) => {
      const dur = Math.max(0.1, sc.endSec - sc.startSec);
      const cutStart = cursor;
      const cutEnd = cursor + dur;
      const sceneId = sc.id || `proj-sc-${idx}`;
      const maxSourceSec =
        typeof sc.sourceDurationSec === "number" && Number.isFinite(sc.sourceDurationSec) && sc.sourceDurationSec > 0
          ? Math.max(sc.endSec, sc.sourceDurationSec)
          : sc.mediaType === "image"
            ? Math.max(60, sc.endSec)
            : !sc.mediaUrl || sc.mediaUrl === activeTimelineProject?.localUrl
              ? sourceDuration
              : Math.max(0.5, sc.endSec);
      list.push({
        scene: sc,
        sceneId,
        index: idx,
        startSec: sc.startSec,
        endSec: sc.endSec,
        clipDur: dur,
        cutStart,
        cutEnd,
        maxSourceSec,
      });
      cursor = cutEnd;
    });
    return { segments: list, totalCutDuration: cursor };
  }, [normalizedScenes, activeTimelineProject?.localUrl, sourceDuration]);

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const normalizedScenesRef = useRef(normalizedScenes);
  normalizedScenesRef.current = normalizedScenes;
  const projectRef = useRef(project);
  projectRef.current = project;
  const totalCutDurationRef = useRef(totalCutDuration);
  totalCutDurationRef.current = totalCutDuration;
  const minPxPerSec = useMemo(() => {
    const safeDur = Math.max(1, totalCutDuration);
    const ultraCompact = (Math.max(240, viewportWidth) * 0.35) / safeDur;
    return Math.max(MIN_TIMELINE_ZOOM, Math.min(1.5, Math.round(ultraCompact * 100) / 100));
  }, [totalCutDuration, viewportWidth]);
  const fitPxPerSec = useMemo(() => {
    const safeDur = Math.max(1, totalCutDuration);
    const target = (Math.max(200, viewportWidth - 48) * 0.88) / safeDur;
    return clampZoom(target, minPxPerSec);
  }, [totalCutDuration, viewportWidth, minPxPerSec]);
  const minPxPerSecRef = useRef(minPxPerSec);
  minPxPerSecRef.current = minPxPerSec;
  const cutTimeRef = useRef(cutTime);
  if (liveScrubCutRef.current === null && !isUserScrubbingRef.current) {
    cutTimeRef.current = cutTime;
  }
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const onPauseRef = useRef(onPause);
  onPauseRef.current = onPause;
  const onScrubbingChangeRef = useRef(onScrubbingChange);
  onScrubbingChangeRef.current = onScrubbingChange;
  const onPlayFromTimeRef = useRef(onPlayFromTime);
  onPlayFromTimeRef.current = onPlayFromTime;

  const cancelClipLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPendingRef.current = null;
  }, []);

  const showReorderHint = useCallback((message: string) => {
    setReorderHint(message);
    if (reorderHintTimerRef.current !== null) {
      window.clearTimeout(reorderHintTimerRef.current);
    }
    reorderHintTimerRef.current = window.setTimeout(() => {
      reorderHintTimerRef.current = null;
      setReorderHint(null);
    }, 1800);
  }, []);

  const computeReorderMetrics = useCallback((clientX: number, segCount: number) => {
    const vpRect = viewportRef.current?.getBoundingClientRect();
    const vpWidth = vpRect?.width ?? 320;
    const rawLocalX = vpRect ? clientX - vpRect.left : vpWidth / 2;
    const pointerLocalX = Math.max(
      REORDER_TILE_W / 2,
      Math.min(Math.max(REORDER_TILE_W / 2, vpWidth - REORDER_TILE_W / 2), rawLocalX)
    );

    const trackEl = reorderTrackRef.current;
    let toIndex = 0;
    if (trackEl) {
      const trackRect = trackEl.getBoundingClientRect();
      const relX = clientX - (trackRect.left + REORDER_STRIP_PAD);
      toIndex = Math.max(0, Math.min(Math.max(0, segCount - 1), Math.floor(relX / REORDER_TILE_STRIDE)));
    } else {
      toIndex = Math.max(0, Math.min(Math.max(0, segCount - 1), clipReorderRef.current?.toIndex ?? 0));
    }

    return { toIndex, pointerLocalX };
  }, []);

  const scheduleClipLongPress = useCallback(
    (sceneId: string, index: number, pointerId: number, startClientX: number, startClientY: number) => {
      cancelClipLongPress();
      longPressPendingRef.current = {
        sceneId,
        index,
        pointerId,
        startClientX,
        startClientY,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const pending = longPressPendingRef.current;
        longPressPendingRef.current = null;
        if (!pending) return;
        if (activePointersRef.current.size !== 1) return;
        if (dragStateRef.current?.type !== "scrub") return;

        const currentSegs = segmentsRef.current;
        if (currentSegs.length < 2) {
          showReorderHint("Split into 2+ clips to reorder");
          return;
        }

        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(18);
          } catch {
            // ignore unsupported haptics
          }
        }

        if (isPlayingRef.current) {
          onPauseRef.current();
        }
        tappedClipRef.current = null;
        tappedSubRef.current = null;
        liveScrubCutRef.current = null;
        isUserScrubbingRef.current = false;
        setDragBadge(null);

        const vpRect = viewportRef.current?.getBoundingClientRect();
        const vpWidth = vpRect?.width ?? 320;
        const rawLocalX = vpRect ? pending.startClientX - vpRect.left : vpWidth / 2;
        const pointerLocalX = Math.max(
          REORDER_TILE_W / 2,
          Math.min(Math.max(REORDER_TILE_W / 2, vpWidth - REORDER_TILE_W / 2), rawLocalX)
        );
        const clampedFrom = Math.max(0, Math.min(currentSegs.length - 1, pending.index));

        dragStateRef.current = {
          type: "clip-reorder",
          sceneId: pending.sceneId,
          fromIndex: clampedFrom,
          toIndex: clampedFrom,
          pointerId: pending.pointerId,
          startClientX: pending.startClientX,
          currentClientX: pending.startClientX,
        };
        setActiveSceneId(pending.sceneId);
        const nextReorder: ClipReorderState = {
          sceneId: pending.sceneId,
          fromIndex: clampedFrom,
          toIndex: clampedFrom,
          pointerLocalX,
        };
        clipReorderRef.current = nextReorder;
        setClipReorder(nextReorder);
      }, CLIP_LONG_PRESS_MS);
    },
    [cancelClipLongPress, showReorderHint]
  );

  // Align minimized reorder strip so the held clip starts right under the user's pointer
  const activeReorderSceneId = clipReorder?.sceneId ?? null;
  useIsomorphicLayoutEffect(() => {
    if (!activeReorderSceneId) return;
    const strip = reorderStripRef.current;
    const current = clipReorderRef.current;
    if (!strip || !current) return;
    const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
    if (maxScroll <= 0) return;
    const tileCenterX =
      REORDER_STRIP_PAD + current.fromIndex * REORDER_TILE_STRIDE + REORDER_TILE_W / 2;
    const desiredScroll = Math.max(0, Math.min(maxScroll, tileCenterX - current.pointerLocalX));
    strip.scrollLeft = desiredScroll;
  }, [activeReorderSceneId]);

  // Smooth horizontal auto-scroll when dragging a minimized clip near the viewport edges
  useEffect(() => {
    if (!activeReorderSceneId) return;
    let rafId = 0;
    const tick = () => {
      const drag = dragStateRef.current;
      if (!drag || drag.type !== "clip-reorder") return;
      const vpRect = viewportRef.current?.getBoundingClientRect();
      const strip = reorderStripRef.current;
      if (vpRect && strip && strip.scrollWidth > strip.clientWidth) {
        const localX = drag.currentClientX - vpRect.left;
        const edgeZone = 44;
        let delta = 0;
        if (localX < edgeZone) {
          delta = -Math.max(2, Math.round(((edgeZone - localX) / edgeZone) * 9));
        } else if (localX > vpRect.width - edgeZone) {
          delta = Math.max(2, Math.round(((localX - (vpRect.width - edgeZone)) / edgeZone) * 9));
        }
        if (delta !== 0) {
          const prevScroll = strip.scrollLeft;
          const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
          const nextScroll = Math.max(0, Math.min(maxScroll, prevScroll + delta));
          if (nextScroll !== prevScroll) {
            strip.scrollLeft = nextScroll;
            const { toIndex, pointerLocalX } = computeReorderMetrics(
              drag.currentClientX,
              segmentsRef.current.length
            );
            if (toIndex !== drag.toIndex) {
              drag.toIndex = toIndex;
              if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
                try {
                  navigator.vibrate(8);
                } catch {
                  // ignore
                }
              }
            }
            const updated: ClipReorderState = {
              sceneId: drag.sceneId,
              fromIndex: drag.fromIndex,
              toIndex: drag.toIndex,
              pointerLocalX,
            };
            clipReorderRef.current = updated;
            setClipReorder(updated);
          }
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeReorderSceneId, computeReorderMetrics]);

  // Reset undo & drag state only when switching to a genuinely different source project
  const projectIdentity = activeTimelineProject
    ? `${activeTimelineProject.localUrl || ""}:${activeTimelineProject.title}`
    : "none";

  useEffect(() => {
    if (previewSeekTimerRef.current !== null) {
      window.clearTimeout(previewSeekTimerRef.current);
      previewSeekTimerRef.current = null;
    }
    cancelClipLongPress();
    if (reorderHintTimerRef.current !== null) {
      window.clearTimeout(reorderHintTimerRef.current);
      reorderHintTimerRef.current = null;
    }
    setReorderHint(null);
    clipReorderRef.current = null;
    setClipReorder(null);
    queuedPreviewSourceSecRef.current = null;
    if (isPreviewOverrideActiveRef.current) {
      isPreviewOverrideActiveRef.current = false;
      onPreviewSourceSeekRef.current?.(null);
    }
    frozenTrackTimeRef.current = null;
    setFrozenTrackTime(null);
    liveScrubCutRef.current = null;
    isUserScrubbingRef.current = false;
    wheelWasPlayingRef.current = false;
    if (wheelClearTimerRef.current !== null) {
      window.clearTimeout(wheelClearTimerRef.current);
      wheelClearTimerRef.current = null;
    }
    wheelTargetCutRef.current = null;
    activePointersRef.current.clear();
    pinchStartRef.current = null;
    updateDragState(null);
    trimPreviewRef.current = null;
    setTrimPreview(null);
    setDragSubPreview(null);
    setDragBadge(null);
    setActiveSceneId(null);
    setLocalActiveSubId(null);
    setShowMergeChoice(false);
    setShowRangeFill(false);
    setRangeNotice(null);
    setBaselineSubRegions(
      hasGeneratedProject(project)
        ? project.subtitles.map((s) => ({
            sourceStartSec: s.sourceStartSec,
            sourceEndSec: s.sourceEndSec,
          }))
        : []
    );
  }, [projectIdentity]);

  // Capture initial subtitle baseline if project mounted with subtitles after identity init
  useEffect(() => {
    if (
      baselineSubRegions.length === 0 &&
      hasGeneratedProject(project) &&
      project.subtitles.length > 0
    ) {
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

  // Clear localActiveSubId if the subtitle no longer exists
  useEffect(() => {
    if (localActiveSubId && !project?.subtitles.some((s) => s.id === localActiveSubId)) {
      setLocalActiveSubId(null);
    }
  }, [project?.subtitles, localActiveSubId]);

  // Measure timeline viewport dimensions so center playhead and vertical free-scroll stay exact
  useEffect(() => {
    if (isCollapsed) return;
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0) setViewportWidth(w);
      if (h > 0) setViewportHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [projectIdentity, isCollapsed]);

  const trackLaneViewportH = Math.max(140, viewportHeight - 24);
  const trackTopBufferPx = Math.max(96, Math.round(trackLaneViewportH * 0.45));
  const trackBottomBufferPx = Math.max(180, Math.round(trackLaneViewportH * 0.78));
  const initialTrackScrollTop = Math.max(0, trackTopBufferPx - 14);

  useEffect(() => {
    userScrolledTracksYRef.current = false;
  }, [projectIdentity]);

  useIsomorphicLayoutEffect(() => {
    if (isCollapsed || userScrolledTracksYRef.current) return;
    const scroller = tracksScrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = initialTrackScrollTop;
    setTrackScrollTop(initialTrackScrollTop);
  }, [isCollapsed, initialTrackScrollTop, projectIdentity]);

  // Subscribe to passive filmstrip frames captured directly from the primary <video> player
  // as well as any secondary uploaded video clips.
  useEffect(() => {
    if (!activeTimelineProject) {
      setThumbnails([]);
      return;
    }

    const extraVideoUrls = Array.from(
      new Set(
        normalizedScenes
          .filter(
            (sc) =>
              sc.mediaType !== "image" &&
              Boolean(sc.mediaUrl) &&
              sc.mediaUrl !== activeTimelineProject.localUrl
          )
          .map((sc) => sc.mediaUrl as string)
      )
    );

    const currentLocalUrl = activeTimelineProject.localUrl;
    const syncFromBus = () => {
      if (currentLocalUrl) {
        const { aspect, frames } = getPassiveTimelineThumbs(currentLocalUrl);
        if (frames.length > 0) {
          setThumbAspect(aspect);
          setThumbnails(frames);
        } else {
          const fallback = activeTimelineProject.keyframeUrls[0] || "";
          setThumbnails(fallback ? [{ sourceSec: 0, url: fallback }] : []);
        }
      } else {
        const fallback = activeTimelineProject.keyframeUrls[0] || "";
        setThumbnails(fallback ? [{ sourceSec: 0, url: fallback }] : []);
      }
      setThumbBusVersion((v) => v + 1);
    };

    syncFromBus();
    const unsubs: (() => void)[] = [];
    if (currentLocalUrl) {
      unsubs.push(subscribePassiveTimelineThumbs(currentLocalUrl, syncFromBus));
    }
    for (const extraUrl of extraVideoUrls) {
      unsubs.push(subscribePassiveTimelineThumbs(extraUrl, syncFromBus));
    }
    return () => {
      for (const fn of unsubs) fn();
    };
  }, [activeTimelineProject?.localUrl, activeTimelineProject?.keyframeUrls, normalizedScenes]);

  const getClipThumbInfo = useCallback(
    (seg: ClipSegment): { aspect: number; frames: TimelineThumbFrame[] } => {
      if (seg.scene.mediaType === "image" && seg.scene.mediaUrl) {
        return {
          aspect: 1,
          frames: [{ sourceSec: 0, url: seg.scene.mediaUrl }],
        };
      }
      if (seg.scene.mediaUrl && seg.scene.mediaUrl !== activeTimelineProject?.localUrl) {
        return getPassiveTimelineThumbs(seg.scene.mediaUrl);
      }
      return { aspect: thumbAspect, frames: thumbnails };
    },
    [activeTimelineProject?.localUrl, thumbAspect, thumbnails]
  );

  // Smoothly throttle rapid drag seeks on Stage9x16 so local video playback stays fluid
  const dispatchSeek = useCallback(
    (targetCut: number, immediate = false, live = false) => {
      const maxCut = totalCutDurationRef.current;
      const clamped = Math.max(0, Math.min(maxCut, targetCut));
      const minIntervalMs = live ? 16 : 28;
      const now = performance.now();

      if (immediate || now - lastSeekDispatchAtRef.current >= minIntervalMs) {
        if (seekThrottleTimerRef.current !== null) {
          window.clearTimeout(seekThrottleTimerRef.current);
          seekThrottleTimerRef.current = null;
        }
        queuedSeekSecRef.current = null;
        lastSeekDispatchAtRef.current = now;
        onSeek(clamped, live ? { live: true } : undefined);
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
            onSeek(next, live ? { live: true } : undefined);
          }
        }, wait);
      }
      return clamped;
    },
    [onSeek]
  );

  const clearPreviewSourceSeekState = useCallback((opts?: { skipResync?: boolean }) => {
    if (previewSeekTimerRef.current !== null) {
      window.clearTimeout(previewSeekTimerRef.current);
      previewSeekTimerRef.current = null;
    }
    queuedPreviewSourceSecRef.current = null;
    if (isPreviewOverrideActiveRef.current) {
      isPreviewOverrideActiveRef.current = false;
      onPreviewSourceSeekRef.current?.(null, opts);
    }
  }, []);

  const dispatchPreviewSourceSeek = useCallback((sourceSec: number, immediate = false) => {
    if (!projectRef.current?.localUrl || !onPreviewSourceSeekRef.current) return;
    isPreviewOverrideActiveRef.current = true;
    const minIntervalMs = 28;
    const now = performance.now();

    if (immediate || now - lastPreviewSeekAtRef.current >= minIntervalMs) {
      if (previewSeekTimerRef.current !== null) {
        window.clearTimeout(previewSeekTimerRef.current);
        previewSeekTimerRef.current = null;
      }
      queuedPreviewSourceSecRef.current = null;
      lastPreviewSeekAtRef.current = now;
      onPreviewSourceSeekRef.current(sourceSec);
      return;
    }

    queuedPreviewSourceSecRef.current = sourceSec;
    if (previewSeekTimerRef.current === null) {
      const wait = Math.max(8, minIntervalMs - (now - lastPreviewSeekAtRef.current));
      previewSeekTimerRef.current = window.setTimeout(() => {
        previewSeekTimerRef.current = null;
        if (queuedPreviewSourceSecRef.current !== null && isPreviewOverrideActiveRef.current) {
          const next = queuedPreviewSourceSecRef.current;
          queuedPreviewSourceSecRef.current = null;
          lastPreviewSeekAtRef.current = performance.now();
          onPreviewSourceSeekRef.current?.(next);
        }
      }, wait);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (seekThrottleTimerRef.current !== null) {
        window.clearTimeout(seekThrottleTimerRef.current);
      }
      if (wheelClearTimerRef.current !== null) {
        window.clearTimeout(wheelClearTimerRef.current);
      }
      isUserScrubbingRef.current = false;
      wheelWasPlayingRef.current = false;
      onScrubbingChangeRef.current?.(false);
      clearPreviewSourceSeekState();
    };
  }, [clearPreviewSourceSeekState]);

  // Explicitly selected Video Clip or Subtitle Clip (exclusive)
  const selectedVideoSegment = useMemo(() => {
    if (!activeSceneId) return null;
    return segments.find((s) => s.sceneId === activeSceneId) ?? null;
  }, [segments, activeSceneId]);

  const selectedSubtitleItem = useMemo(() => {
    if (selectedVideoSegment || !activeSubId || !activeTimelineProject) return null;
    return activeTimelineProject.subtitles.find((s) => s.id === activeSubId) ?? null;
  }, [selectedVideoSegment, activeSubId, activeTimelineProject]);

  const selectedSubtitleIndex = useMemo(() => {
    if (!selectedSubtitleItem || !activeTimelineProject) return -1;
    return activeTimelineProject.subtitles.findIndex((s) => s.id === selectedSubtitleItem.id);
  }, [selectedSubtitleItem, activeTimelineProject]);

  const prevAdjacentSub =
    selectedSubtitleIndex > 0 && activeTimelineProject
      ? activeTimelineProject.subtitles[selectedSubtitleIndex - 1]
      : null;

  const nextAdjacentSub =
    selectedSubtitleIndex >= 0 &&
    activeTimelineProject &&
    selectedSubtitleIndex < activeTimelineProject.subtitles.length - 1
      ? activeTimelineProject.subtitles[selectedSubtitleIndex + 1]
      : null;

  const canMergeSelectedSubtitle = Boolean(
    selectedSubtitleItem && onMergeSubtitleWithNext && (prevAdjacentSub || nextAdjacentSub)
  );

  useEffect(() => {
    setShowMergeChoice(false);
  }, [selectedSubtitleItem?.id, activeSceneId, dragSubPreview, clipReorder]);

  const hasSelectedClip = Boolean(selectedVideoSegment || selectedSubtitleItem);

  useEffect(() => {
    if (hasSelectedClip || clipReorder) {
      setNewSubMarkStartSec(null);
    }
  }, [hasSelectedClip, clipReorder]);

  useEffect(() => {
    setNewSubMarkStartSec(null);
  }, [project?.localUrl]);

  const getCurrentPlayheadSec = useCallback(() => {
    const raw = frozenTrackTimeRef.current ?? liveScrubCutRef.current ?? cutTimeRef.current;
    const safe = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    return Math.max(0, Math.min(totalCutDuration, safe));
  }, [totalCutDuration]);

  const handleMarkNewSubStart = useCallback(() => {
    if (!onAddSubtitle || totalCutDuration <= 0) return;
    const cur = getCurrentPlayheadSec();
    const clampedStart = Number(Math.max(0, Math.min(totalCutDuration, cur)).toFixed(2));
    setNewSubMarkStartSec(clampedStart);
  }, [onAddSubtitle, totalCutDuration, getCurrentPlayheadSec]);

  const handleCommitNewSubEnd = useCallback(() => {
    if (!onAddSubtitle || newSubMarkStartRef.current === null) return;
    const mark = newSubMarkStartRef.current;
    const cur = getCurrentPlayheadSec();
    let startTime = Math.min(mark, cur);
    let endTime = Math.max(mark, cur);
    if (endTime - startTime < 0.2) {
      startTime = Math.min(startTime, Math.max(0, totalCutDuration - 0.2));
      endTime = Math.min(totalCutDuration, Math.max(startTime + 0.2, startTime + 1.5));
    }
    setNewSubMarkStartSec(null);
    onAddSubtitle(
      {
        startTime: Number(startTime.toFixed(2)),
        endTime: Number(endTime.toFixed(2)),
        thaiPhonetic: "",
        burmese: "",
        originalSpokenText: "",
      },
      { select: false, seekToStart: false }
    );
  }, [onAddSubtitle, getCurrentPlayheadSec, totalCutDuration]);

  const handleCancelNewSubMark = useCallback(() => {
    setNewSubMarkStartSec(null);
  }, []);

  const canSplitSelectedClip = useMemo(() => {
    if (selectedVideoSegment) {
      return (
        cutTime > selectedVideoSegment.cutStart + 0.4 &&
        cutTime < selectedVideoSegment.cutEnd - 0.4
      );
    }
    if (selectedSubtitleItem) {
      return (
        Boolean(onSplitSubtitle) &&
        selectedSubtitleItem.endTime - selectedSubtitleItem.startTime >= 0.45
      );
    }
    return false;
  }, [selectedVideoSegment, selectedSubtitleItem, cutTime, onSplitSubtitle]);

  const canDeleteSelectedClip = useMemo(() => {
    if (selectedVideoSegment) return true;
    if (selectedSubtitleItem) return Boolean(onDeleteSubtitle);
    return false;
  }, [selectedVideoSegment, selectedSubtitleItem, onDeleteSubtitle]);

  const handleSplitSelectedClip = useCallback(() => {
    if (selectedVideoSegment) {
      if (
        cutTime <= selectedVideoSegment.cutStart + 0.4 ||
        cutTime >= selectedVideoSegment.cutEnd - 0.4
      ) {
        return;
      }
      if (isPlaying) onPause();

      const localOffset = cutTime - selectedVideoSegment.cutStart;
      const splitSourceSec = roundTenth(selectedVideoSegment.startSec + localOffset);
      if (
        splitSourceSec <= selectedVideoSegment.startSec + 0.35 ||
        splitSourceSec >= selectedVideoSegment.endSec - 0.35
      ) {
        return;
      }

      const leftClip: SpeakingScene = {
        ...selectedVideoSegment.scene,
        id: selectedVideoSegment.sceneId,
        startSec: selectedVideoSegment.startSec,
        endSec: splitSourceSec,
        durationSec: roundTenth(splitSourceSec - selectedVideoSegment.startSec),
      };
      const rightId = `proj-sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const rightClip: SpeakingScene = {
        ...selectedVideoSegment.scene,
        id: rightId,
        startSec: splitSourceSec,
        endSec: selectedVideoSegment.endSec,
        durationSec: roundTenth(selectedVideoSegment.endSec - splitSourceSec),
      };

      const nextScenes = [
        ...normalizedScenes.slice(0, selectedVideoSegment.index),
        leftClip,
        rightClip,
        ...normalizedScenes.slice(selectedVideoSegment.index + 1),
      ];
      onUpdateScenes(nextScenes);
      setActiveSceneId(rightId);
      return;
    }

    if (selectedSubtitleItem && onSplitSubtitle) {
      if (selectedSubtitleItem.endTime - selectedSubtitleItem.startTime < 0.45) return;
      if (isPlaying) onPause();
      onSplitSubtitle(selectedSubtitleItem.id);
    }
  }, [
    selectedVideoSegment,
    selectedSubtitleItem,
    onSplitSubtitle,
    isPlaying,
    onPause,
    cutTime,
    normalizedScenes,
    onUpdateScenes,
  ]);

  const handleDeleteSelectedClip = useCallback(() => {
    if (selectedVideoSegment) {
      if (isPlaying) onPause();

      const nextScenes = normalizedScenes.filter((_, i) => i !== selectedVideoSegment.index);
      onUpdateScenes(nextScenes);
      setActiveSceneId(null);
      selectSub(null, { scrollList: false });

      const newMaxCut = nextScenes.reduce(
        (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
        0
      );
      const nextCut = Math.max(0, Math.min(newMaxCut, selectedVideoSegment.cutStart));
      dispatchSeek(nextCut, true);
      return;
    }

    if (selectedSubtitleItem && onDeleteSubtitle) {
      if (isPlaying) onPause();
      onDeleteSubtitle(selectedSubtitleItem.id);
      selectSub(null, { scrollList: false });
    }
  }, [
    selectedVideoSegment,
    selectedSubtitleItem,
    onDeleteSubtitle,
    isPlaying,
    onPause,
    normalizedScenes,
    onUpdateScenes,
    selectSub,
    dispatchSeek,
  ]);

  const handleMergeSelectedSubtitle = useCallback(
    (direction: "prev" | "next") => {
      if (!selectedSubtitleItem || !onMergeSubtitleWithNext) return;
      if (isPlaying) onPause();
      setShowMergeChoice(false);
      if (direction === "prev" && prevAdjacentSub) {
        onMergeSubtitleWithNext(prevAdjacentSub.id);
        selectSub(prevAdjacentSub.id, { scrollList: false });
      } else if (direction === "next" && nextAdjacentSub) {
        onMergeSubtitleWithNext(selectedSubtitleItem.id);
        selectSub(selectedSubtitleItem.id, { scrollList: false });
      }
    },
    [
      selectedSubtitleItem,
      onMergeSubtitleWithNext,
      isPlaying,
      onPause,
      prevAdjacentSub,
      nextAdjacentSub,
      selectSub,
    ]
  );

  const handleToolbarMergeClick = useCallback(() => {
    if (!canMergeSelectedSubtitle) return;
    if (prevAdjacentSub && nextAdjacentSub) {
      setShowMergeChoice((prev) => !prev);
      return;
    }
    if (nextAdjacentSub) {
      handleMergeSelectedSubtitle("next");
    } else if (prevAdjacentSub) {
      handleMergeSelectedSubtitle("prev");
    }
  }, [
    canMergeSelectedSubtitle,
    prevAdjacentSub,
    nextAdjacentSub,
    handleMergeSelectedSubtitle,
  ]);

  const handleUndo = useCallback(() => {
    if (!canUndo || !onUndo) return;
    if (isPlaying) onPause();
    onUndo();
  }, [canUndo, onUndo, isPlaying, onPause]);

  const handleRedo = useCallback(() => {
    if (!canRedo || !onRedo) return;
    if (isPlaying) onPause();
    onRedo();
  }, [canRedo, onRedo, isPlaying, onPause]);

  const handleRestoreOriginal = useCallback(() => {
    if (isPlaying) onPause();
    setActiveSceneId(null);
    selectSub(null, { scrollList: false });
    onResetTimeline();
    dispatchSeek(0, true);
  }, [isPlaying, onPause, selectSub, onResetTimeline, dispatchSeek]);

  // Keyboard shortcuts: Space to Play/Pause, Delete/Backspace to remove selected clip
  useEffect(() => {
    if (!isActive || !activeTimelineProject) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (e.key === "Escape" && (showMergeChoice || newSubMarkStartRef.current !== null)) {
        e.preventDefault();
        setShowMergeChoice(false);
        setNewSubMarkStartSec(null);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        onTogglePlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && canDeleteSelectedClip) {
        e.preventDefault();
        handleDeleteSelectedClip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    isActive,
    activeTimelineProject,
    onTogglePlay,
    canDeleteSelectedClip,
    handleDeleteSelectedClip,
    showMergeChoice,
  ]);

  const tickStepSec = useMemo(() => {
    if (pxPerSec >= 75) return 1;
    if (pxPerSec >= 34) return 2;
    if (pxPerSec >= 15) return 5;
    if (pxPerSec >= 7.5) return 10;
    if (pxPerSec >= 4.5) return 15;
    if (pxPerSec >= 2.2) return 30;
    if (pxPerSec >= 1.1) return 60;
    if (pxPerSec >= 0.55) return 120;
    if (pxPerSec >= 0.25) return 300;
    if (pxPerSec >= 0.14) return 600;
    return 900;
  }, [pxPerSec]);

  const trackCenterTime = frozenTrackTime ?? liveScrubCutRef.current ?? cutTime;
  const centerX = viewportWidth / 2;
  const trackWidth = Math.max(totalCutDuration * pxPerSec, 1);
  const trackTranslateX = centerX - trackCenterTime * pxPerSec;

  const timelineTransformConfigRef = useRef({
    centerX,
    viewportWidth,
    pxPerSec,
    tickStepSec,
    totalCutDuration,
    frozen: frozenTrackTime !== null,
  });
  timelineTransformConfigRef.current = {
    centerX,
    viewportWidth,
    pxPerSec,
    tickStepSec,
    totalCutDuration,
    frozen: frozenTrackTime !== null,
  };

  const drawRulerAtTime = useCallback((centerSec: number) => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    const cfg = timelineTransformConfigRef.current;
    const w = Math.max(1, Math.round(cfg.viewportWidth));
    const h = 24;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const isDark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const textColor = isDark ? "#919ec4" : "#4d597d";
    const tickColor = isDark ? "#2f3866" : "#bcc9e6";

    const pps = cfg.pxPerSec;
    const step = cfg.tickStepSec;
    const halfSec = cfg.centerX / Math.max(0.05, pps);
    const minSec = Math.max(0, Math.floor((centerSec - halfSec) / step) * step - step);
    const maxSec = Math.min(cfg.totalCutDuration + 0.01, centerSec + halfSec + step);

    ctx.font =
      '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";

    ctx.beginPath();
    ctx.strokeStyle = tickColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;

    for (let s = minSec; s <= maxSec; s += step) {
      const x = cfg.centerX + (s - centerSec) * pps;
      if (x < -48 || x > w + 48) continue;
      const tickX = Math.round(x) + 0.5;
      ctx.moveTo(tickX, h - 6);
      ctx.lineTo(tickX, h);
      ctx.fillText(formatRulerTick(s), x + 4, h - 7);
    }
    ctx.stroke();
  }, []);

  const applyVisualCutTime = useCallback(
    (rawSec: number) => {
      const liveSec =
        typeof rawSec === "number" && Number.isFinite(rawSec) ? Math.max(0, rawSec) : 0;
      const cfg = timelineTransformConfigRef.current;
      const nextX = cfg.centerX - liveSec * cfg.pxPerSec;
      const transformVal = `translate3d(${nextX}px, 0, 0)`;
      if (trackSlideRef.current) {
        trackSlideRef.current.style.transform = transformVal;
      }
      drawRulerAtTime(liveSec);
      if (timeReadoutRef.current) {
        timeReadoutRef.current.textContent = formatTimePrecise(liveSec);
      }
      const markStart = newSubMarkStartRef.current;
      if (markStart !== null) {
        const clampedLive = Math.min(cfg.totalCutDuration, liveSec);
        const lo = Math.min(markStart, clampedLive);
        const hi = Math.max(markStart, clampedLive);
        const spanSec = Math.max(0, hi - lo);
        if (newSubPreviewBarRef.current) {
          newSubPreviewBarRef.current.style.left = `${lo * cfg.pxPerSec}px`;
          newSubPreviewBarRef.current.style.width = `${Math.max(4, spanSec * cfg.pxPerSec)}px`;
        }
        if (newSubEndDurRef.current) {
          newSubEndDurRef.current.textContent =
            spanSec >= 0.2 ? `Set End · ${spanSec.toFixed(1)}s` : "Set End";
        }
      }
    },
    [drawRulerAtTime]
  );

  useIsomorphicLayoutEffect(() => {
    const activeSec = frozenTrackTime ?? liveScrubCutRef.current ?? cutTime;
    const safeCut = typeof activeSec === "number" && Number.isFinite(activeSec) ? Math.max(0, activeSec) : 0;
    applyVisualCutTime(safeCut);
  }, [
    cutTime,
    frozenTrackTime,
    viewportWidth,
    pxPerSec,
    tickStepSec,
    totalCutDuration,
    isCollapsed,
    project?.scenes.length,
    newSubMarkStartSec,
    applyVisualCutTime,
  ]);

  // Redraw ruler canvas immediately when light/dark theme toggles
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const obs = new MutationObserver(() => {
      const activeSec = frozenTrackTimeRef.current ?? liveScrubCutRef.current ?? cutTimeRef.current;
      drawRulerAtTime(activeSec);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, [drawRulerAtTime]);

  useEffect(() => {
    if (!subscribeCutTime) return;
    return subscribeCutTime((rawLiveSec) => {
      const liveSec =
        typeof rawLiveSec === "number" && Number.isFinite(rawLiveSec) ? Math.max(0, rawLiveSec) : 0;
      const cfg = timelineTransformConfigRef.current;
      if (cfg.frozen || dragStateRef.current || liveScrubCutRef.current !== null) return;
      cutTimeRef.current = liveSec;
      applyVisualCutTime(liveSec);
    });
  }, [subscribeCutTime, applyVisualCutTime]);

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

  const aiSubtitleGuides = useMemo(() => {
    const subs = activeTimelineProject?.subtitles ?? [];
    if (subs.length === 0 || segments.length === 0) return [];
    const list: Array<{
      key: string;
      subId: string;
      subIdx: number;
      cutStart: number;
      cutEnd: number;
      currentStart: number;
      currentEnd: number;
    }> = [];
    subs.forEach((sub, subIdx) => {
      const origSrcStart =
        typeof sub.aiSourceStartSec === "number" && Number.isFinite(sub.aiSourceStartSec)
          ? sub.aiSourceStartSec
          : sub.sourceStartSec;
      const origSrcEnd =
        typeof sub.aiSourceEndSec === "number" && Number.isFinite(sub.aiSourceEndSec)
          ? sub.aiSourceEndSec
          : sub.sourceEndSec;
      if (!Number.isFinite(origSrcStart) || !Number.isFinite(origSrcEnd) || origSrcEnd <= origSrcStart) {
        return;
      }

      const matchesCurrentSource =
        !sub.isManuallyEdited &&
        Math.abs(origSrcStart - sub.sourceStartSec) < 0.005 &&
        Math.abs(origSrcEnd - sub.sourceEndSec) < 0.005;

      if (matchesCurrentSource) {
        list.push({
          key: `ai-guide-${sub.id}-0`,
          subId: sub.id,
          subIdx,
          cutStart: sub.startTime,
          cutEnd: sub.endTime,
          currentStart: sub.startTime,
          currentEnd: sub.endTime,
        });
        return;
      }

      const projected = projectSpeechRegionsToCutTimeline(segments, [
        { sourceStartSec: origSrcStart, sourceEndSec: origSrcEnd },
      ]);
      projected.forEach((proj, pIdx) => {
        list.push({
          key: `ai-guide-${sub.id}-${pIdx}`,
          subId: sub.id,
          subIdx,
          cutStart: Number(proj.cutStart.toFixed(2)),
          cutEnd: Number(proj.cutEnd.toFixed(2)),
          currentStart: sub.startTime,
          currentEnd: sub.endTime,
        });
      });
    });
    return list;
  }, [activeTimelineProject?.subtitles, segments]);

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
    const onWinCancel = (ev: PointerEvent) => {
      pointerCancelHandlerRef.current(ev);
    };
    const onWinKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && dragStateRef.current) {
        ev.preventDefault();
        pointerCancelHandlerRef.current();
      }
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
    window.addEventListener("pointercancel", onWinCancel);
    window.addEventListener("keydown", onWinKeyDown);
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("blur", onWinBlur);
    windowDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onWinMove);
      window.removeEventListener("pointerup", onWinEnd);
      window.removeEventListener("pointercancel", onWinCancel);
      window.removeEventListener("keydown", onWinKeyDown);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("blur", onWinBlur);
    };
  }, []);

  useEffect(() => {
    if (isCollapsed || !isActive) {
      pointerCancelHandlerRef.current();
    }
  }, [isCollapsed, isActive]);

  useEffect(() => {
    return () => {
      cancelClipLongPress();
      if (reorderHintTimerRef.current !== null) {
        window.clearTimeout(reorderHintTimerRef.current);
        reorderHintTimerRef.current = null;
      }
      stopWindowPointerTracking();
    };
  }, [cancelClipLongPress, stopWindowPointerTracking]);

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
      cancelClipLongPress();
      if (isPlaying) onPause();
      updateDragState(null);
      clipReorderRef.current = null;
      setClipReorder(null);
      trimPreviewRef.current = null;
      setTrimPreview(null);
      setDragSubPreview(null);
      frozenTrackTimeRef.current = null;
      setFrozenTrackTime(null);
      setDragBadge(null);
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      pinchStartRef.current = { dist, pxPerSec };
      return;
    }

    if (activePointersRef.current.size === 1) {
      setShowMergeChoice(false);
      pinchStartRef.current = null;
      const startTime = liveScrubCutRef.current ?? cutTimeRef.current;
      const nextDrag: DragMode = {
        type: "scrub",
        pointerType: e.pointerType || "mouse",
        startClientX: e.clientX,
        scrubAnchorClientX: e.clientX,
        startClientY: e.clientY,
        lastClientY: e.clientY,
        startCutTime: startTime,
        axis: "pending",
        wasPlayingBeforeScrub: isPlayingRef.current,
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
    cancelClipLongPress();
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    blurFocusedButton();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startWindowPointerTracking();
    if (isPlaying) onPause();

    const freezeCut = liveScrubCutRef.current ?? cutTimeRef.current;
    frozenTrackTimeRef.current = freezeCut;
    setActiveSceneId(seg.sceneId);
    selectSub(null, { scrollList: false });
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
    const isImageClip = seg.scene.mediaType === "image";
    trimPreviewRef.current = initTrim;
    setTrimPreview(initTrim);
    if (mode === "trim-start") {
      updateDragState({
        type: "trim-start",
        sceneId: seg.sceneId,
        startClientX: e.clientX,
        origStartSec: seg.startSec,
        origEndSec: seg.endSec,
        origCutStart: seg.cutStart,
        isImage: isImageClip,
      });
    } else {
      updateDragState({
        type: "trim-end",
        sceneId: seg.sceneId,
        startClientX: e.clientX,
        origStartSec: seg.startSec,
        origEndSec: seg.endSec,
        origCutStart: seg.cutStart,
        maxEndSec: seg.maxSourceSec,
        isImage: isImageClip,
      });
    }
    if (!isImageClip) {
      dispatchPreviewSourceSeek(mode === "trim-start" ? seg.startSec : seg.endSec, true);
    }
  };

  const handlePointerDownSubInteraction = (
    e: React.PointerEvent<HTMLElement>,
    mode: "sub-move" | "sub-trim-start" | "sub-trim-end",
    sub: SubtitleItem,
    subIndex: number
  ) => {
    e.stopPropagation();
    cancelClipLongPress();
    if (e.button !== 0 && e.pointerType === "mouse") return;
    blurFocusedButton();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startWindowPointerTracking();
    if (isPlaying) onPause();

    lastDragTargetRef.current = null;
    setActiveSceneId(null);
    selectSub(sub.id, { scrollList: false });
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
        pinchStartRef.current.pxPerSec * (dist / pinchStartRef.current.dist),
        minPxPerSecRef.current
      );
      setPxPerSec(nextZoom);
      return;
    }

    const activeDrag = dragStateRef.current;
    if (!activeDrag) return;
    if ("cancelable" in e && e.cancelable) e.preventDefault();

    if (activeDrag.type === "clip-reorder") {
      activeDrag.currentClientX = e.clientX;
      const { toIndex, pointerLocalX } = computeReorderMetrics(
        e.clientX,
        segmentsRef.current.length
      );
      if (toIndex !== activeDrag.toIndex) {
        activeDrag.toIndex = toIndex;
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(8);
          } catch {
            // ignore
          }
        }
      }
      const nextReorder: ClipReorderState = {
        sceneId: activeDrag.sceneId,
        fromIndex: activeDrag.fromIndex,
        toIndex: activeDrag.toIndex,
        pointerLocalX,
      };
      clipReorderRef.current = nextReorder;
      setClipReorder(nextReorder);
      return;
    }

    if (longPressPendingRef.current) {
      const pending = longPressPendingRef.current;
      const holdMoveDist = Math.hypot(
        e.clientX - pending.startClientX,
        e.clientY - pending.startClientY
      );
      if (holdMoveDist < 8) {
        return;
      }
      cancelClipLongPress();
    }

    const dx = e.clientX - activeDrag.startClientX;

    if (activeDrag.type === "scrub") {
      const canScrollTimelineY = () => {
        const scroller = tracksScrollRef.current;
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return true;
        return hasVerticalScrollRoom(viewportRef.current);
      };

      const applyTimelineScrollY = (deltaY: number) => {
        const scroller = tracksScrollRef.current;
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
          userScrolledTracksYRef.current = true;
          const prevTop = scroller.scrollTop;
          const maxTop = scroller.scrollHeight - scroller.clientHeight;
          const nextTop = Math.max(0, Math.min(maxTop, prevTop + deltaY));
          scroller.scrollTop = nextTop;
          return;
        }
        scrollVerticalAncestors(viewportRef.current, deltaY);
      };

      if (activeDrag.axis === "pending") {
        const dy = e.clientY - activeDrag.startClientY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const dist = Math.hypot(dx, dy);
        if (dist < 5) return;
        const canScrollVertically = canScrollTimelineY();
        if (canScrollVertically && absDy > absDx * 0.85) {
          activeDrag.axis = "y";
          applyTimelineScrollY(-dy);
          activeDrag.lastClientY = e.clientY;
          tappedClipRef.current = null;
          tappedSubRef.current = null;
          return;
        } else {
          activeDrag.axis = "x";
          activeDrag.wasPlayingBeforeScrub = isPlayingRef.current;
          isUserScrubbingRef.current = true;
          // Enter live scroll-controlled preview mode without flipping isPlaying to false
          // so playback resumes seamlessly upon release if it was playing.
          onScrubbingChangeRef.current?.(true);
          // Anchor drag start to exact current playhead position so horizontal scrubbing starts without a jump
          activeDrag.startCutTime = liveScrubCutRef.current ?? cutTimeRef.current;
          activeDrag.scrubAnchorClientX = e.clientX;
        }
      }

      if (activeDrag.axis === "y") {
        const moveY = e.clientY - activeDrag.lastClientY;
        activeDrag.lastClientY = e.clientY;
        applyTimelineScrollY(-moveY);
        return;
      }

      if (tappedClipRef.current && Math.abs(dx) > 5) {
        tappedClipRef.current.moved = true;
      }
      if (tappedSubRef.current && Math.abs(dx) > 5) {
        tappedSubRef.current.moved = true;
      }

      const scrubDx = e.clientX - activeDrag.scrubAnchorClientX;
      const dt = scrubDx / pxPerSec;
      const nextCut = Math.max(
        0,
        Math.min(totalCutDurationRef.current, activeDrag.startCutTime - dt)
      );
      liveScrubCutRef.current = nextCut;
      cutTimeRef.current = nextCut;
      applyVisualCutTime(nextCut);
      dispatchSeek(nextCut, false, true);
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
      if (!activeDrag.isImage) {
        dispatchPreviewSourceSeek(nextStart);
      }
      return;
    }

    if (activeDrag.type === "trim-end") {
      const nextEnd = roundTenth(
        Math.min(
          activeDrag.maxEndSec,
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
      if (!activeDrag.isImage) {
        dispatchPreviewSourceSeek(nextEnd);
      }
      return;
    }

    if (
      activeDrag.type === "sub-move" ||
      activeDrag.type === "sub-trim-start" ||
      activeDrag.type === "sub-trim-end"
    ) {
      const sortedSubs = [...(projectRef.current?.subtitles ?? [])].sort(
        (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
      );
      const curIdx = sortedSubs.findIndex((s) => s.id === activeDrag.subId);
      const prevSub = curIdx > 0 ? sortedSubs[curIdx - 1] : null;
      const nextSub =
        curIdx >= 0 && curIdx < sortedSubs.length - 1 ? sortedSubs[curIdx + 1] : null;
      const maxTotal = Math.max(
        activeDrag.origEndTime,
        totalCutDurationRef.current || activeDrag.origEndTime
      );
      const prevEndBound = prevSub ? Math.max(0, prevSub.endTime) : 0;
      const nextStartBound = nextSub ? Math.min(maxTotal, nextSub.startTime) : maxTotal;

      if (activeDrag.type === "sub-move") {
        const dur = Math.max(0.2, activeDrag.origEndTime - activeDrag.origStartTime);
        const minStart =
          prevEndBound <= activeDrag.origStartTime
            ? prevEndBound
            : Math.min(activeDrag.origStartTime, prevEndBound);
        const rawMaxStart = Math.max(0, nextStartBound - dur);
        const maxStart =
          rawMaxStart >= minStart
            ? rawMaxStart
            : Math.max(minStart, activeDrag.origStartTime);
        const unclamped = roundTenth(activeDrag.origStartTime + dt);
        const nextStart = Number(Math.max(minStart, Math.min(maxStart, unclamped)).toFixed(2));
        const nextEnd = Number(
          Math.min(Math.max(nextStart + 0.2, nextStartBound), nextStart + dur).toFixed(2)
        );
        const preview = { id: activeDrag.subId, startTime: nextStart, endTime: nextEnd };
        dragSubPreviewRef.current = preview;
        setDragSubPreview(preview);
        lastDragTargetRef.current = { cutTime: nextStart, sourceSec: nextStart };
        dispatchSeek(nextStart);
        setDragBadge({ label: `Sub #${activeDrag.subIndex + 1}`, sec: nextStart });
        return;
      }

      if (activeDrag.type === "sub-trim-start") {
        const upperLimit = Math.max(0, activeDrag.origEndTime - 0.2);
        const lowerLimit =
          prevEndBound <= upperLimit ? prevEndBound : Math.min(activeDrag.origStartTime, upperLimit);
        const unclamped = roundTenth(activeDrag.origStartTime + dt);
        const nextStart = Number(Math.max(lowerLimit, Math.min(upperLimit, unclamped)).toFixed(2));
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
        const lowerLimit = activeDrag.origStartTime + 0.2;
        const upperLimit =
          nextStartBound >= lowerLimit
            ? nextStartBound
            : Math.max(activeDrag.origEndTime, lowerLimit);
        const unclamped = roundTenth(activeDrag.origEndTime + dt);
        const nextEnd = Number(Math.min(upperLimit, Math.max(lowerLimit, unclamped)).toFixed(2));
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
    }
  };

  const handlePointerUpAny = useCallback(
    (e?: React.PointerEvent<HTMLElement> | PointerEvent) => {
      cancelClipLongPress();
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

      if (activeDrag.type === "clip-reorder") {
        const { fromIndex, toIndex, sceneId } = activeDrag;
        clipReorderRef.current = null;
        setClipReorder(null);
        tappedClipRef.current = null;
        tappedSubRef.current = null;

        if (fromIndex !== toIndex) {
          const nextScenes = [...normalizedScenesRef.current];
          if (fromIndex >= 0 && fromIndex < nextScenes.length) {
            const [moved] = nextScenes.splice(fromIndex, 1);
            if (moved) {
              const clampedTo = Math.max(0, Math.min(nextScenes.length, toIndex));
              nextScenes.splice(clampedTo, 0, moved);
              onUpdateScenes(nextScenes);
              let movedCutStart = 0;
              for (let i = 0; i < clampedTo; i++) {
                movedCutStart += Math.max(0.1, nextScenes[i].endSec - nextScenes[i].startSec);
              }
              setActiveSceneId(sceneId);
              dispatchSeek(movedCutStart, true);
            }
          }
        } else {
          setActiveSceneId(sceneId);
        }

        setDragBadge(null);
        updateDragState(null);
        if (activePointersRef.current.size === 0) {
          stopWindowPointerTracking();
        }
        return;
      }

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
          selectSub(null, { scrollList: false });
        } else if (hadSubTap && tappedSubRef.current) {
          const tappedSubId = tappedSubRef.current.subId;
          setActiveSceneId(null);
          selectSub(tappedSubId, { scrollList: true });
          subTapSeekTarget = tappedSubRef.current.startTime;
        } else if (isUnmovedTouchTap && !hadClipTap && !hadSubTap) {
          setActiveSceneId(null);
          selectSub(null, { scrollList: false });
        }
      }
      tappedClipRef.current = null;
      tappedSubRef.current = null;

      if (activeDrag.type === "scrub") {
        isUserScrubbingRef.current = false;
        const finalScrubCut = liveScrubCutRef.current;
        liveScrubCutRef.current = null;

        if (seekThrottleTimerRef.current !== null) {
          window.clearTimeout(seekThrottleTimerRef.current);
          seekThrottleTimerRef.current = null;
        }
        const pendingQueued = queuedSeekSecRef.current;
        queuedSeekSecRef.current = null;

        const shouldResumePlay = activeDrag.wasPlayingBeforeScrub && isPlayingRef.current;
        onScrubbingChangeRef.current?.(false);

        if (subTapSeekTarget !== null) {
          if (shouldResumePlay) {
            onPlayFromTimeRef.current(subTapSeekTarget);
          } else {
            dispatchSeek(subTapSeekTarget, true);
          }
        } else if (activeDrag.axis === "x") {
          const targetCut = finalScrubCut ?? pendingQueued ?? cutTimeRef.current;
          if (shouldResumePlay) {
            // Continue playing smoothly from the released scroll position
            onPlayFromTimeRef.current(targetCut);
          } else {
            // Stay paused cleanly at the exact scrolled frame
            dispatchSeek(targetCut, true);
          }
        } else if (pendingQueued !== null) {
          dispatchSeek(pendingQueued, true);
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
          (Math.abs(preview.startTime - activeDrag.origStartTime) >= 0.01 ||
            Math.abs(preview.endTime - activeDrag.origEndTime) >= 0.01)
        ) {
          onUpdateSubtitleTiming?.(preview.id, preview.startTime, preview.endTime);
          dispatchSeek(target.cutTime, true);
        } else if (activeDrag.type === "sub-move" && !target) {
          dispatchSeek(activeDrag.origStartTime, true);
        }
        selectSub(activeDrag.subId, { scrollList: true });
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

        const changed = Boolean(
          preview &&
            (Math.abs(preview.nextStartSec - preview.origStartSec) >= 0.01 ||
              Math.abs(preview.nextEndSec - preview.origEndSec) >= 0.01)
        );
        if (preview && changed) {
          clearPreviewSourceSeekState({ skipResync: true });
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
        } else {
          clearPreviewSourceSeekState();
        }
        lastDragTargetRef.current = null;
      }

      setDragBadge(null);
      updateDragState(null);
      if (activePointersRef.current.size === 0) {
        stopWindowPointerTracking();
      }
    },
    [
      clearPreviewSourceSeekState,
      dispatchSeek,
      onUpdateScenes,
      onUpdateSubtitleTiming,
      selectSub,
      stopWindowPointerTracking,
      updateDragState,
      cancelClipLongPress,
    ]
  );

  const handlePointerCancelAny = useCallback(
    (e?: PointerEvent) => {
      cancelClipLongPress();
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
      dragStateRef.current = null;
      tappedClipRef.current = null;
      tappedSubRef.current = null;
      lastDragTargetRef.current = null;

      if (activeDrag?.type === "clip-reorder" || clipReorderRef.current) {
        clipReorderRef.current = null;
        setClipReorder(null);
      }

      if (activeDrag?.type === "scrub") {
        isUserScrubbingRef.current = false;
        const finalScrubCut = liveScrubCutRef.current;
        liveScrubCutRef.current = null;
        if (seekThrottleTimerRef.current !== null) {
          window.clearTimeout(seekThrottleTimerRef.current);
          seekThrottleTimerRef.current = null;
        }
        queuedSeekSecRef.current = null;
        const shouldResumePlay = Boolean(
          e && activeDrag.axis === "x" && activeDrag.wasPlayingBeforeScrub && isPlayingRef.current
        );
        onScrubbingChangeRef.current?.(false);
        if (activeDrag.axis === "x" && finalScrubCut !== null) {
          if (shouldResumePlay) {
            onPlayFromTimeRef.current(finalScrubCut);
          } else {
            dispatchSeek(finalScrubCut, true);
          }
        }
      } else if (
        activeDrag?.type === "sub-move" ||
        activeDrag?.type === "sub-trim-start" ||
        activeDrag?.type === "sub-trim-end"
      ) {
        dragSubPreviewRef.current = null;
        setDragSubPreview(null);
        setFrozenTrackTime(null);
      } else if (
        activeDrag?.type === "trim-start" ||
        activeDrag?.type === "trim-end" ||
        trimPreviewRef.current !== null ||
        isPreviewOverrideActiveRef.current
      ) {
        trimPreviewRef.current = null;
        setTrimPreview(null);
        frozenTrackTimeRef.current = null;
        setFrozenTrackTime(null);
        clearPreviewSourceSeekState();
      }

      setDragBadge(null);
      if (activePointersRef.current.size === 0) {
        stopWindowPointerTracking();
      }
    },
    [cancelClipLongPress, clearPreviewSourceSeekState, stopWindowPointerTracking]
  );

  pointerMoveHandlerRef.current = handlePointerMoveViewport;
  pointerUpHandlerRef.current = handlePointerUpAny;
  pointerCancelHandlerRef.current = handlePointerCancelAny;

  // Two-finger trackpad pinch-to-zoom (ctrlKey + wheel) & horizontal/vertical scroll scrub
  const wheelStateRef = useRef({ pxPerSec, dispatchSeek, applyVisualCutTime });
  wheelStateRef.current = { pxPerSec, dispatchSeek, applyVisualCutTime };
  useEffect(() => {
    if (isCollapsed) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.008);
        setPxPerSec((z) => clampZoom(z * factor, minPxPerSecRef.current));
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
        applyVisualCutTime: paintCutTime,
      } = wheelStateRef.current;
      if (wheelClearTimerRef.current === null) {
        wheelWasPlayingRef.current = isPlayingRef.current;
        isUserScrubbingRef.current = true;
        onScrubbingChangeRef.current?.(true);
      }

      const now = performance.now();
      const baseCut =
        wheelTargetCutRef.current && wheelTargetCutRef.current.expiresAt > now
          ? wheelTargetCutRef.current.cutTime
          : liveScrubCutRef.current ?? cutTimeRef.current;
      const next = Math.max(0, Math.min(totalCutDurationRef.current, baseCut + delta / pps));
      wheelTargetCutRef.current = { cutTime: next, expiresAt: now + 260 };
      liveScrubCutRef.current = next;
      cutTimeRef.current = next;
      paintCutTime(next);
      seek(next, false, true);

      if (wheelClearTimerRef.current !== null) {
        window.clearTimeout(wheelClearTimerRef.current);
      }
      wheelClearTimerRef.current = window.setTimeout(() => {
        wheelClearTimerRef.current = null;
        isUserScrubbingRef.current = false;
        const shouldResume = wheelWasPlayingRef.current && isPlayingRef.current;
        wheelWasPlayingRef.current = false;
        const finalWheelCut = liveScrubCutRef.current;
        liveScrubCutRef.current = null;
        onScrubbingChangeRef.current?.(false);
        if (finalWheelCut !== null) {
          if (shouldResume) {
            onPlayFromTimeRef.current(finalWheelCut);
          } else {
            seek(finalWheelCut, true);
          }
        }
      }, 240);
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

  const handleTimelineContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea")) return;
    e.preventDefault();
  };

  // Empty "No video" state when no active project media is loaded
  if (!activeTimelineProject) {
    if (dockMode) {
      return (
        <div
          onContextMenu={handleTimelineContextMenu}
          onDragStart={(e) => e.preventDefault()}
          className={`timeline-no-callout ${
            fillHeight
              ? "flex-1 min-h-0 flex flex-col justify-center bg-white dark:bg-[#0d1022] overflow-hidden"
              : "border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden"
          }`}
        >
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
                  {hideCaptions
                    ? "Upload a video on the 9:16 Stage to split, trim, and arrange clips on the timeline."
                    : "Upload a video and generate subtitles in Upload & Cut to unlock the multi-track timeline."}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {!hideCaptions && onGoToScenes && (
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
      <div
        onContextMenu={handleTimelineContextMenu}
        onDragStart={(e) => e.preventDefault()}
        className="timeline-no-callout flex flex-col gap-4 pb-6"
      >
        <div className="w-full aspect-video rounded-lg border border-dashed border-[#bcc9e6] dark:border-[#2e3644] bg-white dark:bg-[#0d1022] flex flex-col items-center justify-center text-center p-6 gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-50 dark:bg-teal-950/60 border border-teal-200/70 dark:border-teal-500/25 flex items-center justify-center text-teal-700 dark:text-teal-400">
            <Film className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-sm">
            <p className="font-display text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
              No video
            </p>
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4] leading-relaxed">
              {hideCaptions
                ? "Upload a video to split, trim, and arrange clips on the timeline before exporting."
                : "Generate subtitles first to edit your 9:16 video on the timeline before exporting."}
            </p>
          </div>
          {onGoToScenes && (
            <button
              type="button"
              onClick={onGoToScenes}
              className="mt-1 h-9 px-4 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors"
            >
              <span>{hideCaptions ? "Edit" : "Upload & Cut"}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onContextMenu={handleTimelineContextMenu}
      onDragStart={(e) => e.preventDefault()}
      className={`timeline-no-callout ${
        dockMode
          ? fillHeight
            ? "flex-1 min-h-0 bg-white dark:bg-[#0d1022] overflow-hidden flex flex-col"
            : "border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden flex flex-col"
          : compactMobileExpanded
            ? "bg-white dark:bg-[#0d1022] overflow-hidden flex flex-col"
            : "flex flex-col gap-3.5 pb-6"
      }`}
    >
      {/* Video Summary Header (Standard Mode) */}
      {!dockMode && !compactMobileExpanded && !hideHeader && (
        <div className="px-3 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
              {activeTimelineProject.title}
            </p>
            <p className="text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
              {isDraft || hideCaptions ? "9:16 Video" : "9:16 Subtitle Video"} · {segments.length}{" "}
              {segments.length === 1 ? "clip" : "clips"} · {roundTenth(totalCutDuration)}s
            </p>
          </div>
        </div>
      )}

      {/* Minimal Top Bar (only shown when Play/Timecode, Undo/Redo, or Collapse are enabled) */}
      {((!hideTransport && !compactMobileExpanded) ||
        !hideUndoRedo ||
        Boolean(dockMode && onToggleCollapse)) && (
        <div
          className={
            dockMode
              ? `px-3.5 py-1.5 flex items-center justify-between gap-2 bg-[#f3f5fc]/70 dark:bg-[#0a0d1c] ${
                  !isCollapsed ? "border-b border-[#d2dcf0] dark:border-[#21284c]" : ""
                }`
              : compactMobileExpanded
                ? "px-2.5 py-1 flex items-center justify-between gap-1.5 bg-[#f3f5fc]/50 dark:bg-[#070814]/60 border-b border-[#d2dcf0] dark:border-[#21284c]"
                : "flex items-center justify-between gap-2 px-0.5"
          }
        >
          {hideTransport || compactMobileExpanded ? (
            dockMode ? (
              <span className="text-[11px] font-semibold tracking-wide text-[#4d597d] dark:text-[#919ec4] shrink-0 select-none">
                Timeline
              </span>
            ) : (
              <span />
            )
          ) : (
            <div className="flex items-center gap-2 min-w-0">
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
            </div>
          )}

          <div className="flex items-center gap-1 shrink-0">
            {!hideUndoRedo && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    handleUndo();
                  }}
                  disabled={!canUndo || !onUndo}
                  title="Undo last edit"
                  aria-label="Undo last edit"
                  className="h-7 w-7 rounded-sm hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    handleRedo();
                  }}
                  disabled={!canRedo || !onRedo}
                  title="Redo last edit"
                  aria-label="Redo last edit"
                  className="h-7 w-7 rounded-sm hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <Redo2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            {dockMode && onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                title={isCollapsed ? "Expand timeline dock" : "Collapse timeline dock"}
                aria-label={isCollapsed ? "Expand timeline dock" : "Collapse timeline dock"}
                className="h-7 w-7 rounded-sm hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center cursor-pointer transition-colors"
              >
                {isCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>
      )}

      {!isDraft && !hideCaptions && onTranscribeRange && showRangeFill && (
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
      {(!dockMode || !isCollapsed) && (() => {
        const showFullSubTrack = !isDraft && !hideCaptions;
        const showSubtitleClipsOnly =
          !isDraft && hideCaptions && showSubtitleTrack && activeTimelineProject.subtitles.length > 0;
        const hasVisibleSubTrack =
          showFullSubTrack || showSubtitleClipsOnly || newSubMarkStartSec !== null;

        return (
        <div
          className={`relative overflow-hidden bg-[#e7ecf8] dark:bg-[#050712] ${
            dockMode
              ? fillHeight
                ? hasVisibleSubTrack
                  ? "flex-1 min-h-[218px]"
                  : "flex-1 min-h-[164px]"
                : compactDock
                  ? hasVisibleSubTrack
                    ? "h-[212px]"
                    : "h-[156px]"
                  : hasVisibleSubTrack
                    ? "h-[224px]"
                    : "h-[168px]"
              : compactMobileExpanded
                ? "h-[212px]"
                : hasVisibleSubTrack
                  ? "h-[272px] rounded-lg border border-[#d2dcf0] dark:border-[#21284c]"
                  : "h-[196px] rounded-lg border border-[#d2dcf0] dark:border-[#21284c]"
          }`}
        >
        <div
          ref={viewportRef}
          onPointerDown={handlePointerDownViewport}
          className="absolute inset-0 overflow-hidden select-none touch-none [&_*]:touch-none cursor-grab active:cursor-grabbing"
        >
        {/* Pinned Top Time Ruler Bar (O(1) Retina canvas — stays smooth even on multi-hour videos) */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-6 z-10 overflow-hidden border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95">
          <canvas ref={rulerCanvasRef} className="block w-full h-full" />
        </div>

        {/* Compact Timeline Zoom Controls pinned to Top-Right of Ruler */}
        {!clipReorder && segments.length > 0 && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute top-0 right-0 h-6 z-20 flex items-center gap-0.5 pl-1.5 pr-1 bg-white/95 dark:bg-[#0d1022]/95 border-l border-b border-[#d2dcf0] dark:border-[#21284c]"
          >
            <button
              type="button"
              disabled={pxPerSec <= minPxPerSec + 0.001}
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(z / 1.5, minPxPerSecRef.current));
              }}
              title="Zoom out timeline"
              aria-label="Zoom out timeline"
              className="h-5 w-5 rounded flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec(fitPxPerSec);
              }}
              title="Fit full timeline in view"
              aria-label="Fit full timeline in view"
              className="h-5 px-1.5 rounded text-[10px] font-semibold tracking-tight text-[#4d597d] dark:text-[#919ec4] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
            >
              Fit
            </button>
            <button
              type="button"
              disabled={pxPerSec >= MAX_TIMELINE_ZOOM - 0.05}
              onClick={(e) => {
                e.currentTarget.blur();
                setPxPerSec((z) => clampZoom(z * 1.5, minPxPerSecRef.current));
              }}
              title="Zoom in timeline"
              aria-label="Zoom in timeline"
              className="h-5 w-5 rounded flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Vertically Scrollable Timeline Tracks Area with Free Up & Down Travel */}
        <div
          ref={tracksScrollRef}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setTrackScrollTop(top);
            if (Math.abs(top - initialTrackScrollTop) > 2) {
              userScrolledTracksYRef.current = true;
            }
          }}
          className="absolute inset-x-0 top-6 bottom-0 overflow-y-auto overflow-x-hidden no-scrollbar"
        >
          <div
            style={{
              paddingTop: `${trackTopBufferPx}px`,
              paddingBottom: `${trackBottomBufferPx}px`,
            }}
            className="relative"
          >
            {/* Moving Timeline Content Track */}
            <div
              ref={trackSlideRef}
              style={{
                width: `${trackWidth}px`,
                transform: `translate3d(${trackTranslateX}px, 0, 0)`,
              }}
              className="relative will-change-transform"
            >
              {/* Kept Video Clips Track */}
              <div
                className={`relative h-16 transition-opacity duration-150 ${
                  clipReorder ? "opacity-0 pointer-events-none" : ""
                }`}
              >
            {(() => {
              const trimIdx = trimPreview
                ? segments.findIndex((s) => s.sceneId === trimPreview.sceneId)
                : -1;
              const trimDeltaStart =
                trimPreview && trimPreview.mode === "trim-start"
                  ? trimPreview.nextStartSec - trimPreview.origStartSec
                  : 0;
              const trimDeltaEnd =
                trimPreview && trimPreview.mode === "trim-end"
                  ? trimPreview.nextEndSec - trimPreview.origEndSec
                  : 0;

              return segments.map((seg, idx) => {
              const activeTrim = trimPreview?.sceneId === seg.sceneId ? trimPreview : null;
              let liveCutStart = seg.cutStart;
              let liveCutEnd = seg.cutEnd;
              if (trimIdx >= 0) {
                if (idx === trimIdx) {
                  liveCutStart += trimDeltaStart;
                  liveCutEnd += trimDeltaEnd;
                } else if (trimPreview?.mode === "trim-start" && idx < trimIdx) {
                  liveCutStart += trimDeltaStart;
                  liveCutEnd += trimDeltaStart;
                } else if (trimPreview?.mode === "trim-end" && idx > trimIdx) {
                  liveCutStart += trimDeltaEnd;
                  liveCutEnd += trimDeltaEnd;
                }
              }
              const leftPx = liveCutStart * pxPerSec;
              const rightPx = liveCutEnd * pxPerSec;
              const widthPx = Math.max(2, rightPx - leftPx);
              const displayDur = activeTrim
                ? Math.max(0.1, activeTrim.nextEndSec - activeTrim.nextStartSec)
                : seg.clipDur;
              const isSelected = seg.sceneId === activeSceneId;

              const { aspect: segAspect, frames: segFrames } = getClipThumbInfo(seg);
              const naturalTileW = Math.max(36, Math.min(114, Math.round(64 * segAspect)));
              const rawTileCount = Math.max(1, Math.ceil(widthPx / naturalTileW));
              const useExactTileW = rawTileCount <= 64;
              const slotCount = useExactTileW ? rawTileCount : 64;

              const clipThumbs =
                seg.scene.mediaType === "image" && seg.scene.mediaUrl
                  ? Array.from({ length: slotCount }, () => seg.scene.mediaUrl!)
                  : segFrames.length > 0
                    ? Array.from({ length: slotCount }, (_, slotIdx) => {
                        const effectiveStart = activeTrim ? activeTrim.nextStartSec : seg.startSec;
                        const slotFrac = useExactTileW
                          ? Math.min(1, ((slotIdx + 0.5) * naturalTileW) / Math.max(1, widthPx))
                          : (slotIdx + 0.5) / slotCount;
                        const sampleSourceSec = effectiveStart + slotFrac * displayDur;

                        // Pick nearest captured thumbnail frame by source timestamp
                        let best = segFrames[0];
                        let bestDiff = Math.abs(best.sourceSec - sampleSourceSec);
                        for (let k = 1; k < segFrames.length; k++) {
                          const diff = Math.abs(segFrames[k].sourceSec - sampleSourceSec);
                          if (diff < bestDiff) {
                            best = segFrames[k];
                            bestDiff = diff;
                          } else if (segFrames[k].sourceSec > sampleSourceSec) {
                            break;
                          }
                        }
                        return best.url;
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
                    if (e.button === 0 || e.pointerType !== "mouse") {
                      scheduleClipLongPress(seg.sceneId, idx, e.pointerId, e.clientX, e.clientY);
                    }
                  }}
                  className={`absolute inset-y-0 rounded-md transition-shadow cursor-pointer ${
                    activeTrim
                      ? "z-30 shadow-lg"
                      : isSelected
                        ? "z-20 shadow-md"
                        : "z-0 ring-1 ring-black/20 dark:ring-white/15 hover:ring-teal-500/60"
                  }`}
                >
                  {/* Clipped Inner Media + Label Layer (keeps outside trim handles unclipped) */}
                  <div
                    className={`absolute inset-0 overflow-hidden ${
                      isSelected ? "rounded-none" : "rounded-md"
                    }`}
                  >
                    {/* Clip Filmstrip Frames */}
                    <div className="absolute inset-0 bg-neutral-950 flex overflow-hidden">
                      {clipThumbs.length > 0 ? (
                        clipThumbs.map((src, tIdx) => (
                          <img
                            key={tIdx}
                            src={src}
                            alt=""
                            draggable={false}
                            referrerPolicy="no-referrer"
                            style={useExactTileW ? { width: `${naturalTileW}px` } : undefined}
                            className={`h-full object-cover border-r border-black/30 last:border-r-0 pointer-events-none ${
                              useExactTileW ? "shrink-0" : "flex-1 min-w-0"
                            }`}
                          />
                        ))
                      ) : (
                        <div className="w-full h-full bg-gradient-to-r from-neutral-900 via-neutral-800 to-neutral-900 animate-pulse" />
                      )}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/20"
                      />
                    </div>

                    {/* Subtle Label Inside Clip */}
                    {widthPx >= 24 && (
                      <div className="pointer-events-none relative pt-1 px-1.5 flex items-center justify-between text-[10px] font-mono-tabular font-semibold text-white">
                        <span className="px-1 py-0.5 rounded bg-black/75 border border-white/10 backdrop-blur-xs truncate">
                          {widthPx >= 56 ? `#${idx + 1} · ${roundTenth(displayDur)}s` : `#${idx + 1}`}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* External Oversized Trim Handles & Seamless Bracket Selection Frame */}
                  {isSelected && (
                    <>
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -top-[2px] left-0 right-0 h-[2.5px] bg-teal-600 dark:bg-teal-400 z-20"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-[2px] left-0 right-0 h-[2.5px] bg-teal-600 dark:bg-teal-400 z-20"
                      />
                      <div
                        role="slider"
                        aria-label={`Scene ${idx + 1} start handle`}
                        aria-valuemin={0}
                        aria-valuemax={seg.endSec}
                        aria-valuenow={seg.startSec}
                        onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-start", seg)}
                        className="absolute right-full -top-[2px] -bottom-[2px] w-6 rounded-l-lg bg-teal-600 hover:bg-teal-700 active:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] shadow-md flex items-center justify-center cursor-ew-resize touch-none z-30"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-y-1.5 -left-2.5 right-0"
                        />
                        <span className="pointer-events-none flex items-center gap-[3px]">
                          <span className="w-[2.5px] h-6 rounded-full bg-current opacity-95" />
                          <span className="w-[2.5px] h-6 rounded-full bg-current opacity-65" />
                        </span>
                      </div>
                      <div
                        role="slider"
                        aria-label={`Scene ${idx + 1} end handle`}
                        aria-valuemin={seg.startSec}
                        aria-valuemax={seg.maxSourceSec}
                        aria-valuenow={seg.endSec}
                        onPointerDown={(e) => handlePointerDownTrimHandle(e, "trim-end", seg)}
                        className="absolute left-full -top-[2px] -bottom-[2px] w-6 rounded-r-lg bg-teal-600 hover:bg-teal-700 active:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] shadow-md flex items-center justify-center cursor-ew-resize touch-none z-30"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-y-1.5 left-0 -right-2.5"
                        />
                        <span className="pointer-events-none flex items-center gap-[3px]">
                          <span className="w-[2.5px] h-6 rounded-full bg-current opacity-65" />
                          <span className="w-[2.5px] h-6 rounded-full bg-current opacity-95" />
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            });
            })()}
          </div>

          {/* Interactive Subtitles Track + Bottom AI Original Position Color Bars */}
          {hasVisibleSubTrack && (
          <div
            className={`relative h-12 mt-2 transition-opacity duration-150 ${
              clipReorder ? "opacity-35 pointer-events-none" : ""
            }`}
          >
            {/* Bottom Color Bar Strip Highlighting Original AI Subtitle Positions */}
            {(() => {
              const resolvedGuides =
                aiSubtitleGuides.length > 0
                  ? aiSubtitleGuides
                  : cutSpeechRegions.map((sr, srIdx) => ({
                      key: `sr-${srIdx}-${sr.cutStart.toFixed(2)}`,
                      subId: "",
                      subIdx: srIdx,
                      cutStart: sr.cutStart,
                      cutEnd: sr.cutEnd,
                      currentStart: sr.cutStart,
                      currentEnd: sr.cutEnd,
                    }));

              const guideItems = resolvedGuides.map((guide, gIdx) => {
                const nextGuide = resolvedGuides[gIdx + 1];
                const nextGuideStart =
                  nextGuide && nextGuide.cutStart >= guide.cutStart
                    ? nextGuide.cutStart
                    : undefined;
                const { leftPx, widthPx } = computeTimelineSpanPx(
                  guide.cutStart,
                  guide.cutEnd,
                  pxPerSec,
                  nextGuideStart
                );
                const isDraggingThis = Boolean(dragSubPreview && dragSubPreview.id === guide.subId);
                const liveStart = isDraggingThis ? dragSubPreview!.startTime : guide.currentStart;
                const liveEnd = isDraggingThis ? dragSubPreview!.endTime : guide.currentEnd;
                const isEdited =
                  Boolean(guide.subId) &&
                  (Math.abs(liveStart - guide.cutStart) > 0.05 ||
                    Math.abs(liveEnd - guide.cutEnd) > 0.05);
                const isThisSelected = Boolean(guide.subId) && guide.subId === activeSubId;
                const alignedLeft =
                  Boolean(dragSubPreview) &&
                  (Math.abs(dragSubPreview!.startTime - guide.cutStart) <= 0.12 ||
                    Math.abs(dragSubPreview!.endTime - guide.cutStart) <= 0.12);
                const alignedRight =
                  Boolean(dragSubPreview) &&
                  (Math.abs(dragSubPreview!.endTime - guide.cutEnd) <= 0.12 ||
                    Math.abs(dragSubPreview!.startTime - guide.cutEnd) <= 0.12);

                return {
                  guide,
                  leftPx,
                  widthPx,
                  isEdited,
                  isThisSelected,
                  alignedLeft,
                  alignedRight,
                };
              });

              return (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5">
                  {guideItems.map(
                    ({ guide, leftPx, widthPx, isEdited, isThisSelected, alignedLeft, alignedRight }) => (
                      <div
                        key={guide.key}
                        style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                        className={`absolute inset-y-0 rounded-full overflow-hidden transition-colors ${
                          isEdited
                            ? "bg-amber-500 dark:bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.55)]"
                            : isThisSelected || alignedLeft || alignedRight
                              ? "bg-amber-500/75 dark:bg-amber-400/75"
                              : "bg-amber-500/40 dark:bg-amber-400/38"
                        }`}
                      >
                        {alignedLeft && (
                          <div className="absolute inset-y-0 left-0 w-[3px] bg-emerald-500 dark:bg-emerald-300" />
                        )}
                        {alignedRight && (
                          <div className="absolute inset-y-0 right-0 w-[3px] bg-emerald-500 dark:bg-emerald-300" />
                        )}
                      </div>
                    )
                  )}
                </div>
              );
            })()}

            {/* Unmatched Speech Gap Quick-Fill Highlights */}
            {showFullSubTrack && onTranscribeRange &&
              unmatchedSpeechGaps.map((gap, gapIdx) => {
                const leftPx = gap.startSec * pxPerSec;
                const widthPx = Math.max(6, gap.durationSec * pxPerSec);
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
                    className={`absolute top-0 h-10 rounded-md border border-dashed flex items-center justify-center gap-1 ${
                      widthPx >= 20 ? "px-1.5" : "px-0"
                    } overflow-hidden transition-colors cursor-pointer z-[5] disabled:opacity-60 ${
                      isGapBusy
                        ? "border-teal-600 bg-teal-500/20 text-teal-800 dark:border-teal-400 dark:bg-teal-500/25 dark:text-teal-200"
                        : "border-amber-600/75 bg-amber-500/15 hover:bg-amber-500/28 text-amber-900 dark:border-amber-400/70 dark:bg-amber-500/15 dark:hover:bg-amber-500/25 dark:text-amber-200"
                    }`}
                  >
                    {widthPx >= 18 &&
                      (isGapBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      ) : (
                        <Sparkles className="w-3 h-3 shrink-0" />
                      ))}
                    {widthPx >= 52 && (
                      <span className="text-[10px] font-semibold truncate">
                        {isGapBusy ? "Filling…" : "AI Fill"}
                      </span>
                    )}
                  </button>
                );
              })}

            {/* Live Playhead-Aligned New Subtitle Marking Preview */}
            {newSubMarkStartSec !== null && (
              <>
                <div
                  ref={newSubPreviewBarRef}
                  style={{
                    left: `${newSubMarkStartSec * pxPerSec}px`,
                    width: "4px",
                  }}
                  className="pointer-events-none absolute top-0 h-10 rounded-md border-2 border-dashed border-emerald-600 dark:border-emerald-400 bg-emerald-500/22 dark:bg-emerald-400/20 flex items-center px-2 overflow-hidden z-[25]"
                >
                  <span className="text-[10px] font-semibold text-emerald-900 dark:text-emerald-200 truncate">
                    New Subtitle
                  </span>
                </div>
                <div
                  style={{ left: `${newSubMarkStartSec * pxPerSec}px` }}
                  className="pointer-events-none absolute -top-1 bottom-0.5 w-[2px] -translate-x-1/2 bg-emerald-600 dark:bg-emerald-400 z-[26]"
                >
                  <span className="absolute -top-0.5 left-1 px-1 py-[1px] rounded text-[9px] font-mono-tabular font-bold leading-none bg-emerald-600 dark:bg-emerald-400 text-white dark:text-[#052e16] shadow-sm whitespace-nowrap">
                    IN
                  </span>
                </div>
              </>
            )}

            {/* Upper Subtitle Clips Row */}
            {activeTimelineProject.subtitles.map((sub, subIdx) => {
              const preview = dragSubPreview?.id === sub.id ? dragSubPreview : null;
              const startTime = preview ? preview.startTime : sub.startTime;
              const endTime = preview ? preview.endTime : sub.endTime;
              const nextSub = activeTimelineProject.subtitles[subIdx + 1];
              const nextSubPreview =
                nextSub && dragSubPreview?.id === nextSub.id ? dragSubPreview : null;
              const nextStart = nextSub
                ? nextSubPreview
                  ? nextSubPreview.startTime
                  : nextSub.startTime
                : undefined;
              const { leftPx, widthPx } = computeTimelineSpanPx(
                startTime,
                endTime,
                pxPerSec,
                nextStart
              );
              const isSelected = sub.id === activeSubId;
              const isAtPlayhead = cutTime >= startTime && cutTime <= endTime;
              const subDisplayText = (sub.burmese || sub.thaiPhonetic || "").trim();
              const isBlankSub = subDisplayText.length === 0;

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
                  title={`#${subIdx + 1} (${formatTimePrecise(startTime)} – ${formatTimePrecise(endTime)}): ${subDisplayText || "Empty subtitle"}`}
                  className={`absolute top-0 h-10 transition-shadow ${
                    preview
                      ? "z-30 shadow-lg cursor-grabbing touch-none"
                      : isSelected
                        ? "z-20 shadow-md cursor-grab active:cursor-grabbing touch-none"
                        : "z-[6] cursor-pointer"
                  }`}
                >
                  <div
                    className={`w-full h-full ${
                      widthPx >= 36 ? "px-2" : widthPx >= 14 ? "px-1" : "px-0"
                    } flex items-center overflow-hidden ${
                      isSelected
                        ? "rounded-none bg-[#1c3db8] dark:bg-[#264cd6] text-white"
                        : isBlankSub
                          ? isAtPlayhead
                            ? "rounded-md border border-dashed border-[#264cd6]/80 dark:border-[#4e7ef7]/80 bg-[#e6ecfc]/85 dark:bg-[#101c45]/85 text-[#142d87] dark:text-[#a8c3fa]"
                            : "rounded-md border border-dashed border-[#96a9d6] dark:border-[#3e4b85] bg-white/80 dark:bg-[#141933]/80 text-[#4d597d] dark:text-[#919ec4] hover:border-[#264cd6]/70"
                          : isAtPlayhead
                            ? "rounded-md bg-[#e6ecfc] dark:bg-[#101c45] text-[#142d87] dark:text-[#a8c3fa] ring-1 ring-inset ring-[#264cd6]/70 dark:ring-[#4e7ef7]/60"
                            : "rounded-md bg-white/95 dark:bg-[#141933]/95 text-[#0c1026] dark:text-[#f3f5fc] ring-1 ring-inset ring-[#bcc9e6] dark:ring-[#2f3866] hover:ring-[#264cd6]/60"
                    }`}
                  >
                    {widthPx >= 14 && (
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
                        {widthPx >= 36 && (
                          <span
                            className={`text-[11px] font-medium truncate ${
                              isBlankSub ? "italic opacity-65" : ""
                            }`}
                          >
                            {subDisplayText || "Empty"}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {isSelected && onUpdateSubtitleTiming && (
                    <>
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -top-[2px] left-0 right-0 h-[2.5px] bg-[#132b85] dark:bg-[#4e7ef7] z-20"
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-[2px] left-0 right-0 h-[2.5px] bg-[#132b85] dark:bg-[#4e7ef7] z-20"
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
                        className="absolute right-full -top-[2px] -bottom-[2px] w-5 rounded-l-md bg-[#132b85] hover:bg-[#1c3db8] dark:bg-[#4e7ef7] dark:hover:bg-[#7ca3fb] text-white dark:text-[#060918] shadow-md flex items-center justify-center cursor-ew-resize touch-none z-30"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-y-1.5 -left-2.5 right-0"
                        />
                        <span className="pointer-events-none flex items-center gap-[2.5px]">
                          <span className="w-[2px] h-4 rounded-full bg-current opacity-95" />
                          <span className="w-[2px] h-4 rounded-full bg-current opacity-65" />
                        </span>
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
                        className="absolute left-full -top-[2px] -bottom-[2px] w-5 rounded-r-md bg-[#132b85] hover:bg-[#1c3db8] dark:bg-[#4e7ef7] dark:hover:bg-[#7ca3fb] text-white dark:text-[#060918] shadow-md flex items-center justify-center cursor-ew-resize touch-none z-30"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-y-1.5 left-0 -right-2.5"
                        />
                        <span className="pointer-events-none flex items-center gap-[2.5px]">
                          <span className="w-[2px] h-4 rounded-full bg-current opacity-65" />
                          <span className="w-[2px] h-4 rounded-full bg-current opacity-95" />
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* Inline Seam Merge Buttons Between Selected Subtitle & Adjacent Prev/Next Clips */}
            {selectedSubtitleItem &&
              onMergeSubtitleWithNext &&
              !dragSubPreview &&
              !clipReorder &&
              (prevAdjacentSub || nextAdjacentSub) &&
              (() => {
                const curStartPx = selectedSubtitleItem.startTime * pxPerSec;
                const curEndPx = (
                  nextAdjacentSub
                    ? Math.min(selectedSubtitleItem.endTime, nextAdjacentSub.startTime)
                    : selectedSubtitleItem.endTime
                ) * pxPerSec;

                const prevEndPx = prevAdjacentSub
                  ? Math.min(prevAdjacentSub.endTime, selectedSubtitleItem.startTime) * pxPerSec
                  : null;
                const nextStartPx = nextAdjacentSub
                  ? nextAdjacentSub.startTime * pxPerSec
                  : null;

                let leftSeamX = prevEndPx !== null ? (prevEndPx + curStartPx) / 2 : null;
                let rightSeamX = nextStartPx !== null ? (curEndPx + nextStartPx) / 2 : null;

                // Prevent seam buttons from overlapping on very narrow subtitle clips
                const minButtonGapPx = 42;
                if (
                  leftSeamX !== null &&
                  rightSeamX !== null &&
                  rightSeamX - leftSeamX < minButtonGapPx
                ) {
                  const mid = (leftSeamX + rightSeamX) / 2;
                  leftSeamX = mid - minButtonGapPx / 2;
                  rightSeamX = mid + minButtonGapPx / 2;
                }

                const leftGapWidth =
                  prevEndPx !== null ? Math.max(0, curStartPx - prevEndPx) : 0;
                const rightGapWidth =
                  nextStartPx !== null ? Math.max(0, nextStartPx - curEndPx) : 0;

                return (
                  <>
                    {/* Optional subtle dashed gap bridge lines connecting adjacent clips */}
                    {prevAdjacentSub && prevEndPx !== null && leftGapWidth >= 6 && (
                      <div
                        aria-hidden="true"
                        style={{ left: `${prevEndPx}px`, width: `${leftGapWidth}px` }}
                        className="pointer-events-none absolute top-[20px] h-[2px] border-t-2 border-dashed border-[#4e7ef7]/60 dark:border-[#7ca3fb]/60 z-10"
                      />
                    )}
                    {nextAdjacentSub && nextStartPx !== null && rightGapWidth >= 6 && (
                      <div
                        aria-hidden="true"
                        style={{ left: `${curEndPx}px`, width: `${rightGapWidth}px` }}
                        className="pointer-events-none absolute top-[20px] h-[2px] border-t-2 border-dashed border-[#4e7ef7]/60 dark:border-[#7ca3fb]/60 z-10"
                      />
                    )}

                    {/* Left Seam Merge Button (Prev + Current) */}
                    {prevAdjacentSub && leftSeamX !== null && (
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.currentTarget.blur();
                          handleMergeSelectedSubtitle("prev");
                        }}
                        style={{ left: `${leftSeamX}px` }}
                        title={`Merge S${selectedSubtitleIndex} + S${selectedSubtitleIndex + 1}`}
                        aria-label={`Merge subtitle ${selectedSubtitleIndex} and ${selectedSubtitleIndex + 1}`}
                        className="group absolute top-[45px] -translate-x-1/2 z-30 h-6 px-2 rounded-full border border-[#4e7ef7]/80 dark:border-[#608ef9]/80 bg-white/95 dark:bg-[#11193a]/95 text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#1c3db8] hover:text-white dark:hover:bg-[#4e7ef7] dark:hover:text-[#060918] shadow-[0_3px_10px_rgba(14,26,74,0.22)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.55)] inline-flex items-center justify-center gap-1 active:scale-95 cursor-pointer transition-colors"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-1.5 rounded-full"
                        />
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -top-[7px] left-1/2 -translate-x-1/2 w-[1.5px] h-[7px] bg-[#4e7ef7]/75 dark:bg-[#608ef9]/75"
                        />
                        <Link2 className="w-3 h-3 shrink-0" />
                      </button>
                    )}

                    {/* Right Seam Merge Button (Current + Next) */}
                    {nextAdjacentSub && rightSeamX !== null && (
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.currentTarget.blur();
                          handleMergeSelectedSubtitle("next");
                        }}
                        style={{ left: `${rightSeamX}px` }}
                        title={`Merge S${selectedSubtitleIndex + 1} + S${selectedSubtitleIndex + 2}`}
                        aria-label={`Merge subtitle ${selectedSubtitleIndex + 1} and ${selectedSubtitleIndex + 2}`}
                        className="group absolute top-[45px] -translate-x-1/2 z-30 h-6 px-2 rounded-full border border-[#4e7ef7]/80 dark:border-[#608ef9]/80 bg-white/95 dark:bg-[#11193a]/95 text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#1c3db8] hover:text-white dark:hover:bg-[#4e7ef7] dark:hover:text-[#060918] shadow-[0_3px_10px_rgba(14,26,74,0.22)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.55)] inline-flex items-center justify-center gap-1 active:scale-95 cursor-pointer transition-colors"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -inset-1.5 rounded-full"
                        />
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -top-[7px] left-1/2 -translate-x-1/2 w-[1.5px] h-[7px] bg-[#4e7ef7]/75 dark:bg-[#608ef9]/75"
                        />
                        <Link2 className="w-3 h-3 shrink-0" />
                      </button>
                    )}
                  </>
                );
              })()}
          </div>
          )}

          {/* Dedicated Open Scroll Space Below Clips & Subtitles */}
          <div
            aria-hidden="true"
            className="h-8 mt-3 border-t border-dashed border-[#bcc9e6]/70 dark:border-[#21284c]/80"
          />
            </div>
          </div>
        </div>

        {/* Floating Add Video/Image Clip Button Pinned at Far-Right Edge of Video Track Row */}
        {onAddMediaClip && (
          <input
            ref={addMediaInputRef}
            type="file"
            accept="video/*,image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                onAddMediaClip(files);
              }
              e.currentTarget.value = "";
            }}
          />
        )}
        {onAddMediaClip && !clipReorder && segments.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-6 bottom-0 overflow-hidden z-[25]">
            <div
              style={{ top: `${trackTopBufferPx - trackScrollTop}px` }}
              className="pointer-events-none absolute right-2.5 h-16 flex items-center"
            >
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.blur();
                  addMediaInputRef.current?.click();
                }}
                title="Add Video or Image Clip"
                aria-label="Add Video or Image Clip"
                className="pointer-events-auto w-9 h-9 rounded-xl bg-white hover:bg-[#f3f5fc] active:scale-95 text-[#0c1026] border border-black/10 dark:border-white/20 shadow-[0_4px_14px_rgba(0,0,0,0.34)] flex items-center justify-center cursor-pointer transition-transform transition-colors"
              >
                <Plus className="w-5 h-5 stroke-[2.5]" />
              </button>
            </div>
          </div>
        )}

        {/* Fixed Center Playhead Line */}
        {!clipReorder && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center ${
              segments.length > 0 ? "bottom-14" : "bottom-0"
            }`}
          >
            <div className="w-3 h-3 rounded-b-sm bg-teal-700 dark:bg-teal-400 shadow-sm" />
            <div className="w-[2px] flex-1 bg-teal-700 dark:bg-teal-400 shadow-[0_0_5px_rgba(28,61,184,0.38)]" />
          </div>
        )}

        {/* Live Trim Timestamp Badge */}
        {dragBadge && !clipReorder && (
          <div className="pointer-events-none absolute top-2 right-2.5 z-30 px-2 py-0.5 rounded bg-[#070814]/90 text-white text-[11px] font-mono-tabular shadow">
            {dragBadge.label}: {formatTimePrecise(dragBadge.sec)}
          </div>
        )}

        {/* Brief Reorder Hint (when long-pressing with only 1 clip) */}
        {reorderHint && !clipReorder && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2.5 py-1 rounded-md bg-[#0c1026]/92 dark:bg-[#141933]/95 border border-white/15 text-white text-[11px] font-medium shadow-md whitespace-nowrap">
            {reorderHint}
          </div>
        )}

        {/* In-Place Minimized Clip Reorder Strip (stays in the exact Video Clips row: top-8 h-16) */}
        {clipReorder && (() => {
          const draggedSeg = segments[clipReorder.fromIndex] ?? null;
          const getMidThumb = (seg: ClipSegment): string | null => {
            if (seg.scene.mediaType === "image" && seg.scene.mediaUrl) {
              return seg.scene.mediaUrl;
            }
            const { frames: segFrames } = getClipThumbInfo(seg);
            if (segFrames.length === 0) return null;
            const midSec = (seg.startSec + seg.endSec) / 2;
            let best = segFrames[0];
            let bestDiff = Math.abs(best.sourceSec - midSec);
            for (let k = 1; k < segFrames.length; k++) {
              const diff = Math.abs(segFrames[k].sourceSec - midSec);
              if (diff < bestDiff) {
                best = segFrames[k];
                bestDiff = diff;
              } else if (segFrames[k].sourceSec > midSec) {
                break;
              }
            }
            return best.url;
          };

          const draggedThumb = draggedSeg ? getMidThumb(draggedSeg) : null;

          return (
            <>
              {/* Compact Reorder Status Inside Top Ruler Bar */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-6 z-40 px-2.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95 flex items-center justify-between gap-2 text-[10px]">
                <div className="flex items-center gap-1.5 min-w-0">
                  <GripHorizontal className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
                  <span className="font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate">
                    Reorder Clips
                  </span>
                  <span className="font-mono-tabular font-semibold text-teal-700 dark:text-teal-400 shrink-0">
                    {clipReorder.fromIndex === clipReorder.toIndex
                      ? `#${clipReorder.fromIndex + 1}`
                      : `#${clipReorder.fromIndex + 1} → #${clipReorder.toIndex + 1}`}
                  </span>
                </div>
                <span className="text-[#4d597d] dark:text-[#919ec4] shrink-0">
                  Drag &amp; release
                </span>
              </div>

              {/* Minimized Horizontal Clip Cards Directly Inside Original Video Clips Row */}
              <div
                style={{
                  top: `${Math.max(
                    24,
                    24 + trackTopBufferPx - (tracksScrollRef.current?.scrollTop ?? initialTrackScrollTop)
                  )}px`,
                }}
                className="absolute inset-x-0 h-16 z-40 flex items-center"
              >
                <div
                  ref={reorderStripRef}
                  className="w-full h-full overflow-x-auto no-scrollbar flex items-center"
                >
                  <div
                    ref={reorderTrackRef}
                    style={{
                      paddingLeft: `${REORDER_STRIP_PAD}px`,
                      paddingRight: `${REORDER_STRIP_PAD}px`,
                      gap: `${REORDER_TILE_GAP}px`,
                    }}
                    className="relative flex items-center mx-auto shrink-0"
                  >
                    {/* Animated Target Drop Slot Outline */}
                    <div
                      aria-hidden="true"
                      style={{
                        left: `${REORDER_STRIP_PAD}px`,
                        width: `${REORDER_TILE_W}px`,
                        height: `${REORDER_TILE_H}px`,
                        transform: `translate3d(${clipReorder.toIndex * REORDER_TILE_STRIDE}px, 0, 0)`,
                      }}
                      className="pointer-events-none absolute top-0 rounded-lg border-2 border-dashed border-teal-600/85 dark:border-teal-400/85 bg-teal-600/12 dark:bg-teal-400/12 transition-transform duration-150 ease-out"
                    />

                    {/* Minimized Sibling Clip Tiles */}
                    {segments.map((seg, origIdx) => {
                      const isDraggedOrig = origIdx === clipReorder.fromIndex;
                      let shiftPx = 0;
                      if (!isDraggedOrig) {
                        if (
                          clipReorder.fromIndex < clipReorder.toIndex &&
                          origIdx > clipReorder.fromIndex &&
                          origIdx <= clipReorder.toIndex
                        ) {
                          shiftPx = -REORDER_TILE_STRIDE;
                        } else if (
                          clipReorder.fromIndex > clipReorder.toIndex &&
                          origIdx >= clipReorder.toIndex &&
                          origIdx < clipReorder.fromIndex
                        ) {
                          shiftPx = REORDER_TILE_STRIDE;
                        }
                      }

                      const tileThumb = !isDraggedOrig ? getMidThumb(seg) : null;

                      return (
                        <div
                          key={seg.sceneId}
                          style={{
                            width: `${REORDER_TILE_W}px`,
                            height: `${REORDER_TILE_H}px`,
                            transform: `translate3d(${shiftPx}px, 0, 0)`,
                          }}
                          className={`relative rounded-lg overflow-hidden shrink-0 transition-transform duration-150 ease-out ${
                            isDraggedOrig
                              ? "opacity-0 pointer-events-none"
                              : "bg-neutral-950 ring-1 ring-black/25 dark:ring-white/20 shadow-xs"
                          }`}
                        >
                          {!isDraggedOrig && (
                            <>
                              {tileThumb ? (
                                <img
                                  src={tileThumb}
                                  alt=""
                                  draggable={false}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover pointer-events-none"
                                />
                              ) : (
                                <div className="w-full h-full bg-gradient-to-br from-neutral-800 to-neutral-950" />
                              )}
                              <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/65"
                              />
                              <span className="pointer-events-none absolute top-1 left-1 px-1 py-0.5 rounded bg-black/75 text-white text-[9px] font-mono-tabular font-bold leading-none">
                                #{origIdx + 1}
                              </span>
                              <span className="pointer-events-none absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/75 text-white/90 text-[9px] font-mono-tabular leading-none">
                                {roundTenth(seg.clipDur)}s
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Floating Lifted Clip Tile Tracking the Pointer */}
                {draggedSeg && (
                  <div
                    style={{
                      width: `${REORDER_TILE_W}px`,
                      height: `${REORDER_TILE_H}px`,
                      transform: `translate3d(${clipReorder.pointerLocalX - REORDER_TILE_W / 2}px, -54%, 0) scale(1.08)`,
                    }}
                    className="pointer-events-none absolute left-0 top-1/2 z-30 rounded-lg overflow-hidden bg-neutral-950 ring-2 ring-teal-600 dark:ring-teal-400 shadow-xl shadow-black/45"
                  >
                    {draggedThumb ? (
                      <img
                        src={draggedThumb}
                        alt=""
                        draggable={false}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-neutral-800 to-neutral-950" />
                    )}
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70"
                    />
                    <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-teal-600 dark:bg-teal-400 text-white dark:text-[#060918] text-[9px] font-mono-tabular font-bold leading-none shadow-xs">
                      #{clipReorder.fromIndex + 1}
                    </span>
                    <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/80 text-white text-[9px] font-mono-tabular font-semibold leading-none">
                      {roundTenth(draggedSeg.clipDur)}s
                    </span>
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {/* Empty Clips Recovery Overlay when all clips were deleted */}
        {segments.length === 0 && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[#e7ecf8]/95 dark:bg-[#050712]/95 px-4 text-center">
            <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
              All clips were deleted. Restore the original clips to keep editing.
            </p>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleRestoreOriginal}
              className="h-7 px-3 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Original Clips</span>
            </button>
          </div>
        )}

      </div>

      {/* Floating Direction Chooser Above Toolbar When Selected Subtitle Has Both Prev & Next Neighbors */}
      {showMergeChoice &&
        selectedSubtitleItem &&
        prevAdjacentSub &&
        nextAdjacentSub &&
        !clipReorder &&
        segments.length > 0 && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="pointer-events-none absolute inset-x-0 bottom-[60px] z-40 flex justify-center px-2.5"
          >
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleMergeSelectedSubtitle("prev");
                }}
                title={`Merge with previous subtitle S${selectedSubtitleIndex}`}
                className="h-8 px-3 rounded-lg border border-[#4e7ef7]/65 dark:border-[#4e7ef7]/65 bg-white/95 dark:bg-[#10183a]/95 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.16)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.5)] inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#e6ecfc] dark:hover:bg-[#1c295c] active:scale-95 cursor-pointer transition-colors whitespace-nowrap"
              >
                <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                <span>Merge S{selectedSubtitleIndex}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleMergeSelectedSubtitle("next");
                }}
                title={`Merge with next subtitle S${selectedSubtitleIndex + 2}`}
                className="h-8 px-3 rounded-lg border border-[#4e7ef7]/65 dark:border-[#4e7ef7]/65 bg-white/95 dark:bg-[#10183a]/95 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.16)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.5)] inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#e6ecfc] dark:hover:bg-[#1c295c] active:scale-95 cursor-pointer transition-colors whitespace-nowrap"
              >
                <span>Merge S{selectedSubtitleIndex + 2}</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0" />
              </button>
            </div>
          </div>
        )}

      {/* Floating Contextual Individual Bottom Editing Tool Buttons */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-2.5 transition-opacity duration-150 ${
          clipReorder || segments.length === 0 ? "opacity-0" : "opacity-100"
        }`}
      >
        <div
          role="toolbar"
          aria-label="Timeline editing tools"
          onPointerDown={(e) => e.stopPropagation()}
          className={`max-w-full flex items-center gap-2 px-1 py-1 overflow-x-auto no-scrollbar touch-pan-x ${
            clipReorder || segments.length === 0 ? "pointer-events-none" : "pointer-events-auto"
          }`}
        >
          {hasSelectedClip ? (
            <>
              {selectedSubtitleItem && onEditSubtitle && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    setShowMergeChoice(false);
                    onEditSubtitle(selectedSubtitleItem.id);
                  }}
                  title="Edit selected subtitle clip"
                  aria-label="Edit selected subtitle clip"
                  className="w-[96px] h-11 px-1.5 rounded-xl border border-[#5d82f0]/55 dark:border-[#4e7ef7]/55 bg-[#e6ecfc]/95 dark:bg-[#1a2554]/95 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#d7e2fc] dark:hover:bg-[#22306b] active:scale-95 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                    Edit
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  setShowMergeChoice(false);
                  handleSplitSelectedClip();
                }}
                disabled={!canSplitSelectedClip}
                title={
                  selectedSubtitleItem
                    ? "Split selected subtitle clip"
                    : "Split selected video clip at center playhead"
                }
                aria-label={
                  selectedSubtitleItem
                    ? "Split selected subtitle clip"
                    : "Split selected video clip at center playhead"
                }
                className="w-[96px] h-11 px-1.5 rounded-xl border border-teal-600/35 dark:border-teal-400/35 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-teal-700 dark:text-teal-300 hover:bg-teal-50/95 dark:hover:bg-[#112438] hover:border-teal-600/60 dark:hover:border-teal-400/60 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <Scissors className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                  Split
                </span>
              </button>

              {selectedSubtitleItem && onMergeSubtitleWithNext && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    handleToolbarMergeClick();
                  }}
                  disabled={!canMergeSelectedSubtitle}
                  aria-expanded={showMergeChoice}
                  title={
                    prevAdjacentSub && nextAdjacentSub
                      ? "Merge with previous or next subtitle clip"
                      : nextAdjacentSub
                        ? `Merge with S${selectedSubtitleIndex + 2}`
                        : prevAdjacentSub
                          ? `Merge with S${selectedSubtitleIndex}`
                          : "No adjacent subtitle clip to merge"
                  }
                  aria-label="Merge adjacent subtitle clip"
                  className={`w-[96px] h-11 px-1.5 rounded-xl border backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500 ${
                    showMergeChoice
                      ? "border-[#1c3db8] dark:border-[#4e7ef7] bg-[#1c3db8] dark:bg-[#4e7ef7] text-white dark:text-[#060918]"
                      : "border-[#5d82f0]/45 dark:border-[#4e7ef7]/45 bg-white/92 dark:bg-[#0d1126]/92 text-[#1c3db8] dark:text-[#93b5fa] hover:bg-[#e6ecfc]/95 dark:hover:bg-[#1a2554]/95 hover:border-[#4e7ef7]/75"
                  }`}
                >
                  <Merge className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                    Merge
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  setShowMergeChoice(false);
                  handleDeleteSelectedClip();
                }}
                disabled={!canDeleteSelectedClip}
                title={
                  selectedSubtitleItem
                    ? "Delete selected subtitle clip"
                    : "Delete selected video clip"
                }
                aria-label={
                  selectedSubtitleItem
                    ? "Delete selected subtitle clip"
                    : "Delete selected video clip"
                }
                className="w-[96px] h-11 px-1.5 rounded-xl border border-[#c6d2ec]/90 dark:border-[#2a3466]/90 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-[#2a3559] dark:text-[#dce4fb] hover:bg-red-50/95 dark:hover:bg-[#2a1424] hover:border-red-400/60 dark:hover:border-red-500/60 hover:text-red-600 dark:hover:text-red-400 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <Trash2 className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                  Delete
                </span>
              </button>
            </>
          ) : newSubMarkStartSec !== null ? (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleMarkNewSubStart();
                }}
                title="Re-mark start time at current playhead"
                aria-label="Re-mark subtitle start time at current playhead"
                className="w-[96px] h-11 px-1.5 rounded-xl border border-emerald-600/45 dark:border-emerald-400/45 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50/95 dark:hover:bg-[#0f2924] active:scale-95 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500"
              >
                <Flag className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-mono-tabular font-semibold leading-none truncate max-w-full">
                  Start {formatTimePrecise(newSubMarkStartSec)}
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleCommitNewSubEnd();
                }}
                title="Set end time at current playhead and add empty subtitle"
                aria-label="Set subtitle end time at current playhead"
                className="w-[96px] h-11 px-1.5 rounded-xl border border-emerald-600 dark:border-emerald-400 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#052e16] backdrop-blur-md shadow-[0_4px_14px_rgba(16,185,129,0.28)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap active:scale-95 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-emerald-400"
              >
                <Check className="w-4 h-4 shrink-0" />
                <span
                  ref={newSubEndDurRef}
                  className="text-[10px] font-mono-tabular font-semibold leading-none truncate max-w-full"
                >
                  Set End
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleCancelNewSubMark();
                }}
                title="Cancel adding subtitle"
                aria-label="Cancel adding subtitle"
                className="w-[96px] h-11 px-1.5 rounded-xl border border-[#c6d2ec]/90 dark:border-[#2a3466]/90 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-[#4d597d] dark:text-[#919ec4] hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50/95 dark:hover:bg-[#2a1424] hover:border-red-400/60 dark:hover:border-red-500/60 active:scale-95 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <X className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                  Cancel
                </span>
              </button>
            </>
          ) : (
            <>
              {onAddSubtitle && (
                <button
                  type="button"
                  disabled={segments.length === 0}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    handleMarkNewSubStart();
                  }}
                  title="Mark start at playhead to add an empty subtitle"
                  aria-label="Add subtitle at playhead"
                  className="w-[96px] h-11 px-1.5 rounded-xl border border-emerald-600/45 dark:border-emerald-400/45 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50/95 dark:hover:bg-[#0f2924] hover:border-emerald-600/70 dark:hover:border-emerald-400/70 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500"
                >
                  <Plus className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                    Add Subtitle
                  </span>
                </button>
              )}

              {onOpenPasteTranscript && (
                <button
                  type="button"
                  disabled={segments.length === 0}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onOpenPasteTranscript();
                  }}
                  title="Paste formatted transcript to add subtitles"
                  aria-label="Paste structured transcript to add subtitles"
                  className="w-[96px] h-11 px-1.5 rounded-xl border border-teal-600/45 dark:border-teal-400/45 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-teal-700 dark:text-teal-300 hover:bg-teal-50/95 dark:hover:bg-[#0f2433] hover:border-teal-600/70 dark:hover:border-teal-400/70 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  <ClipboardPaste className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                    Paste Transcript
                  </span>
                </button>
              )}

              {onClearAllSubtitles && (
                <button
                  type="button"
                  disabled={segments.length === 0 || activeTimelineProject.subtitles.length === 0}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onClearAllSubtitles();
                  }}
                  title={
                    activeTimelineProject.subtitles.length > 0
                      ? "Clear all subtitles"
                      : "No subtitles to clear"
                  }
                  aria-label="Clear all subtitles"
                  className="w-[96px] h-11 px-1.5 rounded-xl border border-[#c6d2ec]/90 dark:border-[#2a3466]/90 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-[#2a3559] dark:text-[#dce4fb] hover:bg-red-50/95 dark:hover:bg-[#2a1424] hover:border-red-400/60 dark:hover:border-red-500/60 hover:text-red-600 dark:hover:text-red-400 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  <Eraser className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                    Clear All
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  handleRestoreOriginal();
                }}
                title="Reset timeline edits"
                aria-label="Reset timeline edits"
                className="w-[96px] h-11 px-1.5 rounded-xl border border-[#c6d2ec]/90 dark:border-[#2a3466]/90 bg-white/92 dark:bg-[#0d1126]/92 backdrop-blur-md shadow-[0_4px_14px_rgba(10,16,40,0.12)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)] flex flex-col items-center justify-center gap-1 shrink-0 whitespace-nowrap text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#eef2fc] dark:hover:bg-[#171f42] hover:border-[#9eb1de] dark:hover:border-[#3e4e91] active:scale-95 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <RotateCcw className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                  Reset
                </span>
              </button>
            </>
          )}
        </div>
      </div>
      </div>
        );
      })()}
    </div>
  );
}
