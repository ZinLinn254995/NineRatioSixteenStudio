import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  BookOpen,
  Captions,
  Check,
  Clock,
  Copy,
  Download,
  FileText,
  Film,
  Loader2,
  LocateFixed,
  Merge,
  MessageSquarePlus,
  Mic,
  Palette,
  Plus,
  Redo2,
  RefreshCw,
  Repeat,
  Replace,
  RotateCcw,
  Scissors,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
  SpeakingScene,
  SubtitleFontScale,
  SubtitleGenerationProgress,
  SubtitleHighlightColor,
  SubtitleItem,
  SubtitleTheme,
  TranslationTone,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "../types";
import { ScenePicker } from "./ScenePicker";
import { YouTubePreviewPanel } from "./YouTubePreviewPanel";
import { VideoEditPanel, getVideoEditDirtyMap } from "./VideoEditPanel";
import { ProjectTimelineEditor } from "./ProjectTimelineEditor";
import { DEFAULT_STAGE_PREVIEW_SCALE, getCompactStageBounds } from "./Stage9x16";
import { SavedProjectsPanel } from "./SavedProjectsPanel";
import { DEFAULT_VOICE_SETTINGS, getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getSceneDurationSec } from "../utils/projectTimeline";
import { DEFAULT_VIDEO_EDIT } from "../utils/videoFilters";
import {
  buildSrtContent,
  buildStudyTextContent,
  buildVttContent,
  downloadTextFile,
  makeSafeFileSlug,
} from "../utils/exportSubtitles";

export type WorkspaceTab = "youtube" | "studio" | "projects";

export type StudioSectionId = "clips" | "captions" | "visual" | "audio" | "timeline";

interface WorkspaceSidebarProps {
  activeTab: WorkspaceTab;
  isWorkspaceVisible?: boolean;
  videos: YouTubeVideo[];
  selectedVideoId?: string;
  activeQuery: string;
  licenseFilter: YouTubeLicenseFilter;
  thaiOnly: boolean;
  hasMoreVideos: boolean;
  isLoadingMore: boolean;
  localMedia: ActiveMediaSource | null;
  youtubeMedia: ActiveMediaSource | null;
  selectedScenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  isSearching: boolean;
  isProcessing: boolean;
  generationProgress?: SubtitleGenerationProgress | null;
  clipSubtitleCounts?: Record<string, number>;
  regeneratingClipId?: string | null;
  regeneratingClipPercent?: number | null;
  isPlaying: boolean;
  timelineDirty: boolean;
  searchError: string | null;
  project: VideoProject | null;
  cutTime: number;
  subscribeCutTime?: (listener: (sec: number) => void) => () => void;
  savedProjects: SavedProjectRecord[];
  activeSavedId: string | null;
  canSaveCurrent: boolean;
  isLoadingSaved: boolean;
  isSavingProject: boolean;
  onSelectVideo: (video: YouTubeVideo) => void;
  onChangeLicenseFilter: (license: YouTubeLicenseFilter) => void;
  onToggleThaiOnly: () => void;
  onLoadMoreVideos: () => void;
  onResetToRecommended: () => void;
  onRefreshRecommended?: () => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes: (scenes: SceneSelection[]) => void;
  onDetectedLocalDuration: (dur: number) => void;
  onDetectedYouTubeDuration: (dur: number) => void;
  onGenerateSubtitles: () => void;
  onGenerateSingleClip?: (sceneId: string) => void;
  onCancelGenerateSubtitles?: () => void;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  onChangeEditSettings: (next: VideoEditSettings) => void;
  onUploadLocalVideo: (file: File) => void;
  onClearLocalVideo: () => void;
  onSeek: (sec: number) => void;
  onTogglePlay: () => void;
  onPause: () => void;
  onPlayFromTime: (sec: number) => void;
  onUpdateProjectScenes: (nextScenes: SpeakingScene[]) => void;
  onRestoreProjectSnapshot: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
  onResetTimeline: () => void;
  onUpdateSubtitle: (
    id: string,
    field: "thaiPhonetic" | "burmese" | "thaiScript",
    value: string
  ) => void;
  onUpdateWordGloss: (subId: string, wordIndex: number, burmeseGloss: string) => void;
  onFindReplaceSubtitles?: (opts: {
    findText: string;
    replaceText: string;
    field: "all" | "burmese" | "thaiPhonetic" | "thaiScript";
    caseSensitive?: boolean;
  }) => number;
  onAddSubtitle: (input: {
    startTime: number;
    endTime: number;
    thaiPhonetic: string;
    burmese: string;
    originalSpokenText?: string;
  }) => void;
  onDeleteSubtitle: (id: string) => void;
  onUpdateSubtitleTiming: (id: string, startTime: number, endTime: number) => void;
  onSplitSubtitle: (id: string) => void;
  onMergeSubtitleWithNext: (id: string) => void;
  onShiftAllSubtitles: (deltaSec: number) => void;
  loopingSubId?: string | null;
  onToggleLoopSubtitle: (id: string) => void;
  canUndoSubtitles?: boolean;
  canRedoSubtitles?: boolean;
  onUndoSubtitles?: () => void;
  onRedoSubtitles?: () => void;
  onAutoFixSubtitleTimings?: () => void;
  onAiResyncSubtitles?: () => void;
  onCancelAiResync?: () => void;
  isResyncingTimings?: boolean;
  onRegenerateSubtitle: (
    id: string,
    customHint?: string,
    toneOverride?: TranslationTone
  ) => void;
  onCancelRegenerateSubtitle?: (id: string) => void;
  onRetranslateAll: (tone: TranslationTone) => void;
  onCancelRetranslateAll?: () => void;
  regeneratingSubIds?: string[];
  isRetranslatingAll?: boolean;
  subtitleRegenError?: string | null;
  onClearSubtitleRegenError?: () => void;
  onSaveProject: (asNew?: boolean) => void;
  onOpenSavedProject: (record: SavedProjectRecord) => void;
  onRenameSavedProject: (id: string, title: string) => void;
  onDeleteSavedProject: (id: string) => void;
  onExportSavedJson: (record: SavedProjectRecord) => void;
  onImportSavedJson: (file: File) => void;
  onRelinkLocalVideo: (id: string, file: File) => void;
  ytPreviewSec?: number;
  ytSeekRequest?: { sec: number; nonce: number } | null;
  onYtCurrentSecChange?: (sec: number) => void;
  inlineStage?: ReactNode;
  isMobileStudio?: boolean;
  stagePreviewScale?: number;
  onChangeStagePreviewScale?: (scale: number) => void;
  searchInput: string;
  onChangeSearchInput: (value: string) => void;
  onSubmitSearch: () => void;
  onClearSearch: () => void;
  studioSection: StudioSectionId;
  onChangeStudioSection: (section: StudioSectionId) => void;
  showMobileTimelineTab?: boolean;
}

const SUBTITLE_TONE_OPTIONS: { id: TranslationTone; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "formal", label: "Polite" },
  { id: "dramatic", label: "Drama" },
  { id: "literal", label: "Literal" },
];

const QUICK_AI_HINTS = [
  { label: "Name / Slang", text: "Contain names or Thai slang — translate natural meaning accurately." },
  { label: "Natural Spoken", text: "Make the Burmese sound more natural and conversational." },
  { label: "Polite", text: "Use polite Burmese phrasing (ပါ/ခင်ဗျာ/ရှင့်)." },
  { label: "Concise", text: "Keep the Burmese translation shorter and punchier." },
];

function formatRangeSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function WorkspaceSidebar({
  activeTab,
  isWorkspaceVisible = true,
  videos,
  selectedVideoId,
  activeQuery,
  licenseFilter,
  thaiOnly,
  hasMoreVideos,
  isLoadingMore,
  localMedia,
  youtubeMedia,
  selectedScenes,
  voiceSettings,
  editSettings,
  isSearching,
  isProcessing,
  generationProgress = null,
  clipSubtitleCounts,
  regeneratingClipId = null,
  regeneratingClipPercent = null,
  isPlaying,
  timelineDirty,
  searchError,
  project,
  cutTime,
  subscribeCutTime,
  savedProjects,
  activeSavedId,
  canSaveCurrent,
  isLoadingSaved,
  isSavingProject,
  onSelectVideo,
  onChangeLicenseFilter,
  onToggleThaiOnly,
  onLoadMoreVideos,
  onResetToRecommended,
  onRefreshRecommended,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onDetectedLocalDuration,
  onDetectedYouTubeDuration,
  onGenerateSubtitles,
  onGenerateSingleClip,
  onCancelGenerateSubtitles,
  onChangeVoiceSettings,
  onChangeEditSettings,
  onUploadLocalVideo,
  onClearLocalVideo,
  onSeek,
  onTogglePlay,
  onPause,
  onPlayFromTime,
  onUpdateProjectScenes,
  onRestoreProjectSnapshot,
  onResetTimeline,
  onUpdateSubtitle,
  onUpdateWordGloss,
  onFindReplaceSubtitles,
  onAddSubtitle,
  onDeleteSubtitle,
  onUpdateSubtitleTiming,
  onSplitSubtitle,
  onMergeSubtitleWithNext,
  onShiftAllSubtitles,
  loopingSubId = null,
  onToggleLoopSubtitle,
  canUndoSubtitles = false,
  canRedoSubtitles = false,
  onUndoSubtitles,
  onRedoSubtitles,
  onAutoFixSubtitleTimings,
  onAiResyncSubtitles,
  onCancelAiResync,
  isResyncingTimings = false,
  onRegenerateSubtitle,
  onCancelRegenerateSubtitle,
  onRetranslateAll,
  onCancelRetranslateAll,
  regeneratingSubIds = [],
  isRetranslatingAll = false,
  subtitleRegenError = null,
  onClearSubtitleRegenError,
  onSaveProject,
  onOpenSavedProject,
  onRenameSavedProject,
  onDeleteSavedProject,
  onExportSavedJson,
  onImportSavedJson,
  onRelinkLocalVideo,
  ytPreviewSec = 0,
  ytSeekRequest,
  onYtCurrentSecChange,
  inlineStage,
  isMobileStudio = false,
  stagePreviewScale,
  onChangeStagePreviewScale,
  searchInput,
  onChangeSearchInput,
  onSubmitSearch,
  onClearSearch,
  studioSection,
  onChangeStudioSection,
  showMobileTimelineTab = false,
}: WorkspaceSidebarProps) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const mobileStageWrapperRef = useRef<HTMLDivElement | null>(null);
  const [mobileClipsStageEl, setMobileClipsStageEl] = useState<HTMLDivElement | null>(null);
  const [mobileStageWidth, setMobileStageWidth] = useState<number>(() =>
    typeof window !== "undefined"
      ? document.documentElement?.clientWidth || window.innerWidth
      : 390
  );
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerHeight : 800
  );
  const [localClipsScale, setLocalClipsScale] = useState<number>(DEFAULT_STAGE_PREVIEW_SCALE);
  const [isClipsResizing, setIsClipsResizing] = useState(false);
  const clipsDragStartRef = useRef<{
    startY: number;
    startScale: number;
    spanHeightPx: number;
    pointerId: number | null;
    source: "pointer" | "touch";
  } | null>(null);
  const clipsDragCleanupRef = useRef<(() => void) | null>(null);
  const onChangeStagePreviewScaleRef = useRef(onChangeStagePreviewScale);
  onChangeStagePreviewScaleRef.current = onChangeStagePreviewScale;
  const [showAddSub, setShowAddSub] = useState(false);
  const [newSubStart, setNewSubStart] = useState("0.0");
  const [newSubEnd, setNewSubEnd] = useState("2.5");
  const [newSubPhonetic, setNewSubPhonetic] = useState("");
  const [newSubBurmese, setNewSubBurmese] = useState("");
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [editStartVal, setEditStartVal] = useState("");
  const [editEndVal, setEditEndVal] = useState("");
  const [hintOpenId, setHintOpenId] = useState<string | null>(null);
  const [hintDrafts, setHintDrafts] = useState<Record<string, string>>({});
  const [editingWordsId, setEditingWordsId] = useState<string | null>(null);

  // Subtitle Search / Find-Replace, Style Customization & Multi-format Export
  const [showSubSearch, setShowSubSearch] = useState(false);
  const [subSearchQuery, setSubSearchQuery] = useState("");
  const [showReplaceRow, setShowReplaceRow] = useState(false);
  const [subReplaceText, setSubReplaceText] = useState("");
  const [subReplaceField, setSubReplaceField] = useState<
    "all" | "burmese" | "thaiPhonetic" | "thaiScript"
  >("all");
  const [replaceFeedback, setReplaceFeedback] = useState<string | null>(null);
  const [showSubStyle, setShowSubStyle] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const subCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!showExportMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [showExportMenu]);

  useEffect(() => {
    if (!replaceFeedback) return;
    const t = setTimeout(() => setReplaceFeedback(null), 2600);
    return () => clearTimeout(t);
  }, [replaceFeedback]);

  useEffect(() => {
    const updateViewport = () => {
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    const el = mobileStageWrapperRef.current;
    if (!el) return;
    const updateWidth = () => {
      if (el.clientWidth > 0) setMobileStageWidth(el.clientWidth);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobileStudio, activeTab]);

  useEffect(() => {
    return () => {
      clipsDragCleanupRef.current?.();
      clipsDragCleanupRef.current = null;
      clipsDragStartRef.current = null;
    };
  }, []);

  const effectiveClipsScale = stagePreviewScale ?? localClipsScale;
  const updateClipsScale = (next: number) => {
    setLocalClipsScale(next);
    onChangeStagePreviewScaleRef.current?.(next);
  };

  const compactBounds = getCompactStageBounds(
    mobileStageWidth > 0 ? mobileStageWidth : 390,
    viewportHeight
  );
  const clampedClipsScale = Math.max(0, Math.min(1, effectiveClipsScale));
  const clipsWidthPx = Math.round(
    compactBounds.minWidthPx + clampedClipsScale * compactBounds.spanWidthPx
  );
  const clipsHeightPx = Math.round(
    compactBounds.minHeightPx + clampedClipsScale * compactBounds.spanHeightPx
  );
  const isClipsFullWidth =
    clampedClipsScale >= 0.999 && compactBounds.maxWidthPx >= compactBounds.availWidth;
  const clipsSpanHeightPx = compactBounds.spanHeightPx;
  const clipsScaleLabel =
    clampedClipsScale < 0.28 ? "Small" : clampedClipsScale > 0.72 ? "Large" : "Normal";

  const applyClipsDragClientY = (clientY: number) => {
    const active = clipsDragStartRef.current;
    if (!active) return;
    const dy = clientY - active.startY;
    const nextScale = Math.max(0, Math.min(1, active.startScale + dy / active.spanHeightPx));
    updateClipsScale(Number(nextScale.toFixed(4)));
  };

  const endClipsDragResize = () => {
    clipsDragCleanupRef.current?.();
    clipsDragCleanupRef.current = null;
    if (!clipsDragStartRef.current) return;
    clipsDragStartRef.current = null;
    setIsClipsResizing(false);
  };

  const beginClipsDragSession = (
    startY: number,
    source: "pointer" | "touch",
    pointerId: number | null
  ) => {
    clipsDragCleanupRef.current?.();
    clipsDragStartRef.current = {
      startY,
      startScale: clampedClipsScale,
      spanHeightPx: clipsSpanHeightPx,
      pointerId,
      source,
    };
    setIsClipsResizing(true);

    const onWinPointerMove = (ev: PointerEvent) => {
      const active = clipsDragStartRef.current;
      if (!active || active.source !== "pointer") return;
      if (active.pointerId !== null && ev.pointerId !== active.pointerId) return;
      if (ev.cancelable) ev.preventDefault();
      applyClipsDragClientY(ev.clientY);
    };

    const onWinPointerEnd = (ev: PointerEvent) => {
      const active = clipsDragStartRef.current;
      if (!active || active.source !== "pointer") return;
      if (active.pointerId !== null && ev.pointerId !== active.pointerId) return;
      endClipsDragResize();
    };

    const onWinTouchMove = (ev: TouchEvent) => {
      const active = clipsDragStartRef.current;
      if (!active) return;
      if (ev.cancelable) ev.preventDefault();
      if (active.source === "touch" && ev.touches.length > 0) {
        applyClipsDragClientY(ev.touches[0].clientY);
      }
    };

    const onWinTouchEnd = () => {
      const active = clipsDragStartRef.current;
      if (!active) return;
      endClipsDragResize();
    };

    window.addEventListener("pointermove", onWinPointerMove, { passive: false });
    window.addEventListener("pointerup", onWinPointerEnd);
    window.addEventListener("pointercancel", onWinPointerEnd);
    window.addEventListener("touchmove", onWinTouchMove, { passive: false });
    window.addEventListener("touchend", onWinTouchEnd);
    window.addEventListener("touchcancel", onWinTouchEnd);

    clipsDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onWinPointerMove);
      window.removeEventListener("pointerup", onWinPointerEnd);
      window.removeEventListener("pointercancel", onWinPointerEnd);
      window.removeEventListener("touchmove", onWinTouchMove);
      window.removeEventListener("touchend", onWinTouchEnd);
      window.removeEventListener("touchcancel", onWinTouchEnd);
    };
  };

  const handleClipsDragPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }
    beginClipsDragSession(e.clientY, "pointer", e.pointerId);
  };

  const handleClipsDragTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (clipsDragStartRef.current) return;
    if (e.touches.length !== 1) return;
    beginClipsDragSession(e.touches[0].clientY, "touch", null);
  };

  const handleClipsDragDoubleClick = () => {
    updateClipsScale(clampedClipsScale >= 0.99 ? 0.5 : DEFAULT_STAGE_PREVIEW_SCALE);
  };

  const handleClipsDragKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      updateClipsScale(Math.max(0, Number((clampedClipsScale - 0.05).toFixed(2))));
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      updateClipsScale(Math.min(1, Number((clampedClipsScale + 0.05).toFixed(2))));
    } else if (e.key === "Home") {
      e.preventDefault();
      updateClipsScale(0);
    } else if (e.key === "End") {
      e.preventDefault();
      updateClipsScale(1);
    } else if (e.key === "0" || e.key === "Enter") {
      e.preventDefault();
      updateClipsScale(DEFAULT_STAGE_PREVIEW_SCALE);
    }
  };

  const jumpToActiveSubtitle = () => {
    if (!project || project.subtitles.length === 0) return;
    const target =
      findActiveSubtitle(project.subtitles, cutTime) ||
      project.subtitles.find((s) => s.startTime >= cutTime) ||
      project.subtitles[0];
    if (!target) return;
    const el = subCardRefs.current[target.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const openAddSubtitleForm = () => {
    if (!project) return;
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);
    const lastEnd =
      project.subtitles.length > 0
        ? project.subtitles[project.subtitles.length - 1].endTime
        : 0;
    const defaultStart =
      cutTime > 0.05
        ? Math.min(maxDur - 0.5, cutTime)
        : Math.min(maxDur - 0.5, lastEnd);
    const defaultEnd = Math.min(maxDur, Math.max(defaultStart + 0.5, defaultStart + 2.5));
    setNewSubStart(defaultStart.toFixed(1));
    setNewSubEnd(defaultEnd.toFixed(1));
    setNewSubPhonetic("");
    setNewSubBurmese("");
    setShowAddSub(true);
  };

  useEffect(() => {
    if (activeTab !== "youtube" || !hasMoreVideos || isSearching || isLoadingMore) return;
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onLoadMoreVideos();
        }
      },
      { root: scrollRootRef.current, rootMargin: "240px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, hasMoreVideos, isSearching, isLoadingMore, onLoadMoreVideos]);

  const handlePickYouTubeVideo = (video: YouTubeVideo) => {
    onSelectVideo(video);
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
      scrollRootRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const dirtyMap = getVideoEditDirtyMap(editSettings, voiceSettings);
  const studioTabs: {
    id: StudioSectionId;
    label: string;
    icon: typeof Captions;
    dirty?: boolean;
    count?: number;
  }[] = [
    {
      id: "clips",
      label: "Upload & Cut",
      icon: Upload,
      count: !project && selectedScenes.length > 0 ? selectedScenes.length : undefined,
    },
    {
      id: "captions",
      label: "Captions",
      icon: Captions,
      count: project?.subtitles.length,
    },
    ...(showMobileTimelineTab
      ? [{ id: "timeline" as const, label: "Timeline", icon: Scissors, dirty: timelineDirty }]
      : []),
    {
      id: "visual",
      label: "Video & Look",
      icon: SlidersHorizontal,
      dirty: dirtyMap.visualDirty,
    },
    {
      id: "audio",
      label: "Audio & Voice",
      icon: Mic,
      dirty: dirtyMap.audioDirty,
    },
  ];

  const hasStudioVideo = Boolean(localMedia || project);
  const isStudioView = activeTab === "studio";

  const studioHeaderDuration = project
    ? Math.round(
        project.targetDurationSec /
          getEffectivePlaybackSpeed(
            project.sourceType,
            editSettings.playbackSpeed,
            voiceSettings.speed
          )
      )
    : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Inline Stage directly on top in compact mobile/tablet Studio view */}
      {(inlineStage || isMobileStudio) && (
        <div
          ref={mobileStageWrapperRef}
          className={
            isStudioView
              ? "bg-[#e6e9ef] dark:bg-[#07080a] shrink-0"
              : "hidden"
          }
        >
          {inlineStage && (
            <div
              className={
                isMobileStudio && studioSection === "clips"
                  ? "hidden"
                  : "pt-2.5 w-full flex justify-center"
              }
            >
              {inlineStage}
            </div>
          )}
          {isMobileStudio && (
            <div
              className={
                studioSection === "clips"
                  ? "w-full flex flex-col items-center"
                  : "hidden"
              }
            >
              <div className="w-full px-2.5 pt-2.5 pb-2 flex justify-center">
                <div
                  ref={setMobileClipsStageEl}
                  style={{
                    width: isClipsFullWidth ? "100%" : `${clipsWidthPx}px`,
                    height: `${clipsHeightPx}px`,
                  }}
                  className={`max-w-full ${
                    isClipsResizing ? "transition-none" : "transition-[width,height] duration-150"
                  }`}
                />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Resize 16:9 preview (drag up to shrink, down to enlarge, double-click to toggle)"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clampedClipsScale * 100)}
                title="Drag up to shrink · Drag down to enlarge · Double-click to toggle size"
                onPointerDown={handleClipsDragPointerDown}
                onTouchStart={handleClipsDragTouchStart}
                onDoubleClick={handleClipsDragDoubleClick}
                onKeyDown={handleClipsDragKeyDown}
                className="relative group w-full h-6 shrink-0 flex items-center justify-center cursor-ns-resize touch-none select-none border-b border-[#dde2e9] dark:border-[#242a34] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400"
              >
                <span
                  className={`h-1 rounded-full transition-all ${
                    isClipsResizing
                      ? "w-16 bg-teal-700 dark:bg-teal-400"
                      : "w-10 bg-[#b8c2d0] dark:bg-[#323a48] group-hover:w-14 group-hover:bg-teal-700/80 dark:group-hover:bg-teal-400/80"
                  }`}
                />
                {isClipsResizing && (
                  <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#061412] text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm">
                    {clipsScaleLabel} · {Math.round(clampedClipsScale * 100)}%
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Non-Studio Views (Source, Projects) */}
      <div
        ref={scrollRootRef}
        className={
          isStudioView
            ? "hidden"
            : "flex-1 overflow-y-auto overscroll-y-contain studio-scrollbar min-h-0"
        }
      >
        <div
          className={
            activeTab === "youtube"
              ? "max-w-[1440px] mx-auto px-3 sm:px-5 py-3 space-y-3 pb-6"
              : "max-w-5xl mx-auto p-3 sm:p-5 lg:p-6 space-y-4 pb-8"
          }
        >
          {isProcessing && (
            <div className="px-3.5 py-2.5 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] flex items-center justify-between gap-3 text-xs sm:text-sm text-[#0e1217] dark:text-[#f1f3f5]">
              <div className="flex items-center gap-2.5 min-w-0">
                <Loader2 className="w-4 h-4 animate-spin text-teal-700 dark:text-teal-400 shrink-0" />
                <span className="truncate">Transcribing spoken dialogue in your selected clips...</span>
              </div>
              {onCancelGenerateSubtitles && (
                <button
                  type="button"
                  onClick={onCancelGenerateSubtitles}
                  className="h-7 px-2.5 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <Square className="w-2.5 h-2.5 fill-current" />
                  <span>Stop</span>
                </button>
              )}
            </div>
          )}

          {activeTab === "youtube" && (
            <div className="space-y-3">
              {/* Responsive Source Toolbar: Stacked 2-row on Mobile/Tablet, Single-row on Desktop */}
              <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    onSubmitSearch();
                  }}
                  className="relative w-full lg:flex-1"
                >
                  {isSearching ? (
                    <Loader2 className="w-4 h-4 animate-spin text-teal-700 dark:text-teal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  ) : (
                    <Search className="w-4 h-4 text-[#525d6d] dark:text-[#8b95a5] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  )}
                  <input
                    type="search"
                    enterKeyHint="search"
                    value={searchInput}
                    onChange={(e) => onChangeSearchInput(e.target.value)}
                    placeholder="Search YouTube or paste URL..."
                    aria-label="Search YouTube videos or paste URL"
                    className={`w-full h-9 pl-9 ${
                      searchInput ? "pr-9" : "pr-3"
                    } text-[13px] rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d]/75 dark:placeholder:text-[#8b95a5]/75 focus:outline-none focus:border-teal-700 dark:focus:border-teal-400 transition-colors [&::-webkit-search-cancel-button]:hidden`}
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={onClearSearch}
                      aria-label="Clear search"
                      className="w-7 h-7 rounded flex items-center justify-center text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-white absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </form>

                {/* Inline Feed Filters */}
                <div className="w-full lg:w-auto flex flex-wrap items-center justify-between gap-2 shrink-0">
                  <label
                    title="Show Thai-language videos only"
                    className={`inline-flex items-center gap-2 h-9 pr-2 pl-0.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 select-none transition-colors ${
                      isSearching ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                    } ${
                      thaiOnly
                        ? "text-[#0e1217] dark:text-[#f1f3f5]"
                        : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={thaiOnly}
                      onChange={onToggleThaiOnly}
                      disabled={isSearching}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={`w-4 h-4 rounded-[3px] border flex items-center justify-center transition-colors ${
                        thaiOnly
                          ? "bg-teal-700 border-teal-700 text-white dark:bg-teal-400 dark:border-teal-400 dark:text-[#061412]"
                          : "bg-white dark:bg-[#12151a] border-[#b8c2d0] dark:border-[#3b4554]"
                      }`}
                    >
                      {thaiOnly && <Check className="w-3 h-3 stroke-[2.75]" />}
                    </span>
                    <span>Thai only</span>
                  </label>

                  <div className="flex items-center gap-2 ml-auto shrink-0">
                    <div
                      role="group"
                      aria-label="Reuse license filter"
                      className="h-9 inline-flex items-center p-0.5 rounded-md bg-[#eceff3] dark:bg-[#181c23] border border-[#dde2e9] dark:border-[#242a34] shrink-0"
                    >
                      {(
                        [
                          { id: "all", label: "All" },
                          { id: "creative_commons", label: "CC" },
                          { id: "standard", label: "Standard" },
                        ] as const
                      ).map((opt) => {
                        const selected = licenseFilter === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => onChangeLicenseFilter(opt.id)}
                            className={`h-full px-2.5 text-xs font-medium rounded-sm whitespace-nowrap shrink-0 transition-colors cursor-pointer flex items-center ${
                              selected
                                ? "bg-white dark:bg-[#12151a] text-teal-700 dark:text-teal-400 font-semibold shadow-xs"
                                : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    {activeQuery ? (
                      <button
                        type="button"
                        onClick={onResetToRecommended}
                        className="h-9 px-3 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#181c23] text-xs font-medium text-teal-700 dark:text-teal-400 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                      >
                        Recommended
                      </button>
                    ) : (
                      onRefreshRecommended && (
                        <button
                          type="button"
                          onClick={onRefreshRecommended}
                          disabled={isSearching}
                          title="Refresh recommended videos"
                          aria-label="Refresh recommended videos"
                          className="h-9 w-9 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isSearching ? "animate-spin" : ""}`} />
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                {/* Left / Top: Active 16:9 YouTube Preview Theater */}
                <div className="lg:col-span-7 lg:sticky lg:top-0">
                  <YouTubePreviewPanel
                    media={youtubeMedia}
                    videos={videos}
                    hasMoreVideos={hasMoreVideos}
                    isLoadingMore={isLoadingMore}
                    isSearching={isSearching}
                    isWorkspaceVisible={isWorkspaceVisible}
                    initialSec={ytPreviewSec}
                    seekRequest={ytSeekRequest}
                    onSelectPreviewVideo={onSelectVideo}
                    onLoadMoreVideos={onLoadMoreVideos}
                    onCurrentSecChange={onYtCurrentSecChange}
                    onDetectedDuration={onDetectedYouTubeDuration}
                  />
                </div>

                {/* Right / Bottom: Clean Flat Hairline-Divided Feed Catalog */}
                <div className="lg:col-span-5 flex flex-col gap-2 min-w-0">
                  <div className="flex items-center justify-between text-[11px] text-[#525d6d] dark:text-[#8b95a5]">
                    <span className="font-display font-semibold uppercase tracking-wider text-[#0e1217] dark:text-[#f1f3f5] truncate">
                      {activeQuery ? `Results · “${activeQuery}”` : "Recommended"}
                    </span>
                    {videos.length > 0 && !isSearching && (
                      <span className="font-mono-tabular shrink-0">
                        {videos.length}{hasMoreVideos ? "+" : ""} videos
                      </span>
                    )}
                  </div>

                  {searchError && (
                    <div className="p-3 rounded-md border border-red-200 dark:border-red-900/70 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                      {searchError}
                    </div>
                  )}

                  {isSearching ? (
                    <div className="rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] divide-y divide-[#dde2e9] dark:divide-[#242a34] overflow-hidden">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div
                          key={i}
                          className="p-2.5 flex flex-col sm:flex-row gap-3 animate-pulse"
                        >
                          <div className="aspect-video w-full sm:w-32 sm:shrink-0 rounded-sm bg-[#eceff3] dark:bg-[#181c23]" />
                          <div className="flex-1 py-1 space-y-2">
                            <div className="h-3.5 bg-[#eceff3] dark:bg-[#181c23] rounded w-5/6" />
                            <div className="h-3 bg-[#eceff3] dark:bg-[#181c23] rounded w-1/2" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : videos.length === 0 ? (
                    <div className="py-10 flex flex-col items-center justify-center text-center text-[#525d6d] dark:text-[#8b95a5] rounded-md border border-dashed border-[#c9d1dc] dark:border-[#2e3644] bg-white dark:bg-[#12151a] p-6">
                      <Film className="w-5 h-5 mb-2 opacity-60" />
                      <p className="text-xs sm:text-sm">
                        {thaiOnly
                          ? "No Thai-language videos matched this filter"
                          : licenseFilter !== "all"
                            ? "No videos matched this license filter"
                            : "No YouTube videos found"}
                      </p>
                      <div className="mt-2.5 flex items-center gap-3">
                        {thaiOnly && (
                          <button
                            type="button"
                            onClick={onToggleThaiOnly}
                            className="text-xs font-medium underline text-teal-700 dark:text-teal-400 cursor-pointer"
                          >
                            Show all languages
                          </button>
                        )}
                        {licenseFilter !== "all" && (
                          <button
                            type="button"
                            onClick={() => onChangeLicenseFilter("all")}
                            className="text-xs font-medium underline text-teal-700 dark:text-teal-400 cursor-pointer"
                          >
                            Show all licenses
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] divide-y divide-[#dde2e9] dark:divide-[#242a34] overflow-hidden">
                        {videos.map((v) => {
                          const isSelected = selectedVideoId === v.videoId;
                          return (
                            <button
                              key={v.videoId}
                              type="button"
                              onClick={() => handlePickYouTubeVideo(v)}
                              className={`group w-full text-left p-2.5 transition-colors cursor-pointer flex flex-col sm:flex-row gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 border-l-2 ${
                                isSelected
                                  ? "border-l-teal-700 dark:border-l-teal-400 bg-teal-50/50 dark:bg-teal-950/30"
                                  : "border-l-transparent hover:bg-[#f5f6f8] dark:hover:bg-[#181c23]"
                              }`}
                            >
                              <div className="relative w-full sm:w-32 aspect-video rounded-sm bg-[#eceff3] dark:bg-[#181c23] overflow-hidden shrink-0">
                                <img
                                  src={v.thumbnail}
                                  alt={v.title}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                                />
                                <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded-xs bg-[#07080a]/90 text-white text-[10px] font-mono-tabular">
                                  {v.durationText}
                                </span>
                              </div>

                              <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                                <p className="text-xs font-semibold text-[#0e1217] dark:text-[#f1f3f5] line-clamp-2 leading-snug">
                                  {v.title}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[#525d6d] dark:text-[#8b95a5]">
                                  <span className="truncate max-w-[150px]">{v.channel}</span>
                                  {v.viewCountText && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono-tabular shrink-0">{v.viewCountText}</span>
                                    </>
                                  )}
                                  {v.license === "creative_commons" && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="shrink-0">CC</span>
                                    </>
                                  )}
                                  {isSelected && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-semibold text-teal-700 dark:text-teal-400 shrink-0">
                                        Previewing
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Infinite scroll sentinel & manual Load More */}
                      {hasMoreVideos && (
                        <div ref={loadMoreSentinelRef} className="pt-1 flex justify-center">
                          <button
                            type="button"
                            onClick={onLoadMoreVideos}
                            disabled={isLoadingMore}
                            className="h-8 px-3.5 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#181c23] text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors"
                          >
                            {isLoadingMore ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-700 dark:text-teal-400" />
                                <span>Loading more...</span>
                              </>
                            ) : (
                              <span>Load More Videos</span>
                            )}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "projects" && (
            <SavedProjectsPanel
              projects={savedProjects}
              activeSavedId={activeSavedId}
              canSaveCurrent={canSaveCurrent}
              isLoading={isLoadingSaved}
              isSaving={isSavingProject}
              onSaveCurrent={onSaveProject}
              onOpenProject={onOpenSavedProject}
              onRenameProject={onRenameSavedProject}
              onDeleteProject={onDeleteSavedProject}
              onExportJson={onExportSavedJson}
              onImportJson={onImportSavedJson}
              onRelinkLocalVideo={onRelinkLocalVideo}
            />
          )}
        </div>
      </div>

      {/* Unified Compact Studio Inspector: Single Underline Tab Header + Zero Nested Container Bloat */}
      <div
        className={
          isStudioView
            ? "flex-1 min-h-0 flex flex-col bg-white dark:bg-[#12151a] overflow-hidden"
            : "hidden"
        }
      >
          {/* Single Edge-to-Edge Studio Underline Tab Bar */}
          <div className="h-10 shrink-0 px-3.5 border-b border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8]/70 dark:bg-[#0b0d10]/70 flex items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label="Studio workspace groups"
              className="h-full flex items-center gap-4 overflow-x-auto no-scrollbar"
            >
              {studioTabs.map((item) => {
                const Icon = item.icon;
                const active = studioSection === item.id;
                const isDisabled = !hasStudioVideo && item.id !== "clips";
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-disabled={isDisabled || undefined}
                    disabled={isDisabled}
                    title={isDisabled ? "Upload a video first" : undefined}
                    onClick={() => {
                      if (!isDisabled) onChangeStudioSection(item.id);
                    }}
                    className={`relative h-full border-b-2 text-xs whitespace-nowrap shrink-0 flex items-center gap-1.5 transition-colors ${
                      isDisabled
                        ? "border-transparent text-[#525d6d]/45 dark:text-[#8b95a5]/40 font-medium opacity-45 cursor-not-allowed"
                        : active
                          ? "border-teal-700 dark:border-teal-400 text-[#0e1217] dark:text-[#f1f3f5] font-semibold cursor-pointer"
                          : "border-transparent text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] font-medium cursor-pointer"
                    }`}
                  >
                    <Icon
                      className={`w-3.5 h-3.5 shrink-0 ${
                        !isDisabled && active ? "text-teal-700 dark:text-teal-400" : ""
                      }`}
                    />
                    <span>{item.label}</span>
                    {typeof item.count === "number" && item.count > 0 && (
                      <span className="text-[10px] font-mono-tabular opacity-70">
                        {item.count}
                      </span>
                    )}
                    {item.dirty && !isDisabled && (
                      <span
                        aria-hidden="true"
                        className="w-1.5 h-1.5 rounded-full bg-teal-600 dark:bg-teal-400 shrink-0"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {dirtyMap.isModified &&
                (studioSection === "visual" || studioSection === "audio") && (
                  <button
                    type="button"
                    onClick={() => {
                      onChangeEditSettings({
                        ...DEFAULT_VIDEO_EDIT,
                        showThaiScript: editSettings.showThaiScript,
                        translationTone: editSettings.translationTone,
                        subtitleFontScale: editSettings.subtitleFontScale,
                        subtitleTheme: editSettings.subtitleTheme,
                        subtitleHighlightColor: editSettings.subtitleHighlightColor,
                        showWordGloss: editSettings.showWordGloss,
                        showBurmeseLine: editSettings.showBurmeseLine,
                      });
                      onChangeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS });
                    }}
                    className="text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5] hover:text-teal-700 dark:hover:text-teal-400 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span className="hidden sm:inline">Reset All</span>
                  </button>
                )}

              {project && (
                <span className="text-[11px] text-[#525d6d] dark:text-[#8b95a5] font-mono-tabular whitespace-nowrap">
                  {project.scenes.length} · {studioHeaderDuration}s
                </span>
              )}
            </div>
          </div>

          {/* Flat Edge-to-Edge Studio Body */}
          <div className="flex-1 overflow-y-auto overscroll-y-contain studio-scrollbar min-h-0">
            {(isProcessing || Boolean(regeneratingClipId)) && (() => {
              const stage = generationProgress?.stage ?? "extracting";
              const percent = Math.max(0, Math.min(100, generationProgress?.percent ?? 5));
              const label =
                generationProgress?.label || "Transcribing spoken dialogue in selected clips...";
              const steps: { id: "extracting" | "detecting" | "generating"; text: string }[] = [
                { id: "extracting", text: "Extract" },
                { id: "detecting", text: "Speech" },
                { id: "generating", text: "Subtitles" },
              ];
              const rankMap: Record<string, number> = {
                uploading: -1,
                extracting: 0,
                detecting: 1,
                generating: 2,
                compiling: 3,
              };
              const currentRank = rankMap[stage] ?? 0;

              return (
                <div className="px-3.5 py-2.5 border-b border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] space-y-2 text-xs text-[#0e1217] dark:text-[#f1f3f5]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-700 dark:text-teal-400 shrink-0" />
                      <span className="truncate font-medium">{label}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-mono-tabular font-semibold text-teal-700 dark:text-teal-400">
                        {percent}%
                      </span>
                      {onCancelGenerateSubtitles && (
                        <button
                          type="button"
                          onClick={onCancelGenerateSubtitles}
                          className="h-6 px-2 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                        >
                          <Square className="w-2.5 h-2.5 fill-current" />
                          <span>Stop</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="w-full h-1 rounded-full bg-[#dde2e9] dark:bg-[#242a34] overflow-hidden">
                    <div
                      className="h-full bg-teal-700 dark:bg-teal-400 transition-[width] duration-300"
                      style={{ width: `${Math.max(4, percent)}%` }}
                    />
                  </div>

                  <div className="flex items-center gap-2 text-[10px] font-medium">
                    {stage === "uploading" && (
                      <>
                        <span className="text-teal-700 dark:text-teal-400 font-semibold">
                          Uploading
                        </span>
                        <span className="text-[#8b95a5]">→</span>
                      </>
                    )}
                    {steps.map((step, sIdx) => {
                      const done = currentRank > sIdx;
                      const active = currentRank === sIdx;
                      return (
                        <span key={step.id} className="inline-flex items-center gap-1.5">
                          {sIdx > 0 && <span className="text-[#8b95a5]">→</span>}
                          <span
                            className={
                              active
                                ? "text-teal-700 dark:text-teal-400 font-semibold"
                                : done
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-[#525d6d] dark:text-[#8b95a5]"
                            }
                          >
                            {done ? `✓ ${step.text}` : step.text}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {localMedia ? (
              <div className={studioSection === "clips" ? "px-3.5 py-3" : "hidden"}>
                <ScenePicker
                  media={localMedia}
                  scenes={selectedScenes}
                  isProcessing={isProcessing}
                  generationProgress={generationProgress}
                  clipSubtitleCounts={clipSubtitleCounts}
                  regeneratingClipId={regeneratingClipId}
                  regeneratingClipPercent={regeneratingClipPercent}
                  isTabActive={isWorkspaceVisible && isStudioView && studioSection === "clips"}
                  mobileStageTarget={isMobileStudio ? mobileClipsStageEl : null}
                  translationTone={editSettings.translationTone}
                  onChangeTranslationTone={(tone) =>
                    onChangeEditSettings({ ...editSettings, translationTone: tone })
                  }
                  onUpdateScene={onUpdateScene}
                  onRemoveScene={onRemoveScene}
                  onReplaceScenes={onReplaceScenes}
                  onDetectedDuration={onDetectedLocalDuration}
                  onGenerate={onGenerateSubtitles}
                  onGenerateSingleClip={onGenerateSingleClip}
                  onUploadVideo={onUploadLocalVideo}
                  onClearVideo={onClearLocalVideo}
                />
              </div>
            ) : (
              studioSection === "clips" && (
                <div className="px-3.5 py-3">
                  <ScenePicker
                    media={null}
                    scenes={selectedScenes}
                    isProcessing={isProcessing}
                    generationProgress={generationProgress}
                    clipSubtitleCounts={clipSubtitleCounts}
                    regeneratingClipId={regeneratingClipId}
                    regeneratingClipPercent={regeneratingClipPercent}
                    isTabActive={isWorkspaceVisible && isStudioView && studioSection === "clips"}
                    mobileStageTarget={isMobileStudio ? mobileClipsStageEl : null}
                    translationTone={editSettings.translationTone}
                    onChangeTranslationTone={(tone) =>
                      onChangeEditSettings({ ...editSettings, translationTone: tone })
                    }
                    onUpdateScene={onUpdateScene}
                    onRemoveScene={onRemoveScene}
                    onReplaceScenes={onReplaceScenes}
                    onDetectedDuration={onDetectedLocalDuration}
                    onGenerate={onGenerateSubtitles}
                    onGenerateSingleClip={onGenerateSingleClip}
                    onUploadVideo={onUploadLocalVideo}
                    onClearVideo={onClearLocalVideo}
                  />
                </div>
              )
            )}

            {studioSection === "captions" && !project && (
              <div className="p-6 text-center space-y-3">
                <div className="w-9 h-9 rounded-md bg-teal-50 dark:bg-teal-950/60 border border-teal-200/70 dark:border-teal-500/25 text-teal-700 dark:text-teal-400 flex items-center justify-center mx-auto">
                  <Captions className="w-4 h-4" />
                </div>
                <div className="space-y-1 max-w-sm mx-auto">
                  <p className="font-display text-sm font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
                    No generated captions yet
                  </p>
                  <p className="text-xs text-[#525d6d] dark:text-[#8b95a5] leading-relaxed">
                    Upload a video, cut the clips you want, and generate subtitles in Upload &amp; Cut to edit Thai phonetics, Burmese translations, and styling.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onChangeStudioSection("clips")}
                  className="h-8 px-3.5 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>Upload &amp; Cut</span>
                </button>
              </div>
            )}

            {studioSection === "captions" && project && (
              <div className="flex flex-col">
                {/* Compact Scenes Jump + Undo/Redo + Add Row */}
                <div className="px-3.5 py-2 border-b border-[#dde2e9] dark:border-[#242a34] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1">
                    {project.scenes.map((sc, idx) => {
                      let sceneCutStart = 0;
                      for (let i = 0; i < idx; i++) {
                        sceneCutStart += getSceneDurationSec(project.scenes[i]);
                      }
                      const sceneDur = getSceneDurationSec(sc);
                      const isSceneActive =
                        cutTime >= sceneCutStart && cutTime < sceneCutStart + sceneDur;

                      return (
                        <button
                          key={sc.index}
                          type="button"
                          onClick={() => onSeek(sceneCutStart)}
                          className={`px-2 py-1 rounded-sm text-[11px] font-mono-tabular border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                            isSceneActive
                              ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#061412] dark:border-teal-400 font-semibold"
                              : "bg-[#f5f6f8] dark:bg-[#181c23] text-[#0e1217] dark:text-[#f1f3f5] border-[#dde2e9] dark:border-[#242a34] hover:border-[#c3ccd9] dark:hover:border-[#323a48]"
                          }`}
                        >
                          {idx + 1}. {formatRangeSec(sc.startSec)}–{formatRangeSec(sc.endSec)}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="inline-flex items-center border border-[#dde2e9] dark:border-[#242a34] rounded-sm overflow-hidden bg-white dark:bg-[#181c23]">
                      <button
                        type="button"
                        disabled={!canUndoSubtitles || !onUndoSubtitles}
                        onClick={onUndoSubtitles}
                        title="Undo subtitle edit (Ctrl+Z)"
                        aria-label="Undo subtitle edit"
                        className="h-7 px-2 flex items-center gap-1 text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
                      >
                        <Undo2 className="w-3 h-3" />
                        <span>Undo</span>
                      </button>
                      <button
                        type="button"
                        disabled={!canRedoSubtitles || !onRedoSubtitles}
                        onClick={onRedoSubtitles}
                        title="Redo subtitle edit (Ctrl+Shift+Z)"
                        aria-label="Redo subtitle edit"
                        className="h-7 px-2 flex items-center gap-1 text-[11px] font-medium border-l border-[#dde2e9] dark:border-[#242a34] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
                      >
                        <Redo2 className="w-3 h-3" />
                        <span>Redo</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => (showAddSub ? setShowAddSub(false) : openAddSubtitleForm())}
                      className="h-7 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                    >
                      {showAddSub ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                      <span>{showAddSub ? "Close" : "Add"}</span>
                    </button>
                  </div>
                </div>

                {/* Flat Hairline Captions Controls Bar (Zero Nested Card Container) */}
                <div className="px-3.5 py-2 border-b border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8]/60 dark:bg-[#0b0d10]/50 space-y-2">
                  {/* Line 1: Tone & Thai Script Toggle */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5] whitespace-nowrap">
                        Tone
                      </span>
                      <div
                        role="group"
                        aria-label="Translation tone"
                        className="inline-flex items-center p-0.5 rounded-sm bg-[#eceff3] dark:bg-[#181c23] border border-[#dde2e9] dark:border-[#242a34]"
                      >
                        {SUBTITLE_TONE_OPTIONS.map((opt) => {
                          const active = editSettings.translationTone === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() =>
                                onChangeEditSettings({
                                  ...editSettings,
                                  translationTone: opt.id,
                                })
                              }
                              className={`px-2 py-0.5 rounded-xs text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                                active
                                  ? "bg-white dark:bg-[#12151a] text-teal-700 dark:text-teal-400 font-semibold shadow-xs"
                                  : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>

                      {project.subtitles.length > 0 && (
                        isRetranslatingAll ? (
                          <div className="inline-flex items-center gap-1">
                            <span className="h-6 px-2 rounded-sm border border-teal-300 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              <span>Applying</span>
                            </span>
                            {onCancelRetranslateAll && (
                              <button
                                type="button"
                                onClick={onCancelRetranslateAll}
                                title="Stop Apply Tone"
                                aria-label="Stop Apply Tone"
                                className="h-6 px-2 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
                              >
                                <Square className="w-2.5 h-2.5 fill-current" />
                                <span>Stop</span>
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={isResyncingTimings}
                            onClick={() => onRetranslateAll(editSettings.translationTone)}
                            title="Re-translate all subtitles using selected tone"
                            className="h-6 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:text-teal-700 dark:hover:text-teal-400 text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 transition-colors"
                          >
                            <Sparkles className="w-3 h-3" />
                            <span>Apply</span>
                          </button>
                        )
                      )}
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={editSettings.showThaiScript}
                      onClick={() =>
                        onChangeEditSettings({
                          ...editSettings,
                          showThaiScript: !editSettings.showThaiScript,
                        })
                      }
                      title="Show or hide Thai script in editor, 9:16 preview, and MP4 export"
                      className={`h-6 px-2 rounded-sm border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                        editSettings.showThaiScript
                          ? "border-teal-600/70 bg-teal-50/80 text-teal-800 dark:border-teal-400/70 dark:bg-teal-950/50 dark:text-teal-200"
                          : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                      }`}
                    >
                      <span>Thai Script</span>
                      <span
                        aria-hidden="true"
                        className={`w-5 h-3 rounded-full p-0.5 transition-colors flex items-center ${
                          editSettings.showThaiScript
                            ? "bg-teal-700 dark:bg-teal-400 justify-end"
                            : "bg-[#c9d1dc] dark:bg-[#2e3644] justify-start"
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full bg-white shadow-xs" />
                      </span>
                    </button>
                  </div>

                  {/* Line 2: Timing Sync & Subtitle Utilities */}
                  {project.subtitles.length > 0 && (() => {
                    const subStyleCustomized =
                      editSettings.subtitleFontScale !== DEFAULT_VIDEO_EDIT.subtitleFontScale ||
                      editSettings.subtitleTheme !== DEFAULT_VIDEO_EDIT.subtitleTheme ||
                      editSettings.subtitleHighlightColor !== DEFAULT_VIDEO_EDIT.subtitleHighlightColor ||
                      editSettings.showWordGloss !== DEFAULT_VIDEO_EDIT.showWordGloss ||
                      editSettings.showBurmeseLine !== DEFAULT_VIDEO_EDIT.showBurmeseLine;

                    const effectiveSpd = getEffectivePlaybackSpeed(
                      project.sourceType,
                      editSettings.playbackSpeed,
                      voiceSettings.speed
                    );
                    const exportOpts = {
                      speed: effectiveSpd,
                      showThaiScript: editSettings.showThaiScript,
                      showWordGloss: editSettings.showWordGloss,
                      showBurmeseLine: editSettings.showBurmeseLine,
                    };
                    const slug = makeSafeFileSlug(project.title);

                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex flex-wrap items-center gap-1">
                            {[-0.5, -0.1, 0.1, 0.5].map((delta) => (
                              <button
                                key={delta}
                                type="button"
                                onClick={() => onShiftAllSubtitles(delta)}
                                title={`Shift all subtitles by ${delta > 0 ? `+${delta}` : delta}s`}
                                className="h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[10px] font-mono-tabular font-medium text-[#0e1217] dark:text-[#f1f3f5] cursor-pointer whitespace-nowrap transition-colors"
                              >
                                {delta > 0 ? `+${delta}s` : `${delta}s`}
                              </button>
                            ))}
                            {onAutoFixSubtitleTimings && (
                              <button
                                type="button"
                                onClick={onAutoFixSubtitleTimings}
                                title="Automatically fix overlaps, flicker gaps, and out-of-range subtitle timings"
                                className="h-6 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:border-teal-600/70 hover:text-teal-700 dark:hover:border-teal-400/70 dark:hover:text-teal-400 text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                              >
                                <Wand2 className="w-3 h-3" />
                                <span>Fix</span>
                              </button>
                            )}
                            {onAiResyncSubtitles && (
                              isResyncingTimings ? (
                                <div className="inline-flex items-center gap-1">
                                  <span className="h-6 px-2 rounded-sm border border-teal-300 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Sync</span>
                                  </span>
                                  {onCancelAiResync && (
                                    <button
                                      type="button"
                                      onClick={onCancelAiResync}
                                      title="Cancel AI timing sync"
                                      aria-label="Cancel AI timing sync"
                                      className="h-6 px-1.5 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                                    >
                                      <Square className="w-2.5 h-2.5 fill-current" />
                                      <span>Stop</span>
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isRetranslatingAll}
                                  onClick={onAiResyncSubtitles}
                                  title="AI listens to audio and aligns subtitle timings"
                                  className="h-6 px-2 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/80 dark:bg-teal-950/50 hover:bg-teal-100 dark:hover:bg-teal-900/60 text-[11px] font-semibold text-teal-800 dark:text-teal-200 flex items-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                                >
                                  <RefreshCw className="w-3 h-3" />
                                  <span>AI Sync</span>
                                </button>
                              )
                            )}
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setShowSubSearch((v) => !v)}
                              title="Search & Replace subtitles"
                              className={`h-6 px-2 rounded-sm border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                                showSubSearch || subSearchQuery.trim()
                                  ? "border-teal-600/80 bg-teal-50/80 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                  : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e]"
                              }`}
                            >
                              <Search className="w-3 h-3" />
                              <span>Find</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => setShowSubStyle((v) => !v)}
                              title="Customize 9:16 subtitle theme, font size, highlight & visibility"
                              className={`h-6 px-2 rounded-sm border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                                showSubStyle || subStyleCustomized
                                  ? "border-teal-600/80 bg-teal-50/80 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                  : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e]"
                              }`}
                            >
                              <Palette className="w-3 h-3" />
                              <span>Style</span>
                            </button>

                            <button
                              type="button"
                              onClick={jumpToActiveSubtitle}
                              title="Scroll to currently active subtitle at playhead"
                              className="h-6 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                            >
                              <LocateFixed className="w-3 h-3" />
                              <span>Jump</span>
                            </button>

                            <div ref={exportMenuRef} className="relative">
                              <button
                                type="button"
                                onClick={() => setShowExportMenu((v) => !v)}
                                title="Export SRT / VTT / Study Sheet"
                                className="h-6 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                              >
                                {copiedTranscript ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                    <span className="text-emerald-700 dark:text-emerald-300">Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Download className="w-3 h-3" />
                                    <span>SRT</span>
                                  </>
                                )}
                              </button>

                              {showExportMenu && (
                                <div className="absolute right-0 mt-1 w-44 rounded-md border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] shadow-lg p-1 z-30 space-y-0.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      downloadTextFile(
                                        `${slug}.srt`,
                                        buildSrtContent(project.subtitles, exportOpts),
                                        "application/x-subrip;charset=utf-8"
                                      );
                                      setShowExportMenu(false);
                                    }}
                                    className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23] flex items-center gap-2 cursor-pointer"
                                  >
                                    <FileText className="w-3.5 h-3.5 text-[#525d6d] dark:text-[#8b95a5]" />
                                    <span>Download .SRT</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      downloadTextFile(
                                        `${slug}.vtt`,
                                        buildVttContent(project.subtitles, exportOpts),
                                        "text/vtt;charset=utf-8"
                                      );
                                      setShowExportMenu(false);
                                    }}
                                    className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23] flex items-center gap-2 cursor-pointer"
                                  >
                                    <FileText className="w-3.5 h-3.5 text-[#525d6d] dark:text-[#8b95a5]" />
                                    <span>Download .VTT</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      downloadTextFile(
                                        `${slug}-study.txt`,
                                        buildStudyTextContent(project.title, project.subtitles, exportOpts),
                                        "text/plain;charset=utf-8"
                                      );
                                      setShowExportMenu(false);
                                    }}
                                    className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23] flex items-center gap-2 cursor-pointer"
                                  >
                                    <BookOpen className="w-3.5 h-3.5 text-[#525d6d] dark:text-[#8b95a5]" />
                                    <span>Study Sheet .TXT</span>
                                  </button>
                                  <div className="my-1 border-t border-[#dde2e9] dark:border-[#242a34]" />
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(
                                          buildStudyTextContent(project.title, project.subtitles, exportOpts)
                                        );
                                        setCopiedTranscript(true);
                                        setTimeout(() => setCopiedTranscript(false), 2000);
                                      } catch {
                                        // ignore clipboard permission failure
                                      }
                                      setShowExportMenu(false);
                                    }}
                                    className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23] flex items-center gap-2 cursor-pointer"
                                  >
                                    <Copy className="w-3.5 h-3.5 text-[#525d6d] dark:text-[#8b95a5]" />
                                    <span>Copy Transcript</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Inline Search & Find/Replace Drawer */}
                        {showSubSearch && (
                          <div className="pt-2 border-t border-[#dde2e9] dark:border-[#242a34] space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <div className="relative flex-1 min-w-0">
                                <Search className="w-3.5 h-3.5 text-[#525d6d] dark:text-[#8b95a5] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                                <input
                                  type="text"
                                  value={subSearchQuery}
                                  onChange={(e) => setSubSearchQuery(e.target.value)}
                                  placeholder="Filter or find in phonetic, Thai, Burmese..."
                                  aria-label="Search subtitles"
                                  className="w-full h-7 pl-7 pr-6 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-xs text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                />
                                {subSearchQuery && (
                                  <button
                                    type="button"
                                    onClick={() => setSubSearchQuery("")}
                                    aria-label="Clear search"
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </div>

                              <button
                                type="button"
                                onClick={() => setShowReplaceRow((v) => !v)}
                                className={`h-7 px-2 rounded-sm border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                                  showReplaceRow
                                    ? "border-teal-600/80 bg-teal-50 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                    : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                }`}
                              >
                                <Replace className="w-3 h-3" />
                                <span>Replace</span>
                              </button>
                            </div>

                            {showReplaceRow && onFindReplaceSubtitles && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <input
                                  type="text"
                                  value={subReplaceText}
                                  onChange={(e) => setSubReplaceText(e.target.value)}
                                  placeholder="Replace with..."
                                  aria-label="Replacement text"
                                  className="flex-1 min-w-[130px] h-7 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-xs text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                />
                                <select
                                  value={subReplaceField}
                                  onChange={(e) =>
                                    setSubReplaceField(
                                      e.target.value as "all" | "burmese" | "thaiPhonetic" | "thaiScript"
                                    )
                                  }
                                  aria-label="Target field for replace"
                                  className="h-7 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-[11px] text-[#0e1217] dark:text-[#f1f3f5] cursor-pointer"
                                >
                                  <option value="all">All Fields</option>
                                  <option value="burmese">Burmese</option>
                                  <option value="thaiPhonetic">Phonetic</option>
                                  <option value="thaiScript">Thai Script</option>
                                </select>
                                <button
                                  type="button"
                                  disabled={!subSearchQuery}
                                  onClick={() => {
                                    const count = onFindReplaceSubtitles({
                                      findText: subSearchQuery,
                                      replaceText: subReplaceText,
                                      field: subReplaceField,
                                    });
                                    setReplaceFeedback(
                                      count > 0
                                        ? `Replaced ${count} ${count === 1 ? "match" : "matches"}`
                                        : "No matches found"
                                    );
                                  }}
                                  className="h-7 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap transition-colors"
                                >
                                  Replace All
                                </button>
                                {replaceFeedback && (
                                  <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                                    {replaceFeedback}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Inline Subtitle Style Drawer */}
                        {showSubStyle && (
                          <div className="pt-2 border-t border-[#dde2e9] dark:border-[#242a34] space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5]">
                                  Theme
                                </span>
                                <div className="inline-flex items-center p-0.5 rounded-sm bg-white dark:bg-[#181c23] border border-[#dde2e9] dark:border-[#242a34]">
                                  {(
                                    [
                                      { id: "auto", label: "Auto" },
                                      { id: "light", label: "Light" },
                                      { id: "dark", label: "Dark" },
                                      { id: "warm", label: "Warm" },
                                    ] as { id: SubtitleTheme; label: string }[]
                                  ).map((t) => (
                                    <button
                                      key={t.id}
                                      type="button"
                                      onClick={() =>
                                        onChangeEditSettings({ ...editSettings, subtitleTheme: t.id })
                                      }
                                      className={`px-2 py-0.5 rounded-xs text-[11px] font-medium cursor-pointer transition-colors ${
                                        editSettings.subtitleTheme === t.id
                                          ? "bg-[#eceff3] dark:bg-[#242a34] text-teal-700 dark:text-teal-400 font-semibold"
                                          : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                      }`}
                                    >
                                      {t.label}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5]">
                                  Size
                                </span>
                                <div className="inline-flex items-center p-0.5 rounded-sm bg-white dark:bg-[#181c23] border border-[#dde2e9] dark:border-[#242a34]">
                                  {(
                                    [
                                      { id: "sm", label: "S" },
                                      { id: "md", label: "M" },
                                      { id: "lg", label: "L" },
                                    ] as { id: SubtitleFontScale; label: string }[]
                                  ).map((sz) => (
                                    <button
                                      key={sz.id}
                                      type="button"
                                      onClick={() =>
                                        onChangeEditSettings({
                                          ...editSettings,
                                          subtitleFontScale: sz.id,
                                        })
                                      }
                                      className={`px-2 py-0.5 rounded-xs text-[11px] font-semibold cursor-pointer transition-colors ${
                                        editSettings.subtitleFontScale === sz.id
                                          ? "bg-[#eceff3] dark:bg-[#242a34] text-teal-700 dark:text-teal-400"
                                          : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                      }`}
                                    >
                                      {sz.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5] mr-0.5">
                                  Highlight
                                </span>
                                {(
                                  [
                                    { id: "amber", swatch: "bg-amber-300", label: "Amber" },
                                    { id: "emerald", swatch: "bg-emerald-300", label: "Emerald" },
                                    { id: "indigo", swatch: "bg-indigo-500", label: "Indigo" },
                                    { id: "rose", swatch: "bg-rose-300", label: "Rose" },
                                  ] as { id: SubtitleHighlightColor; swatch: string; label: string }[]
                                ).map((c) => {
                                  const selected = editSettings.subtitleHighlightColor === c.id;
                                  return (
                                    <button
                                      key={c.id}
                                      type="button"
                                      title={c.label}
                                      aria-label={`Highlight color ${c.label}`}
                                      onClick={() =>
                                        onChangeEditSettings({
                                          ...editSettings,
                                          subtitleHighlightColor: c.id,
                                        })
                                      }
                                      className={`w-4 h-4 rounded-full ${c.swatch} cursor-pointer transition-transform ${
                                        selected
                                          ? "ring-2 ring-offset-1 ring-teal-700 dark:ring-teal-400 dark:ring-offset-[#12151a] scale-110"
                                          : "opacity-75 hover:opacity-100"
                                      }`}
                                    />
                                  );
                                })}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={editSettings.showWordGloss}
                                  onClick={() =>
                                    onChangeEditSettings({
                                      ...editSettings,
                                      showWordGloss: !editSettings.showWordGloss,
                                    })
                                  }
                                  className={`h-6 px-2 rounded-sm border text-[11px] font-medium cursor-pointer transition-colors ${
                                    editSettings.showWordGloss
                                      ? "border-teal-600/80 bg-teal-50/80 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                      : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5]"
                                  }`}
                                >
                                  Word Gloss
                                </button>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={editSettings.showBurmeseLine}
                                  onClick={() =>
                                    onChangeEditSettings({
                                      ...editSettings,
                                      showBurmeseLine: !editSettings.showBurmeseLine,
                                    })
                                  }
                                  className={`h-6 px-2 rounded-sm border text-[11px] font-medium cursor-pointer transition-colors ${
                                    editSettings.showBurmeseLine
                                      ? "border-teal-600/80 bg-teal-50/80 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                      : "border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5]"
                                  }`}
                                >
                                  Burmese
                                </button>
                                {subStyleCustomized && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onChangeEditSettings({
                                        ...editSettings,
                                        subtitleFontScale: DEFAULT_VIDEO_EDIT.subtitleFontScale,
                                        subtitleTheme: DEFAULT_VIDEO_EDIT.subtitleTheme,
                                        subtitleHighlightColor:
                                          DEFAULT_VIDEO_EDIT.subtitleHighlightColor,
                                        showWordGloss: DEFAULT_VIDEO_EDIT.showWordGloss,
                                        showBurmeseLine: DEFAULT_VIDEO_EDIT.showBurmeseLine,
                                      })
                                    }
                                    className="h-6 px-1.5 rounded-sm text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5] hover:text-teal-700 dark:hover:text-teal-400 underline cursor-pointer"
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Inline Add Subtitle Form */}
                {showAddSub && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newSubPhonetic.trim() && !newSubBurmese.trim()) return;
                      const s = parseFloat(newSubStart);
                      const en = parseFloat(newSubEnd);
                      onAddSubtitle({
                        startTime: Number.isFinite(s) ? s : cutTime,
                        endTime: Number.isFinite(en) ? en : (Number.isFinite(s) ? s : cutTime) + 2.5,
                        thaiPhonetic: newSubPhonetic,
                        burmese: newSubBurmese,
                      });
                      setShowAddSub(false);
                      setNewSubPhonetic("");
                      setNewSubBurmese("");
                    }}
                    className="px-3.5 py-3 border-b border-[#dde2e9] dark:border-[#242a34] bg-[#eceff3]/60 dark:bg-[#181c23] space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-display text-xs font-semibold text-[#0e1217] dark:text-[#f1f3f5]">
                        New Subtitle
                      </span>
                      <div className="flex items-center gap-1.5 text-xs">
                        <label className="flex items-center gap-1 text-[#525d6d] dark:text-[#8b95a5]">
                          <span>Start</span>
                          <input
                            type="number"
                            step="0.1"
                            min={0}
                            max={project.targetDurationSec}
                            value={newSubStart}
                            onChange={(e) => setNewSubStart(e.target.value)}
                            className="w-16 h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] font-mono-tabular text-xs"
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[#525d6d] dark:text-[#8b95a5]">
                          <span>End</span>
                          <input
                            type="number"
                            step="0.1"
                            min={0.2}
                            max={project.targetDurationSec}
                            value={newSubEnd}
                            onChange={(e) => setNewSubEnd(e.target.value)}
                            className="w-16 h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] font-mono-tabular text-xs"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const maxDur = Math.max(0.5, project.targetDurationSec || 10);
                            const s = Math.min(maxDur - 0.5, Math.max(0, cutTime));
                            setNewSubStart(s.toFixed(1));
                            setNewSubEnd(Math.min(maxDur, s + 2.5).toFixed(1));
                          }}
                          className="h-6 px-2 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-[11px] font-medium text-[#0e1217] dark:text-[#f1f3f5] cursor-pointer whitespace-nowrap transition-colors"
                        >
                          Use playhead
                        </button>
                      </div>
                    </div>

                    <input
                      type="text"
                      value={newSubPhonetic}
                      onChange={(e) => setNewSubPhonetic(e.target.value)}
                      placeholder="Thai phonetic (e.g. Sa-wat-dee khrap)"
                      aria-label="New Thai phonetic subtitle"
                      className="w-full h-8 px-2.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                    />

                    <input
                      type="text"
                      value={newSubBurmese}
                      onChange={(e) => setNewSubBurmese(e.target.value)}
                      placeholder="မြန်မာဘာသာပြန်..."
                      aria-label="New Burmese translation subtitle"
                      className="w-full h-8 px-2.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] font-myanmar text-xs text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                    />

                    <div className="flex items-center justify-end gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => setShowAddSub(false)}
                        className="h-7 px-2.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] text-xs font-medium text-[#0e1217] dark:text-[#f1f3f5] cursor-pointer transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!newSubPhonetic.trim() && !newSubBurmese.trim()}
                        className="h-7 px-3 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      >
                        Add
                      </button>
                    </div>
                  </form>
                )}

                {subtitleRegenError && (
                  <div className="px-3.5 py-2 border-b border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words">{subtitleRegenError}</span>
                    {onClearSubtitleRegenError && (
                      <button
                        type="button"
                        onClick={onClearSubtitleRegenError}
                        aria-label="Dismiss error"
                        className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/50 cursor-pointer shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {/* Full-Bleed Hairline Subtitle Rows */}
                {project.subtitles.length === 0 ? (
                  <div className="p-6 text-center space-y-2.5">
                    <p className="text-xs text-[#525d6d] dark:text-[#8b95a5]">
                      No subtitles in this video yet.
                    </p>
                    <button
                      type="button"
                      onClick={openAddSubtitleForm}
                      className="h-8 px-3.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Subtitle</span>
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-[#dde2e9] dark:divide-[#242a34] bg-white dark:bg-[#12151a]">
                    {(() => {
                      const activeSubId = findActiveSubtitle(project.subtitles, cutTime)?.id;
                      const needle = subSearchQuery.trim().toLowerCase();
                      const visibleSubs = needle
                        ? project.subtitles.filter((s) => {
                            const hay = `${s.thaiPhonetic} ${s.thaiScript} ${s.burmese} ${s.originalSpokenText} ${s.words
                              .map((w) => `${w.phonetic} ${w.burmeseGloss || ""}`)
                              .join(" ")}`.toLowerCase();
                            return hay.includes(needle);
                          })
                        : project.subtitles;

                      if (visibleSubs.length === 0) {
                        return (
                          <div className="p-6 text-center space-y-2 bg-white dark:bg-[#12151a]">
                            <p className="text-xs text-[#525d6d] dark:text-[#8b95a5]">
                              No subtitles match “{subSearchQuery}”.
                            </p>
                            <button
                              type="button"
                              onClick={() => setSubSearchQuery("")}
                              className="text-xs font-medium underline text-teal-700 dark:text-teal-400 cursor-pointer"
                            >
                              Clear filter
                            </button>
                          </div>
                        );
                      }

                      return (
                        <>
                          {needle && (
                            <div className="px-3.5 py-1.5 bg-[#eceff3]/70 dark:bg-[#181c23] text-[11px] text-[#525d6d] dark:text-[#8b95a5] flex items-center justify-between">
                              <span>
                                Showing {visibleSubs.length} of {project.subtitles.length} subtitles
                              </span>
                              <button
                                type="button"
                                onClick={() => setSubSearchQuery("")}
                                className="underline hover:text-[#0e1217] dark:hover:text-[#f1f3f5] cursor-pointer"
                              >
                                Show all
                              </button>
                            </div>
                          )}
                          {visibleSubs.map((sub: SubtitleItem) => {
                            const subIdx = project.subtitles.findIndex((item) => item.id === sub.id);
                            const isCurrent = sub.id === activeSubId;
                            const isLooping = loopingSubId === sub.id;
                            const isEditingTime = editingTimeId === sub.id;
                            const isHintOpen = hintOpenId === sub.id;
                            const isEditingWords = editingWordsId === sub.id;
                            const isRegenerating = regeneratingSubIds.includes(sub.id);
                            const canSplitSub = sub.endTime - sub.startTime >= 0.45;
                            const canMergeNext = subIdx >= 0 && subIdx < project.subtitles.length - 1;
                            const hintValue = hintDrafts[sub.id] ?? "";
                            return (
                              <div
                                key={sub.id}
                                ref={(node) => {
                                  subCardRefs.current[sub.id] = node;
                                }}
                                className={`px-3.5 py-2.5 border-l-2 transition-colors ${
                                  isLooping
                                    ? "border-l-emerald-500 bg-emerald-50/45 dark:bg-emerald-950/20"
                                    : isCurrent
                                      ? "border-l-teal-700 dark:border-l-teal-400 bg-teal-50/40 dark:bg-teal-950/20"
                                      : "border-l-transparent bg-white dark:bg-[#12151a]"
                                }`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => onSeek(sub.startTime)}
                                      className={`text-[11px] font-mono-tabular cursor-pointer shrink-0 transition-colors ${
                                        isCurrent
                                          ? "text-teal-700 dark:text-teal-400 font-semibold"
                                          : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                      }`}
                                    >
                                      {(() => {
                                        const spd = getEffectivePlaybackSpeed(
                                          project.sourceType,
                                          editSettings.playbackSpeed,
                                          voiceSettings.speed
                                        );
                                        return `${formatRangeSec(sub.startTime / spd)} – ${formatRangeSec(
                                          sub.endTime / spd
                                        )}`;
                                      })()}
                                    </button>
                                    <span className="text-[11px] text-[#525d6d]/75 dark:text-[#8b95a5]/75 truncate">
                                      {sub.originalSpokenText}
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => onToggleLoopSubtitle(sub.id)}
                                      title={isLooping ? "Stop looping this line" : "Loop play this subtitle"}
                                      aria-label={isLooping ? "Stop looping this line" : "Loop play this subtitle"}
                                      className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                        isLooping
                                          ? "border-emerald-500 bg-emerald-100/90 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-200"
                                          : "border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                      }`}
                                    >
                                      {isLooping && isPlaying ? (
                                        <Square className="w-2.5 h-2.5 fill-current" />
                                      ) : (
                                        <Repeat className="w-3 h-3" />
                                      )}
                                      <span>{isLooping ? "Stop" : "Loop"}</span>
                                    </button>
                                    {isRegenerating ? (
                                      <button
                                        type="button"
                                        onClick={() => onCancelRegenerateSubtitle?.(sub.id)}
                                        title="Cancel AI regeneration for this subtitle"
                                        aria-label="Cancel AI regeneration for this subtitle"
                                        className="h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-semibold border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-red-700 dark:text-red-300 transition-colors cursor-pointer whitespace-nowrap"
                                      >
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        <span>Stop</span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={isRetranslatingAll || isResyncingTimings}
                                        onClick={() => onRegenerateSubtitle(sub.id, hintValue)}
                                        title="Regenerate this subtitle with AI"
                                        aria-label="Regenerate this subtitle with AI"
                                        className="h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:text-teal-700 dark:hover:text-teal-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                                      >
                                        <Sparkles className="w-3 h-3" />
                                        <span>AI</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setHintOpenId((cur) => (cur === sub.id ? null : sub.id))
                                      }
                                      title="Regenerate with AI hint"
                                      aria-label="Regenerate with AI hint"
                                      className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                        isHintOpen || hintValue.trim()
                                          ? "border-teal-600/70 dark:border-teal-400/70 bg-teal-50/80 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200"
                                          : "border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                      }`}
                                    >
                                      <MessageSquarePlus className="w-3 h-3" />
                                      <span>Hint</span>
                                    </button>
                                    {sub.words.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setEditingWordsId((cur) => (cur === sub.id ? null : sub.id))
                                        }
                                        title="Edit word-by-word Burmese glosses"
                                        aria-label="Edit word-by-word Burmese glosses"
                                        className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                          isEditingWords
                                            ? "border-teal-600/70 dark:border-teal-400/70 bg-teal-50/80 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200"
                                            : "border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5]"
                                        }`}
                                      >
                                        <BookOpen className="w-3 h-3" />
                                        <span>Gloss</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={!canSplitSub}
                                      onClick={() => onSplitSubtitle(sub.id)}
                                      title="Split subtitle into two lines"
                                      aria-label="Split subtitle into two lines"
                                      className="h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
                                    >
                                      <Scissors className="w-3 h-3" />
                                      <span>Split</span>
                                    </button>
                                    {canMergeNext && (
                                      <button
                                        type="button"
                                        onClick={() => onMergeSubtitleWithNext(sub.id)}
                                        title="Merge with next subtitle"
                                        aria-label="Merge with next subtitle"
                                        className="h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23] text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] transition-colors cursor-pointer whitespace-nowrap"
                                      >
                                        <Merge className="w-3 h-3" />
                                        <span>Merge</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (isEditingTime) {
                                          setEditingTimeId(null);
                                        } else {
                                          setEditingTimeId(sub.id);
                                          setEditStartVal(sub.startTime.toFixed(1));
                                          setEditEndVal(sub.endTime.toFixed(1));
                                        }
                                      }}
                                      title="Edit subtitle timing"
                                      aria-label="Edit subtitle timing"
                                      className={`w-6 h-6 rounded-sm flex items-center justify-center transition-colors cursor-pointer ${
                                        isEditingTime
                                          ? "bg-[#eceff3] dark:bg-[#1e242e] text-teal-700 dark:text-teal-400"
                                          : "text-[#525d6d] dark:text-[#8b95a5] hover:text-[#0e1217] dark:hover:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#181c23]"
                                      }`}
                                    >
                                      <Clock className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (editingTimeId === sub.id) setEditingTimeId(null);
                                        if (hintOpenId === sub.id) setHintOpenId(null);
                                        if (editingWordsId === sub.id) setEditingWordsId(null);
                                        onDeleteSubtitle(sub.id);
                                      }}
                                      title="Delete subtitle"
                                      aria-label="Delete subtitle"
                                      className="w-6 h-6 rounded-sm flex items-center justify-center text-[#525d6d] dark:text-[#8b95a5] hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>

                                {isHintOpen && (
                                  <form
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      if (!isRegenerating && !isRetranslatingAll) {
                                        onRegenerateSubtitle(sub.id, hintValue);
                                      }
                                    }}
                                    className="mb-2 p-2 rounded-sm border border-teal-200/80 dark:border-teal-500/30 bg-teal-50/50 dark:bg-teal-950/30 space-y-1.5"
                                  >
                                    <div className="flex flex-wrap gap-1">
                                      {QUICK_AI_HINTS.map((preset) => (
                                        <button
                                          key={preset.label}
                                          type="button"
                                          onClick={() =>
                                            setHintDrafts((prev) => ({
                                              ...prev,
                                              [sub.id]: preset.text,
                                            }))
                                          }
                                          className="px-2 py-0.5 rounded-sm border border-teal-200/80 dark:border-teal-500/30 bg-white dark:bg-[#12151a] text-[10px] font-medium text-teal-800 dark:text-teal-200 hover:bg-teal-100/70 dark:hover:bg-teal-900/50 cursor-pointer whitespace-nowrap"
                                        >
                                          {preset.label}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <input
                                        type="text"
                                        value={hintValue}
                                        onChange={(e) =>
                                          setHintDrafts((prev) => ({
                                            ...prev,
                                            [sub.id]: e.target.value,
                                          }))
                                        }
                                        placeholder="AI Hint (e.g. 'လူနာမည်ဖြစ်တယ်', 'ဗန်းစကားလိုပြန်ပေး')..."
                                        aria-label="AI regeneration hint"
                                        className="flex-1 min-w-0 h-7 px-2 rounded-sm border border-teal-200 dark:border-teal-500/30 bg-white dark:bg-[#12151a] text-xs text-[#0e1217] dark:text-[#f1f3f5] placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                      />
                                      {isRegenerating ? (
                                        <button
                                          type="button"
                                          onClick={() => onCancelRegenerateSubtitle?.(sub.id)}
                                          className="h-7 px-2.5 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/70 hover:bg-red-100 dark:hover:bg-red-900 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                        >
                                          <Square className="w-2.5 h-2.5 fill-current" />
                                          <span>Stop</span>
                                        </button>
                                      ) : (
                                        <button
                                          type="submit"
                                          disabled={isRetranslatingAll || isResyncingTimings}
                                          className="h-7 px-2.5 rounded-sm bg-teal-700 text-white hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 transition-colors"
                                        >
                                          <Sparkles className="w-3 h-3" />
                                          <span>Regenerate</span>
                                        </button>
                                      )}
                                    </div>
                                  </form>
                                )}

                                {isEditingTime && (
                                  <div className="mb-2 flex flex-wrap items-center gap-2 p-1.5 rounded-sm bg-[#eceff3] dark:bg-[#181c23] text-xs">
                                    <label className="flex items-center gap-1 text-[#525d6d] dark:text-[#8b95a5]">
                                      <span>Start</span>
                                      <input
                                        type="number"
                                        step="0.1"
                                        min={0}
                                        max={project.targetDurationSec}
                                        value={editStartVal}
                                        onChange={(e) => setEditStartVal(e.target.value)}
                                        className="w-16 h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] font-mono-tabular text-xs"
                                      />
                                    </label>
                                    <label className="flex items-center gap-1 text-[#525d6d] dark:text-[#8b95a5]">
                                      <span>End</span>
                                      <input
                                        type="number"
                                        step="0.1"
                                        min={0.2}
                                        max={project.targetDurationSec}
                                        value={editEndVal}
                                        onChange={(e) => setEditEndVal(e.target.value)}
                                        className="w-16 h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] text-[#0e1217] dark:text-[#f1f3f5] font-mono-tabular text-xs"
                                      />
                                    </label>
                                    <div className="flex items-center gap-1">
                                      {[-0.1, 0.1].map((delta) => (
                                        <button
                                          key={delta}
                                          type="button"
                                          onClick={() => {
                                            const maxDur = Math.max(0.5, project.targetDurationSec || 10);
                                            const curS = Number.isFinite(parseFloat(editStartVal))
                                              ? parseFloat(editStartVal)
                                              : sub.startTime;
                                            const curE = Number.isFinite(parseFloat(editEndVal))
                                              ? parseFloat(editEndVal)
                                              : sub.endTime;
                                            const dur = Math.max(0.2, curE - curS);
                                            const nextS = Math.max(0, Math.min(maxDur - dur, curS + delta));
                                            const nextE = Math.min(maxDur, nextS + dur);
                                            setEditStartVal(nextS.toFixed(1));
                                            setEditEndVal(nextE.toFixed(1));
                                            onUpdateSubtitleTiming(sub.id, nextS, nextE);
                                          }}
                                          className="h-6 px-1.5 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] font-mono-tabular text-[11px] text-[#0e1217] dark:text-[#f1f3f5] hover:bg-[#eceff3] dark:hover:bg-[#1e242e] cursor-pointer transition-colors"
                                        >
                                          {delta > 0 ? `+${delta}s` : `${delta}s`}
                                        </button>
                                      ))}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const s = parseFloat(editStartVal);
                                          const en = parseFloat(editEndVal);
                                          if (Number.isFinite(s) && Number.isFinite(en)) {
                                            onUpdateSubtitleTiming(sub.id, s, en);
                                          }
                                          setEditingTimeId(null);
                                        }}
                                        className="h-6 px-2 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#061412] text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                                      >
                                        <Check className="w-3 h-3" />
                                        <span>Apply</span>
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {editSettings.showThaiScript && (
                                  <input
                                    type="text"
                                    value={sub.thaiScript}
                                    onChange={(e) => onUpdateSubtitle(sub.id, "thaiScript", e.target.value)}
                                    placeholder="ภาษาไทย..."
                                    aria-label="Thai script"
                                    className="w-full text-[12px] font-medium text-teal-700 dark:text-teal-400 bg-transparent border-b border-transparent focus:border-teal-600 dark:focus:border-teal-400 focus:outline-none py-0.5"
                                  />
                                )}

                                <input
                                  type="text"
                                  value={sub.thaiPhonetic}
                                  onChange={(e) => onUpdateSubtitle(sub.id, "thaiPhonetic", e.target.value)}
                                  placeholder="Thai phonetic..."
                                  aria-label="Thai in English phonetics"
                                  className="w-full text-[13px] font-semibold text-[#0e1217] dark:text-[#f1f3f5] bg-transparent border-b border-transparent focus:border-teal-700 dark:focus:border-teal-400 focus:outline-none py-0.5"
                                />

                                <input
                                  type="text"
                                  value={sub.burmese}
                                  onChange={(e) => onUpdateSubtitle(sub.id, "burmese", e.target.value)}
                                  placeholder="မြန်မာဘာသာပြန်..."
                                  aria-label="Burmese translation"
                                  className="w-full font-myanmar text-[13px] text-[#525d6d] dark:text-[#8b95a5] bg-transparent border-b border-transparent focus:border-teal-700 dark:focus:border-teal-400 focus:outline-none py-0.5"
                                />

                                {isEditingWords && sub.words.length > 0 && (
                                  <div className="mt-2 pt-2 border-t border-[#dde2e9] dark:border-[#242a34] space-y-1.5">
                                    <span className="block text-[11px] font-medium text-[#525d6d] dark:text-[#8b95a5]">
                                      Word-by-Word Burmese Gloss (9:16 Stage)
                                    </span>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                      {sub.words.map((word, wi) => (
                                        <div
                                          key={`${sub.id}-gloss-${wi}`}
                                          className="flex items-center gap-2 px-2 py-1 rounded-sm border border-[#dde2e9] dark:border-[#242a34] bg-[#f5f6f8] dark:bg-[#181c23]"
                                        >
                                          <div className="min-w-0 shrink-0 max-w-[45%]">
                                            <p className="text-[11px] font-semibold text-[#0e1217] dark:text-[#f1f3f5] truncate">
                                              {word.phonetic}
                                            </p>
                                            {word.thai && word.thai !== word.phonetic && (
                                              <p className="text-[10px] text-[#525d6d] dark:text-[#8b95a5] truncate">
                                                {word.thai}
                                              </p>
                                            )}
                                          </div>
                                          <input
                                            type="text"
                                            value={word.burmeseGloss || ""}
                                            onChange={(e) =>
                                              onUpdateWordGloss(sub.id, wi, e.target.value)
                                            }
                                            placeholder="အနက်..."
                                            aria-label={`Burmese gloss for ${word.phonetic}`}
                                            className="flex-1 min-w-0 h-6 px-1.5 rounded-xs border border-[#dde2e9] dark:border-[#242a34] bg-white dark:bg-[#12151a] font-myanmar text-[11px] text-teal-700 dark:text-teal-300 placeholder:text-[#525d6d] dark:placeholder:text-[#8b95a5] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {studioSection === "timeline" && showMobileTimelineTab && (
              <div className="p-3">
                <ProjectTimelineEditor
                  project={project}
                  cutTime={cutTime}
                  subscribeCutTime={subscribeCutTime}
                  isPlaying={isPlaying}
                  isActive={isWorkspaceVisible && activeTab === "studio" && studioSection === "timeline"}
                  onTogglePlay={onTogglePlay}
                  onPause={onPause}
                  onSeek={onSeek}
                  onPlayFromTime={onPlayFromTime}
                  onUpdateScenes={onUpdateProjectScenes}
                  onUpdateSubtitleTiming={onUpdateSubtitleTiming}
                  onRestoreSnapshot={onRestoreProjectSnapshot}
                  onResetTimeline={onResetTimeline}
                  onGoToScenes={() => onChangeStudioSection("clips")}
                />
              </div>
            )}

            {(studioSection === "visual" || studioSection === "audio") && (
              <div className="px-3.5 py-3">
                <VideoEditPanel
                  settings={editSettings}
                  voiceSettings={voiceSettings}
                  sourceType={
                    project?.sourceType ??
                    localMedia?.sourceType ??
                    youtubeMedia?.sourceType ??
                    "local"
                  }
                  sourceDurationSec={
                    project?.targetDurationSec ??
                    (selectedScenes.length > 0
                      ? selectedScenes.reduce(
                          (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
                          0
                        )
                      : localMedia?.durationSec ?? youtubeMedia?.durationSec)
                  }
                  project={project}
                  cutTime={cutTime}
                  isPlaying={isPlaying}
                  isTabActive={isWorkspaceVisible && activeTab === "studio"}
                  timelineDirty={timelineDirty}
                  activeSection={studioSection}
                  hideTabStrip
                  hideTimeline
                  onChange={onChangeEditSettings}
                  onChangeVoiceSettings={onChangeVoiceSettings}
                  onTogglePlay={onTogglePlay}
                  onPause={onPause}
                  onSeek={onSeek}
                  onPlayFromTime={onPlayFromTime}
                  onUpdateProjectScenes={onUpdateProjectScenes}
                  onUpdateSubtitleTiming={onUpdateSubtitleTiming}
                  onRestoreProjectSnapshot={onRestoreProjectSnapshot}
                  onResetTimeline={onResetTimeline}
                  onGoToScenes={() => onChangeStudioSection("clips")}
                />
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
