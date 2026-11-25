import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  AlertTriangle,
  BookOpen,
  Captions,
  Check,
  ClipboardPaste,
  Clock,
  Copy,
  Download,
  FileText,
  Film,
  Loader2,
  LocateFixed,
  Merge,
  Mic,
  MoreHorizontal,
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
  SubtitleGenerationProgress,
  SubtitleItem,
  TranslationTone,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "../types";
import { ScenePicker } from "./ScenePicker";
import { PreGenerateBar } from "./PreGenerateBar";
import { UploadHeader } from "./UploadHeader";
import { YouTubePreviewPanel } from "./YouTubePreviewPanel";
import { VideoEditPanel, getVideoEditDirtyMap } from "./VideoEditPanel";
import { ProjectTimelineEditor } from "./ProjectTimelineEditor";
import { SubtitleStylePanel } from "./SubtitleStylePanel";
import {
  boundsValueToScale,
  DEFAULT_STAGE_PREVIEW_SCALE,
  getCompactStageBounds,
  MAX_STAGE_PREVIEW_SCALE,
  scaleToBoundsValue,
} from "./Stage9x16";
import { SavedProjectsPanel } from "./SavedProjectsPanel";
import { PasteTranscriptModal } from "./PasteTranscriptModal";
import {
  SubtitleListViewport,
  type SubtitleListViewportHandle,
} from "./SubtitleListViewport";
import { DEFAULT_VOICE_SETTINGS, getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getSceneDurationSec } from "../utils/projectTimeline";
import { hasGeneratedProject, hasProjectMedia } from "../utils/projectState";
import { UNIFIED_CUT_FLOW } from "../config/flags";
import {
  computeSubtitleQualityMap,
  findUnmatchedSpeechGaps,
  suggestTranscribeRange,
  type AutoFollowState,
  type SubtitleQualityIssue,
} from "../utils/subtitleState";
import type { CutSpeechRegion } from "../utils/audioSpeechAnalyzer";
import { DEFAULT_VIDEO_EDIT } from "../utils/videoFilters";
import {
  buildAiChatTranscriptContent,
  buildSrtContent,
  buildStudyTextContent,
  buildVttContent,
  downloadTextFile,
  makeSafeFileSlug,
} from "../utils/exportSubtitles";

const NOOP_RESTORE_SNAPSHOT = () => {};

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
  onRestoreProjectSnapshot?: (scenes: SpeakingScene[], subtitles?: SubtitleItem[]) => void;
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
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
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
  onRetranslateAll: (tone: TranslationTone, options?: { skipManuallyEdited?: boolean }) => void;
  onCancelRetranslateAll?: () => void;
  regeneratingSubIds?: string[];
  retranslatingSubIds?: string[];
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
  selectedSubtitleId?: string | null;
  onSelectSubtitle?: (id: string | null) => void;
  captionTab?: "script" | "style" | "sync";
  onChangeCaptionTab?: (tab: "script" | "style" | "sync") => void;
  isSubtitleSearchOpen?: boolean;
  onChangeSubtitleSearchOpen?: (open: boolean) => void;
  autoFollowState?: AutoFollowState;
  onChangeAutoFollowState?: (next: AutoFollowState) => void;
  stageSelectRequest?: { id: string; focusPhonetic?: boolean; nonce: number } | null;
  cutSpeechRegions?: CutSpeechRegion[];
  onUpdateWordChip?: (
    subId: string,
    wordIndex: number,
    patch: { phonetic?: string; thai?: string; burmeseGloss?: string }
  ) => void;
  onMergeWordChips?: (subId: string, leftIndex: number) => void;
  onSplitWordChip?: (
    subId: string,
    wordIndex: number,
    partA: string,
    partB: string,
    partAGloss?: string,
    partBGloss?: string
  ) => void;
  onFillMissingGlosses?: (subIds: string[]) => void;
  onTranscribeRange?: (
    startSec: number,
    endSec: number
  ) => Promise<{ addedCount: number; message?: string } | void>;
  transcribingRange?: { startSec: number; endSec: number } | null;
  onApplyPasteTranscriptSync?: (nextSubtitles: SubtitleItem[], changedCount: number) => void;
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
  canUndo: canUndoProp,
  canRedo: canRedoProp,
  onUndo: onUndoProp,
  onRedo: onRedoProp,
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
  retranslatingSubIds = [],
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
  selectedSubtitleId: controlledSelectedSubId,
  onSelectSubtitle,
  captionTab: controlledCaptionTab,
  onChangeCaptionTab,
  isSubtitleSearchOpen: controlledSearchOpen,
  onChangeSubtitleSearchOpen,
  autoFollowState: controlledAutoFollow,
  onChangeAutoFollowState,
  stageSelectRequest = null,
  cutSpeechRegions = [],
  onUpdateWordChip,
  onMergeWordChips,
  onSplitWordChip,
  onFillMissingGlosses,
  onTranscribeRange,
  transcribingRange = null,
  onApplyPasteTranscriptSync,
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
    startHeightPx: number;
    minHeightPx: number;
    defaultHeightPx: number;
    maxHeightPx: number;
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
  const [rangeFeedback, setRangeFeedback] = useState<{
    type: "info" | "error";
    text: string;
  } | null>(null);
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [editStartVal, setEditStartVal] = useState("");
  const [editEndVal, setEditEndVal] = useState("");
  const [localSelectedSubId, setLocalSelectedSubId] = useState<string | null>(null);
  const [localCaptionTab, setLocalCaptionTab] = useState<"script" | "style" | "sync">("script");
  const [aiPopoverId, setAiPopoverId] = useState<string | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);
  const [hintDrafts, setHintDrafts] = useState<Record<string, string>>({});
  const [collapsedWordBarSubIds, setCollapsedWordBarSubIds] = useState<Record<string, boolean>>({});
  const [activeWordChip, setActiveWordChip] = useState<{
    subId: string;
    wordIndex: number;
  } | null>(null);
  const [chipPhoneticDraft, setChipPhoneticDraft] = useState("");
  const [chipThaiDraft, setChipThaiDraft] = useState("");
  const [chipGlossDraft, setChipGlossDraft] = useState("");
  const [chipSplitMode, setChipSplitMode] = useState(false);
  const [chipSplitA, setChipSplitA] = useState("");
  const [chipSplitB, setChipSplitB] = useState("");
  const [qualityFilter, setQualityFilter] = useState<"all" | SubtitleQualityIssue>("all");
  const [confirmQualityAction, setConfirmQualityAction] = useState<"resync" | "gloss" | null>(
    null
  );

  // Subtitle Search / Find-Replace, Tone Confirmation & Multi-format Export
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [localAutoFollow, setLocalAutoFollow] = useState<AutoFollowState>("following");
  const [subSearchQuery, setSubSearchQuery] = useState("");
  const [showReplaceRow, setShowReplaceRow] = useState(false);
  const [subReplaceText, setSubReplaceText] = useState("");
  const [subReplaceField, setSubReplaceField] = useState<
    "all" | "burmese" | "thaiPhonetic" | "thaiScript"
  >("all");
  const [replaceFeedback, setReplaceFeedback] = useState<string | null>(null);
  const [showToneConfirm, setShowToneConfirm] = useState(false);
  const [skipManualOnToneApply, setSkipManualOnToneApply] = useState(true);
  const [showResyncConfirm, setShowResyncConfirm] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [showPasteSyncModal, setShowPasteSyncModal] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const aiPopoverRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const timePopoverRef = useRef<HTMLDivElement | null>(null);
  const wordChipPopoverRef = useRef<HTMLDivElement | null>(null);
  const subSearchInputRef = useRef<HTMLInputElement | null>(null);
  const subCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const subtitleViewportRef = useRef<SubtitleListViewportHandle | null>(null);
  const selectedPhoneticInputRef = useRef<HTMLInputElement | null>(null);
  const suppressNextFocusPauseRef = useRef(false);

  const suggestChipSplitParts = useCallback((phonetic: string): [string, string] => {
    const clean = phonetic.trim();
    if (!clean) return ["", ""];
    const spaceParts = clean.split(/\s+/).filter(Boolean);
    if (spaceParts.length >= 2) {
      const mid = Math.max(1, Math.floor(spaceParts.length / 2));
      return [spaceParts.slice(0, mid).join(" "), spaceParts.slice(mid).join(" ")];
    }
    const hyphenParts = clean.split("-").filter(Boolean);
    if (hyphenParts.length >= 2) {
      const mid = Math.max(1, Math.floor(hyphenParts.length / 2));
      return [hyphenParts.slice(0, mid).join("-"), hyphenParts.slice(mid).join("-")];
    }
    const chars = Array.from(clean);
    if (chars.length < 2) return [clean, clean];
    const cut = Math.max(1, Math.floor(chars.length / 2));
    return [chars.slice(0, cut).join(""), chars.slice(cut).join("")];
  }, []);

  const qualityMap = useMemo(
    () =>
      computeSubtitleQualityMap(project?.subtitles ?? [], {
        cutSpeechRegions,
        showWordGloss: editSettings.showWordGloss,
      }),
    [project?.subtitles, cutSpeechRegions, editSettings.showWordGloss]
  );

  const qualitySummary = useMemo(() => {
    const subs = project?.subtitles ?? [];
    let overlapCount = 0;
    let tooFastCount = 0;
    let silentMismatchCount = 0;
    let missingGlossCount = 0;
    const missingGlossSubIds: string[] = [];
    for (const sub of subs) {
      const flags = qualityMap[sub.id];
      if (!flags) continue;
      if (flags.overlap) overlapCount++;
      if (flags.too_fast) tooFastCount++;
      if (flags.silent_mismatch) silentMismatchCount++;
      if (flags.missing_gloss) {
        missingGlossCount++;
        missingGlossSubIds.push(sub.id);
      }
    }
    return {
      overlapCount,
      tooFastCount,
      silentMismatchCount,
      missingGlossCount,
      missingGlossSubIds,
      totalFlagged:
        overlapCount + tooFastCount + silentMismatchCount + missingGlossCount,
    };
  }, [project?.subtitles, qualityMap]);

  const unmatchedSpeechGaps = useMemo(
    () =>
      project
        ? findUnmatchedSpeechGaps(project.subtitles, cutSpeechRegions, project.targetDurationSec)
        : [],
    [project, cutSpeechRegions]
  );

  useEffect(() => {
    if (qualityFilter === "all") return;
    if (
      (qualityFilter === "overlap" && qualitySummary.overlapCount === 0) ||
      (qualityFilter === "too_fast" && qualitySummary.tooFastCount === 0) ||
      (qualityFilter === "silent_mismatch" && qualitySummary.silentMismatchCount === 0) ||
      (qualityFilter === "missing_gloss" && qualitySummary.missingGlossCount === 0)
    ) {
      setQualityFilter("all");
    }
  }, [qualityFilter, qualitySummary]);

  const selectedSubtitleId =
    controlledSelectedSubId !== undefined ? controlledSelectedSubId : localSelectedSubId;
  const setSelectedSubtitleId = useCallback(
    (id: string | null) => {
      if (onSelectSubtitle) {
        onSelectSubtitle(id);
      } else {
        setLocalSelectedSubId(id);
      }
    },
    [onSelectSubtitle]
  );

  const captionTab = controlledCaptionTab ?? localCaptionTab;
  const setCaptionTab = useCallback(
    (tab: "script" | "style" | "sync") => {
      if (onChangeCaptionTab) {
        onChangeCaptionTab(tab);
      } else {
        setLocalCaptionTab(tab);
      }
    },
    [onChangeCaptionTab]
  );

  const isSearchOpen = controlledSearchOpen ?? localSearchOpen;
  const setIsSearchOpen = useCallback(
    (open: boolean) => {
      if (onChangeSubtitleSearchOpen) {
        onChangeSubtitleSearchOpen(open);
      } else {
        setLocalSearchOpen(open);
      }
    },
    [onChangeSubtitleSearchOpen]
  );

  const autoFollowState = controlledAutoFollow ?? localAutoFollow;
  const setAutoFollowState = useCallback(
    (next: AutoFollowState) => {
      if (onChangeAutoFollowState) {
        onChangeAutoFollowState(next);
      } else {
        setLocalAutoFollow(next);
      }
    },
    [onChangeAutoFollowState]
  );
  const autoFollowStateRef = useRef(autoFollowState);
  autoFollowStateRef.current = autoFollowState;

  const [livePlayingSubId, setLivePlayingSubId] = useState<string | null>(() =>
    project ? findActiveSubtitle(project.subtitles, cutTime)?.id ?? null : null
  );
  const projectSubtitlesRef = useRef(project?.subtitles ?? []);
  projectSubtitlesRef.current = project?.subtitles ?? [];

  useEffect(() => {
    const subs = project?.subtitles ?? [];
    setLivePlayingSubId(findActiveSubtitle(subs, cutTime)?.id ?? null);
  }, [project?.subtitles, cutTime]);

  useEffect(() => {
    if (!subscribeCutTime) return;
    return subscribeCutTime((sec) => {
      const nextId = findActiveSubtitle(projectSubtitlesRef.current, sec)?.id ?? null;
      setLivePlayingSubId((cur) => (cur === nextId ? cur : nextId));
    });
  }, [subscribeCutTime]);

  useEffect(() => {
    if (!selectedSubtitleId && autoFollowStateRef.current === "paused_by_editing") {
      setAutoFollowState("following");
    }
    if (editingTimeId && editingTimeId !== selectedSubtitleId) {
      setEditingTimeId(null);
    }
    if (aiPopoverId && aiPopoverId !== selectedSubtitleId) {
      setAiPopoverId(null);
    }
    if (moreMenuId && moreMenuId !== selectedSubtitleId) {
      setMoreMenuId(null);
    }
    if (activeWordChip && activeWordChip.subId !== selectedSubtitleId) {
      setActiveWordChip(null);
      setChipSplitMode(false);
    }
  }, [selectedSubtitleId, editingTimeId, aiPopoverId, moreMenuId, activeWordChip, setAutoFollowState]);

  useEffect(() => {
    if (!stageSelectRequest) return;
    if (studioSection !== "captions" || captionTab !== "script") return;
    if (subSearchQuery.trim()) {
      setSubSearchQuery("");
    }
    if (qualityFilter !== "all") {
      setQualityFilter("all");
    }
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        subtitleViewportRef.current?.scrollToSubtitle(stageSelectRequest.id, "smooth");
        if (stageSelectRequest.focusPhonetic && selectedPhoneticInputRef.current) {
          suppressNextFocusPauseRef.current = true;
          selectedPhoneticInputRef.current.focus({ preventScroll: true });
        }
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf) cancelAnimationFrame(innerRaf);
    };
  }, [stageSelectRequest, studioSection, captionTab, subSearchQuery, qualityFilter]);

  const handleExpandedCardFocusCapture = useCallback(
    (e: ReactFocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      if (suppressNextFocusPauseRef.current) {
        suppressNextFocusPauseRef.current = false;
        return;
      }
      if (autoFollowStateRef.current === "following") {
        setAutoFollowState("paused_by_editing");
      }
    },
    [setAutoFollowState]
  );

  const handleExpandedCardInputActivity = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      if (autoFollowStateRef.current === "following") {
        setAutoFollowState("paused_by_editing");
      }
    },
    [setAutoFollowState]
  );

  const handleExpandedCardBlurCapture = useCallback(
    (e: ReactFocusEvent<HTMLDivElement>) => {
      const cardEl = e.currentTarget;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const stillEditing = Boolean(
          active &&
            cardEl.contains(active) &&
            (active.tagName === "INPUT" ||
              active.tagName === "TEXTAREA" ||
              active.tagName === "SELECT")
        );
        if (!stillEditing && autoFollowStateRef.current === "paused_by_editing") {
          setAutoFollowState("following");
        }
      });
    },
    [setAutoFollowState]
  );

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
    if (!aiPopoverId && !moreMenuId && !editingTimeId && !activeWordChip) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (aiPopoverId && aiPopoverRef.current && !aiPopoverRef.current.contains(target)) {
        setAiPopoverId(null);
      }
      if (moreMenuId && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuId(null);
      }
      if (editingTimeId && timePopoverRef.current && !timePopoverRef.current.contains(target)) {
        setEditingTimeId(null);
      }
      if (
        activeWordChip &&
        wordChipPopoverRef.current &&
        !wordChipPopoverRef.current.contains(target)
      ) {
        setActiveWordChip(null);
        setChipSplitMode(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAiPopoverId(null);
        setMoreMenuId(null);
        setEditingTimeId(null);
        setActiveWordChip(null);
        setChipSplitMode(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [aiPopoverId, moreMenuId, editingTimeId, activeWordChip]);

  useEffect(() => {
    if (
      !isWorkspaceVisible ||
      activeTab !== "studio" ||
      studioSection !== "captions" ||
      !hasGeneratedProject(project) ||
      captionTab !== "script"
    ) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f" &&
        !isSearchOpen
      ) {
        e.preventDefault();
        setIsSearchOpen(true);
        requestAnimationFrame(() => {
          subSearchInputRef.current?.focus();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isWorkspaceVisible, activeTab, studioSection, project, captionTab, isSearchOpen]);

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
  const clampedClipsScale = Math.max(0, Math.min(MAX_STAGE_PREVIEW_SCALE, effectiveClipsScale));
  const clipsWidthPx = scaleToBoundsValue(
    clampedClipsScale,
    compactBounds.minWidthPx,
    compactBounds.defaultWidthPx,
    compactBounds.maxWidthPx
  );
  const clipsHeightPx = scaleToBoundsValue(
    clampedClipsScale,
    compactBounds.minHeightPx,
    compactBounds.defaultHeightPx,
    compactBounds.maxHeightPx
  );
  const isClipsFullWidth =
    clampedClipsScale >= 1.999 && compactBounds.maxWidthPx >= compactBounds.availWidth;
  const clipsScaleLabel =
    clampedClipsScale < 0.35
      ? "Small"
      : clampedClipsScale < 0.85
        ? "Medium"
        : clampedClipsScale <= 1.15
          ? "Normal"
          : "Large";

  const applyClipsDragClientY = (clientY: number) => {
    const active = clipsDragStartRef.current;
    if (!active) return;
    const dy = clientY - active.startY;
    const nextScale = boundsValueToScale(
      active.startHeightPx + dy,
      active.minHeightPx,
      active.defaultHeightPx,
      active.maxHeightPx
    );
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
      startHeightPx: clipsHeightPx,
      minHeightPx: compactBounds.minHeightPx,
      defaultHeightPx: compactBounds.defaultHeightPx,
      maxHeightPx: compactBounds.maxHeightPx,
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
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
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
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
    beginClipsDragSession(e.touches[0].clientY, "touch", null);
  };

  const handleClipsDragDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input")) return;
    const isDefault = Math.abs(clampedClipsScale - DEFAULT_STAGE_PREVIEW_SCALE) < 0.03;
    updateClipsScale(isDefault ? 0.5 : DEFAULT_STAGE_PREVIEW_SCALE);
  };

  const handleClipsDragKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      updateClipsScale(Math.max(0, Number((clampedClipsScale - 0.05).toFixed(2))));
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      updateClipsScale(
        Math.min(MAX_STAGE_PREVIEW_SCALE, Number((clampedClipsScale + 0.05).toFixed(2)))
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      updateClipsScale(0);
    } else if (e.key === "End") {
      e.preventDefault();
      updateClipsScale(MAX_STAGE_PREVIEW_SCALE);
    } else if (e.key === "0" || e.key === "Enter") {
      e.preventDefault();
      updateClipsScale(DEFAULT_STAGE_PREVIEW_SCALE);
    }
  };

  const jumpToActiveSubtitle = () => {
    if (!hasGeneratedProject(project) || project.subtitles.length === 0) return;
    const target =
      findActiveSubtitle(project.subtitles, cutTime) ||
      project.subtitles.find((s) => s.startTime >= cutTime) ||
      project.subtitles[0];
    if (!target) return;
    if (autoFollowState === "paused_by_scroll") {
      setAutoFollowState("following");
    }
    if (subtitleViewportRef.current) {
      subtitleViewportRef.current.scrollToSubtitle(target.id, "smooth");
    } else {
      const el = subCardRefs.current[target.id];
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  const openAddSubtitleForm = () => {
    if (!hasGeneratedProject(project)) return;
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);
    const suggested = suggestTranscribeRange(
      project.subtitles,
      cutSpeechRegions,
      cutTime,
      maxDur
    );
    setNewSubStart(suggested.startSec.toFixed(1));
    setNewSubEnd(suggested.endSec.toFixed(1));
    setNewSubPhonetic("");
    setNewSubBurmese("");
    setRangeFeedback(null);
    setShowAddSub(true);
  };

  const triggerRangeTranscription = async (startSec: number, endSec: number) => {
    if (!onTranscribeRange || transcribingRange) return;
    setRangeFeedback(null);
    const res = await onTranscribeRange(startSec, endSec);
    if (res && res.addedCount > 0) {
      setShowAddSub(false);
      setRangeFeedback(null);
    } else if (res && res.message) {
      setRangeFeedback({ type: "info", text: res.message });
    }
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
      count: !hasGeneratedProject(project) && selectedScenes.length > 0 ? selectedScenes.length : undefined,
    },
    {
      id: "captions",
      label: "Captions",
      icon: Captions,
      count: hasGeneratedProject(project) ? project.subtitles.length : undefined,
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

  const hasStudioVideo = Boolean(localMedia || hasProjectMedia(project));
  const isStudioView = activeTab === "studio";

  const rawTargetDuration =
    hasGeneratedProject(project) &&
    typeof project.targetDurationSec === "number" &&
    Number.isFinite(project.targetDurationSec)
      ? Math.max(0, project.targetDurationSec)
      : 0;
  const rawHeaderSpeed = hasGeneratedProject(project)
    ? getEffectivePlaybackSpeed(
        project.sourceType,
        editSettings.playbackSpeed,
        voiceSettings.speed
      )
    : 1;
  const studioHeaderDuration = hasGeneratedProject(project)
    ? Math.round(rawTargetDuration / (rawHeaderSpeed > 0 ? rawHeaderSpeed : 1))
    : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Inline Stage directly on top in compact mobile/tablet Studio view */}
      {(inlineStage || isMobileStudio) && (
        <div
          ref={mobileStageWrapperRef}
          className={
            isStudioView
              ? "bg-[#dfe5f4] dark:bg-[#04050e] shrink-0"
              : "hidden"
          }
        >
          {inlineStage && (
            <div
              className={
                !UNIFIED_CUT_FLOW && isMobileStudio && studioSection === "clips"
                  ? "hidden"
                  : "pt-2.5 w-full flex justify-center"
              }
            >
              {inlineStage}
            </div>
          )}
          {!UNIFIED_CUT_FLOW && isMobileStudio && (
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
                aria-label="Resize 16:9 preview (drag up to shrink, down to enlarge, double-click for 100%)"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={200}
                aria-valuenow={Math.round(clampedClipsScale * 100)}
                title="Drag up to shrink · Drag down to enlarge (up to 200%) · Double-click for 100%"
                onPointerDown={handleClipsDragPointerDown}
                onTouchStart={handleClipsDragTouchStart}
                onDoubleClick={handleClipsDragDoubleClick}
                onKeyDown={handleClipsDragKeyDown}
                className="relative group w-full h-6 shrink-0 flex items-center justify-center cursor-ns-resize touch-none select-none border-b border-[#d2dcf0] dark:border-[#21284c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400"
              >
                <span
                  className={`h-1 rounded-full transition-all ${
                    isClipsResizing
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
                    updateClipsScale(DEFAULT_STAGE_PREVIEW_SCALE);
                  }}
                  title="Reset preview size to 100%"
                  className={`absolute right-3 text-[10px] font-mono-tabular transition-colors cursor-pointer ${
                    Math.abs(clampedClipsScale - DEFAULT_STAGE_PREVIEW_SCALE) >= 0.02
                      ? "text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                      : "text-[#64748b] dark:text-[#7c89b0]"
                  }`}
                >
                  {Math.round(clampedClipsScale * 100)}%
                </button>
                {isClipsResizing && (
                  <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918] text-[10px] font-mono-tabular font-semibold whitespace-nowrap shadow-sm">
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
            <div className="px-3.5 py-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] flex items-center justify-between gap-3 text-xs sm:text-sm text-[#0c1026] dark:text-[#f3f5fc]">
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
                    <Search className="w-4 h-4 text-[#4d597d] dark:text-[#919ec4] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
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
                    } text-[13px] rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d]/75 dark:placeholder:text-[#919ec4]/75 focus:outline-none focus:border-teal-700 dark:focus:border-teal-400 transition-colors [&::-webkit-search-cancel-button]:hidden`}
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={onClearSearch}
                      aria-label="Clear search"
                      className="w-7 h-7 rounded flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-white absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer"
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
                        ? "text-[#0c1026] dark:text-[#f3f5fc]"
                        : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
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
                          ? "bg-teal-700 border-teal-700 text-white dark:bg-teal-400 dark:border-teal-400 dark:text-[#060918]"
                          : "bg-white dark:bg-[#0d1022] border-[#b8c2d0] dark:border-[#3b4554]"
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
                      className="h-9 inline-flex items-center p-0.5 rounded-md bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c] shrink-0"
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
                                ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 font-semibold shadow-xs"
                                : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
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
                        className="h-9 px-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] text-xs font-medium text-teal-700 dark:text-teal-400 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
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
                          className="h-9 w-9 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
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
                  <div className="flex items-center justify-between text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                    <span className="font-display font-semibold uppercase tracking-wider text-[#0c1026] dark:text-[#f3f5fc] truncate">
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
                    <div className="rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] divide-y divide-[#d2dcf0] dark:divide-[#21284c] overflow-hidden">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div
                          key={i}
                          className="p-2.5 flex flex-col sm:flex-row gap-3 animate-pulse"
                        >
                          <div className="aspect-video w-full sm:w-32 sm:shrink-0 rounded-sm bg-[#e7ecf8] dark:bg-[#141933]" />
                          <div className="flex-1 py-1 space-y-2">
                            <div className="h-3.5 bg-[#e7ecf8] dark:bg-[#141933] rounded w-5/6" />
                            <div className="h-3 bg-[#e7ecf8] dark:bg-[#141933] rounded w-1/2" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : videos.length === 0 ? (
                    <div className="py-10 flex flex-col items-center justify-center text-center text-[#4d597d] dark:text-[#919ec4] rounded-md border border-dashed border-[#bcc9e6] dark:border-[#2e3644] bg-white dark:bg-[#0d1022] p-6">
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
                      <div className="rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] divide-y divide-[#d2dcf0] dark:divide-[#21284c] overflow-hidden">
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
                                  : "border-l-transparent hover:bg-[#f3f5fc] dark:hover:bg-[#141933]"
                              }`}
                            >
                              <div className="relative w-full sm:w-32 aspect-video rounded-sm bg-[#e7ecf8] dark:bg-[#141933] overflow-hidden shrink-0">
                                <img
                                  src={v.thumbnail}
                                  alt={v.title}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                                />
                                <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded-xs bg-[#04050e]/90 text-white text-[10px] font-mono-tabular">
                                  {v.durationText}
                                </span>
                              </div>

                              <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                                <p className="text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] line-clamp-2 leading-snug">
                                  {v.title}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[#4d597d] dark:text-[#919ec4]">
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
                            className="h-8 px-3.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors"
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
            ? "flex-1 min-h-0 flex flex-col bg-white dark:bg-[#0d1022] overflow-hidden"
            : "hidden"
        }
      >
          {/* Single Edge-to-Edge Studio Underline Tab Bar */}
          <div className="h-10 shrink-0 px-3.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/70 flex items-center justify-between gap-2">
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
                        ? "border-transparent text-[#4d597d]/45 dark:text-[#919ec4]/40 font-medium opacity-45 cursor-not-allowed"
                        : active
                          ? "border-teal-700 dark:border-teal-400 text-[#0c1026] dark:text-[#f3f5fc] font-semibold cursor-pointer"
                          : "border-transparent text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] font-medium cursor-pointer"
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
                    className="text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-teal-700 dark:hover:text-teal-400 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span className="hidden sm:inline">Reset All</span>
                  </button>
                )}

              {hasGeneratedProject(project) && (
                <span className="text-[11px] text-[#4d597d] dark:text-[#919ec4] font-mono-tabular whitespace-nowrap">
                  {`${project.scenes.length} · ${studioHeaderDuration}s`}
                </span>
              )}
            </div>
          </div>

          {/* Flat Edge-to-Edge Studio Body */}
          <div
            className={
              studioSection === "captions" && hasGeneratedProject(project) && captionTab === "script"
                ? "flex-1 min-h-0 flex flex-col overflow-hidden"
                : "flex-1 overflow-y-auto overscroll-y-contain studio-scrollbar min-h-0"
            }
          >
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
                <div className="px-3.5 py-2.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] space-y-2 text-xs text-[#0c1026] dark:text-[#f3f5fc]">
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

                  <div className="w-full h-1 rounded-full bg-[#d2dcf0] dark:bg-[#21284c] overflow-hidden">
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
                        <span className="text-[#919ec4]">→</span>
                      </>
                    )}
                    {steps.map((step, sIdx) => {
                      const done = currentRank > sIdx;
                      const active = currentRank === sIdx;
                      return (
                        <span key={step.id} className="inline-flex items-center gap-1.5">
                          {sIdx > 0 && <span className="text-[#919ec4]">→</span>}
                          <span
                            className={
                              active
                                ? "text-teal-700 dark:text-teal-400 font-semibold"
                                : done
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-[#4d597d] dark:text-[#919ec4]"
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

            {UNIFIED_CUT_FLOW ? (
              studioSection === "clips" && (
                <div className="px-3.5 py-3 flex flex-col gap-4 pb-6">
                  {localMedia ? (
                    <>
                      <UploadHeader
                        title={localMedia.title}
                        durationSec={localMedia.durationSec}
                        onClearVideo={onClearLocalVideo}
                      />
                      <PreGenerateBar
                        scenes={selectedScenes}
                        isProcessing={isProcessing}
                        generationProgress={generationProgress}
                        translationTone={editSettings.translationTone}
                        onChangeTranslationTone={(tone) =>
                          onChangeEditSettings({ ...editSettings, translationTone: tone })
                        }
                        onGenerate={onGenerateSubtitles}
                        regeneratingClipId={regeneratingClipId}
                      />
                      {isMobileStudio && (
                        <ProjectTimelineEditor
                          project={project}
                          cutTime={cutTime}
                          subscribeCutTime={subscribeCutTime}
                          isPlaying={isPlaying}
                          isActive={isWorkspaceVisible && isStudioView && studioSection === "clips"}
                          onTogglePlay={onTogglePlay}
                          onPause={onPause}
                          onSeek={onSeek}
                          onPlayFromTime={onPlayFromTime}
                          onUpdateScenes={onUpdateProjectScenes}
                          onUpdateSubtitleTiming={onUpdateSubtitleTiming}
                          onShiftAllSubtitles={onShiftAllSubtitles}
                          onUndo={onUndoProp ?? onUndoSubtitles}
                          onRedo={onRedoProp ?? onRedoSubtitles}
                          canUndo={canUndoProp ?? canUndoSubtitles}
                          canRedo={canRedoProp ?? canRedoSubtitles}
                          onResetTimeline={onResetTimeline}
                          onGoToScenes={() => onChangeStudioSection("clips")}
                          cutSpeechRegions={cutSpeechRegions}
                          onTranscribeRange={onTranscribeRange}
                          transcribingRange={transcribingRange}
                          clipSubtitleCounts={clipSubtitleCounts}
                          regeneratingClipId={regeneratingClipId}
                          regeneratingClipPercent={regeneratingClipPercent}
                          onGenerateSingleClip={onGenerateSingleClip}
                          isBusy={isProcessing}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <div className="rounded-lg border border-dashed border-[#bcc9e6] dark:border-[#21284c] bg-[#e7ecf8]/50 dark:bg-[#141933]/40 p-4 text-center space-y-1">
                        <p className="font-display text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                          Upload a local video on the 9:16 Stage
                        </p>
                        <p className="text-[11px] text-[#4d597d] dark:text-[#919ec4]">
                          Click or drop a video file on the 9:16 preview to cut clips and generate subtitles.
                        </p>
                      </div>
                      <PreGenerateBar
                        scenes={[]}
                        isProcessing={isProcessing}
                        generationProgress={generationProgress}
                        translationTone={editSettings.translationTone}
                        onChangeTranslationTone={(tone) =>
                          onChangeEditSettings({ ...editSettings, translationTone: tone })
                        }
                        onGenerate={onGenerateSubtitles}
                        regeneratingClipId={regeneratingClipId}
                      />
                    </>
                  )}
                </div>
              )
            ) : localMedia ? (
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
                  onUndo={onUndoProp ?? onUndoSubtitles}
                  canUndo={canUndoProp ?? canUndoSubtitles}
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
                    onUndo={onUndoProp ?? onUndoSubtitles}
                    canUndo={canUndoProp ?? canUndoSubtitles}
                  />
                </div>
              )
            )}

            {studioSection === "captions" && !hasGeneratedProject(project) && (
              <div className="p-6 text-center space-y-3">
                <div className="w-9 h-9 rounded-md bg-teal-50 dark:bg-teal-950/60 border border-teal-200/70 dark:border-teal-500/25 text-teal-700 dark:text-teal-400 flex items-center justify-center mx-auto">
                  <Captions className="w-4 h-4" />
                </div>
                <div className="space-y-1 max-w-sm mx-auto">
                  <p className="font-display text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    No generated captions yet
                  </p>
                  <p className="text-xs text-[#4d597d] dark:text-[#919ec4] leading-relaxed">
                    Upload a video, cut the clips you want, and generate subtitles in Upload &amp; Cut to edit Thai phonetics, Burmese translations, and styling.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onChangeStudioSection("clips")}
                  className="h-8 px-3.5 rounded-md bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>Upload &amp; Cut</span>
                </button>
              </div>
            )}

            {studioSection === "captions" && hasGeneratedProject(project) && (() => {
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
              const manuallyEditedCount = project.subtitles.filter((s) =>
                Boolean(s.isManuallyEdited)
              ).length;

              return (
                <div
                  className={
                    captionTab === "script"
                      ? "flex-1 min-h-0 flex flex-col overflow-hidden"
                      : "flex flex-col"
                  }
                >
                  {/* Persistent Captions Header: 3-Tab Segmented Control + Undo/Redo + Export */}
                  <div className="shrink-0 px-3.5 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/70 dark:bg-[#070814]/60 flex flex-wrap items-center justify-between gap-2">
                    <div
                      role="tablist"
                      aria-label="Captions inspector tabs"
                      className="inline-flex items-center p-0.5 rounded-sm bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c]"
                    >
                      {(
                        [
                          { id: "script", label: "Script" },
                          { id: "style", label: "Style" },
                          { id: "sync", label: "Sync" },
                        ] as const
                      ).map((tab) => {
                        const active = captionTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => {
                              setCaptionTab(tab.id);
                              setAiPopoverId(null);
                              setMoreMenuId(null);
                            }}
                            className={`px-3 py-1 rounded-xs text-[11px] font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                              active
                                ? "bg-white dark:bg-[#0d1022] text-teal-700 dark:text-teal-400 shadow-xs"
                                : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                            }`}
                          >
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="inline-flex items-center border border-[#d2dcf0] dark:border-[#21284c] rounded-sm overflow-hidden bg-white dark:bg-[#141933]">
                        <button
                          type="button"
                          disabled={!(canUndoProp ?? canUndoSubtitles) || !(onUndoProp ?? onUndoSubtitles)}
                          onClick={onUndoProp ?? onUndoSubtitles}
                          title="Undo edit"
                          aria-label="Undo edit"
                          className="h-7 px-2 flex items-center gap-1 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
                        >
                          <Undo2 className="w-3 h-3" />
                          <span>Undo</span>
                        </button>
                        <button
                          type="button"
                          disabled={!(canRedoProp ?? canRedoSubtitles) || !(onRedoProp ?? onRedoSubtitles)}
                          onClick={onRedoProp ?? onRedoSubtitles}
                          title="Redo edit"
                          aria-label="Redo edit"
                          className="h-7 px-2 flex items-center gap-1 text-[11px] font-medium border-l border-[#d2dcf0] dark:border-[#21284c] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
                        >
                          <Redo2 className="w-3 h-3" />
                          <span>Redo</span>
                        </button>
                      </div>

                      {project.subtitles.length > 0 && (
                        <div ref={exportMenuRef} className="relative">
                          <button
                            type="button"
                            onClick={() => setShowExportMenu((v) => !v)}
                            title="Export .SRT, .VTT, -study.txt or Copy"
                            aria-label="Export captions"
                            className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                          >
                            {copiedTranscript ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                <span className="text-emerald-700 dark:text-emerald-300">Copied</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-3 h-3" />
                                <span>Export</span>
                              </>
                            )}
                          </button>

                          {showExportMenu && (
                            <div className="absolute right-0 mt-1 w-48 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-lg p-1 z-30 space-y-0.5">
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
                                className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                              >
                                <FileText className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
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
                                className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                              >
                                <FileText className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
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
                                className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                              >
                                <BookOpen className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
                                <span>Study Sheet .TXT</span>
                              </button>
                              <div className="my-1 border-t border-[#d2dcf0] dark:border-[#21284c]" />
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(
                                      buildAiChatTranscriptContent(project.title, project.subtitles, exportOpts)
                                    );
                                    setCopiedTranscript(true);
                                    setTimeout(() => setCopiedTranscript(false), 2000);
                                  } catch {
                                    // ignore clipboard permission failure
                                  }
                                  setShowExportMenu(false);
                                }}
                                className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                              >
                                <Sparkles className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400" />
                                <span>Copy for AI Chat</span>
                              </button>
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
                                className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                              >
                                <Copy className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
                                <span>Copy Transcript</span>
                              </button>
                              {onApplyPasteTranscriptSync && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowExportMenu(false);
                                    setShowPasteSyncModal(true);
                                  }}
                                  className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] flex items-center gap-2 cursor-pointer"
                                >
                                  <ClipboardPaste className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400" />
                                  <span>Paste &amp; Sync</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* TAB 1: SCRIPT */}
                  {captionTab === "script" && (
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                      {/* Compact Top Bar: Search Toggle + Tone Selector/Apply + Follow/Jump + Add */}
                      <div className="shrink-0 px-3.5 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/40 dark:bg-[#070814]/40 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              const next = !isSearchOpen;
                              setIsSearchOpen(next);
                              if (next) {
                                requestAnimationFrame(() => subSearchInputRef.current?.focus());
                              }
                            }}
                            title="Search & Replace (Ctrl/Cmd+F)"
                            aria-label="Search subtitles"
                            aria-expanded={isSearchOpen}
                            className={`h-7 w-7 rounded-sm border flex items-center justify-center cursor-pointer transition-colors ${
                              isSearchOpen || subSearchQuery.trim()
                                ? "border-teal-600/80 bg-teal-50/90 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                            }`}
                          >
                            <Search className="w-3.5 h-3.5" />
                          </button>

                          <div className="flex items-center gap-1">
                            <select
                              value={editSettings.translationTone}
                              onChange={(e) =>
                                onChangeEditSettings({
                                  ...editSettings,
                                  translationTone: e.target.value as TranslationTone,
                                })
                              }
                              aria-label="Translation tone"
                              className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                            >
                              {SUBTITLE_TONE_OPTIONS.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  Tone: {opt.label}
                                </option>
                              ))}
                            </select>

                            {project.subtitles.length > 0 && (
                              isRetranslatingAll ? (
                                <div className="inline-flex items-center gap-1">
                                  <span className="h-7 px-2 rounded-sm border border-teal-300 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Applying</span>
                                  </span>
                                  {onCancelRetranslateAll && (
                                    <button
                                      type="button"
                                      onClick={onCancelRetranslateAll}
                                      title="Stop Apply Tone"
                                      aria-label="Stop Apply Tone"
                                      className="h-7 px-2 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
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
                                  onClick={() => {
                                    if (manuallyEditedCount > 0) {
                                      setSkipManualOnToneApply(true);
                                      setShowToneConfirm(true);
                                    } else {
                                      onRetranslateAll(editSettings.translationTone, {
                                        skipManuallyEdited: false,
                                      });
                                    }
                                  }}
                                  title="Apply selected translation tone to subtitles"
                                  className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:text-teal-700 dark:hover:text-teal-400 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  <Sparkles className="w-3 h-3" />
                                  <span>Apply</span>
                                </button>
                              )
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {project.subtitles.length > 0 && (
                            <>
                              <button
                                type="button"
                                aria-pressed={autoFollowState !== "off"}
                                onClick={() => {
                                  if (autoFollowState === "off") {
                                    setAutoFollowState("following");
                                    if (livePlayingSubId) {
                                      requestAnimationFrame(() => {
                                        subtitleViewportRef.current?.scrollToSubtitle(
                                          livePlayingSubId,
                                          "smooth"
                                        );
                                      });
                                    }
                                  } else {
                                    setAutoFollowState("off");
                                  }
                                }}
                                title={
                                  autoFollowState === "off"
                                    ? "Enable Auto-Follow during playback"
                                    : "Auto-Follow enabled (click to turn off)"
                                }
                                className={`h-7 px-2 rounded-sm border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                                  autoFollowState !== "off"
                                    ? "border-teal-600/60 bg-teal-50/80 text-teal-800 dark:border-teal-400/60 dark:bg-teal-950/50 dark:text-teal-200"
                                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                }`}
                              >
                                <span>{autoFollowState === "off" ? "Follow: Off" : "Follow"}</span>
                              </button>
                              <button
                                type="button"
                                onClick={jumpToActiveSubtitle}
                                title="Scroll to currently active subtitle at playhead"
                                aria-label="Jump to active subtitle"
                                className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                              >
                                <LocateFixed className="w-3 h-3" />
                                <span>Jump</span>
                              </button>
                              {onApplyPasteTranscriptSync && (
                                <button
                                  type="button"
                                  onClick={() => setShowPasteSyncModal(true)}
                                  title="Paste AI-edited transcript and sync translations without losing timing"
                                  className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:text-teal-700 dark:hover:text-teal-400 text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
                                >
                                  <ClipboardPaste className="w-3 h-3" />
                                  <span>Paste &amp; Sync</span>
                                </button>
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => (showAddSub ? setShowAddSub(false) : openAddSubtitleForm())}
                            className="h-7 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                          >
                            {showAddSub ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                            <span>{showAddSub ? "Close" : "Add"}</span>
                          </button>
                        </div>
                      </div>

                      {/* Quality Summary, Filter & Explicit Repair Bar */}
                      {project.subtitles.length > 0 &&
                        (qualitySummary.totalFlagged > 0 || qualityFilter !== "all") && (
                          <div className="shrink-0 px-3.5 py-1.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc]/55 dark:bg-[#070814]/55 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex flex-wrap items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setQualityFilter("all")}
                                  className={`h-6 px-2 rounded-sm border text-[11px] font-medium cursor-pointer transition-colors ${
                                    qualityFilter === "all"
                                      ? "border-teal-600/80 bg-teal-50 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200 font-semibold"
                                      : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                  }`}
                                >
                                  All ({project.subtitles.length})
                                </button>
                                {(qualitySummary.overlapCount > 0 ||
                                  qualityFilter === "overlap") && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setQualityFilter((cur) =>
                                        cur === "overlap" ? "all" : "overlap"
                                      )
                                    }
                                    className={`h-6 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                      qualityFilter === "overlap"
                                        ? "border-rose-500 bg-rose-50 text-rose-800 dark:border-rose-400 dark:bg-rose-950/60 dark:text-rose-200 font-semibold"
                                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc]"
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                                    <span>Overlap ({qualitySummary.overlapCount})</span>
                                  </button>
                                )}
                                {(qualitySummary.tooFastCount > 0 ||
                                  qualityFilter === "too_fast") && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setQualityFilter((cur) =>
                                        cur === "too_fast" ? "all" : "too_fast"
                                      )
                                    }
                                    className={`h-6 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                      qualityFilter === "too_fast"
                                        ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200 font-semibold"
                                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc]"
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                    <span>Too Fast ({qualitySummary.tooFastCount})</span>
                                  </button>
                                )}
                                {(qualitySummary.silentMismatchCount > 0 ||
                                  qualityFilter === "silent_mismatch") && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setQualityFilter((cur) =>
                                        cur === "silent_mismatch" ? "all" : "silent_mismatch"
                                      )
                                    }
                                    className={`h-6 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                      qualityFilter === "silent_mismatch"
                                        ? "border-orange-500 bg-orange-50 text-orange-900 dark:border-orange-400 dark:bg-orange-950/60 dark:text-orange-200 font-semibold"
                                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc]"
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                                    <span>Silent ({qualitySummary.silentMismatchCount})</span>
                                  </button>
                                )}
                                {(qualitySummary.missingGlossCount > 0 ||
                                  qualityFilter === "missing_gloss") && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setQualityFilter((cur) =>
                                        cur === "missing_gloss" ? "all" : "missing_gloss"
                                      )
                                    }
                                    className={`h-6 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition-colors ${
                                      qualityFilter === "missing_gloss"
                                        ? "border-sky-500 bg-sky-50 text-sky-900 dark:border-sky-400 dark:bg-sky-950/60 dark:text-sky-200 font-semibold"
                                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc]"
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                                    <span>No Gloss ({qualitySummary.missingGlossCount})</span>
                                  </button>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1">
                                {qualitySummary.overlapCount > 0 && onAutoFixSubtitleTimings && (
                                  <button
                                    type="button"
                                    disabled={isResyncingTimings || isRetranslatingAll}
                                    onClick={onAutoFixSubtitleTimings}
                                    className="h-6 px-2 rounded-sm border border-rose-300 dark:border-rose-700 bg-rose-50/90 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-[11px] font-semibold text-rose-800 dark:text-rose-200 inline-flex items-center gap-1 cursor-pointer disabled:opacity-45"
                                  >
                                    <Wand2 className="w-3 h-3" />
                                    <span>Fix Overlaps (Local)</span>
                                  </button>
                                )}
                                {qualitySummary.silentMismatchCount > 0 && onAiResyncSubtitles && (
                                  <button
                                    type="button"
                                    disabled={isResyncingTimings || isRetranslatingAll}
                                    onClick={() =>
                                      setConfirmQualityAction((cur) =>
                                        cur === "resync" ? null : "resync"
                                      )
                                    }
                                    className="h-6 px-2 rounded-sm border border-orange-300 dark:border-orange-700 bg-orange-50/90 dark:bg-orange-950/50 hover:bg-orange-100 dark:hover:bg-orange-900/60 text-[11px] font-semibold text-orange-800 dark:text-orange-200 inline-flex items-center gap-1 cursor-pointer disabled:opacity-45"
                                  >
                                    <RefreshCw
                                      className={`w-3 h-3 ${isResyncingTimings ? "animate-spin" : ""}`}
                                    />
                                    <span>AI Resync</span>
                                  </button>
                                )}
                                {qualitySummary.missingGlossCount > 0 && onFillMissingGlosses && (
                                  <button
                                    type="button"
                                    disabled={isResyncingTimings || isRetranslatingAll}
                                    onClick={() =>
                                      setConfirmQualityAction((cur) =>
                                        cur === "gloss" ? null : "gloss"
                                      )
                                    }
                                    className="h-6 px-2 rounded-sm border border-sky-300 dark:border-sky-700 bg-sky-50/90 dark:bg-sky-950/50 hover:bg-sky-100 dark:hover:bg-sky-900/60 text-[11px] font-semibold text-sky-800 dark:text-sky-200 inline-flex items-center gap-1 cursor-pointer disabled:opacity-45"
                                  >
                                    <Sparkles className="w-3 h-3" />
                                    <span>Fill Missing Gloss (AI)</span>
                                  </button>
                                )}
                              </div>
                            </div>

                            {confirmQualityAction === "resync" && onAiResyncSubtitles && (
                              <div className="p-2 rounded-sm border border-orange-300/80 dark:border-orange-600/50 bg-orange-50/85 dark:bg-orange-950/40 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                <span className="text-orange-950 dark:text-orange-100">
                                  Re-align subtitle timings to spoken audio via AI ({qualitySummary.silentMismatchCount} mismatch{qualitySummary.silentMismatchCount === 1 ? "" : "es"})?
                                </span>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmQualityAction(null)}
                                    className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isResyncingTimings || isRetranslatingAll}
                                    onClick={() => {
                                      setConfirmQualityAction(null);
                                      onAiResyncSubtitles();
                                    }}
                                    className="h-6 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:text-[#060918] font-semibold cursor-pointer"
                                  >
                                    Confirm AI Resync
                                  </button>
                                </div>
                              </div>
                            )}

                            {confirmQualityAction === "gloss" && onFillMissingGlosses && (
                              <div className="p-2 rounded-sm border border-sky-300/80 dark:border-sky-600/50 bg-sky-50/85 dark:bg-sky-950/40 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                <span className="text-sky-950 dark:text-sky-100">
                                  Fill missing word glosses via AI for {qualitySummary.missingGlossCount}{" "}
                                  {qualitySummary.missingGlossCount === 1 ? "line" : "lines"}?
                                </span>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmQualityAction(null)}
                                    className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isRetranslatingAll || isResyncingTimings}
                                    onClick={() => {
                                      setConfirmQualityAction(null);
                                      onFillMissingGlosses(qualitySummary.missingGlossSubIds);
                                    }}
                                    className="h-6 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:text-[#060918] font-semibold cursor-pointer"
                                  >
                                    Confirm Fill Gloss
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                      {/* Inline Tone Apply Confirmation when manually edited rows exist */}
                      {showToneConfirm && !isRetranslatingAll && manuallyEditedCount > 0 && (
                        <div className="shrink-0 px-3.5 py-2.5 border-b border-teal-200/80 dark:border-teal-500/30 bg-teal-50/70 dark:bg-teal-950/35 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={skipManualOnToneApply}
                                onChange={(e) => setSkipManualOnToneApply(e.target.checked)}
                                className="rounded-xs border-[#bcc9e6] dark:border-[#2f3866] text-teal-700 dark:text-teal-400 focus:ring-teal-600"
                              />
                              <span>
                                Skip manually edited ({manuallyEditedCount}{" "}
                                {manuallyEditedCount === 1 ? "line" : "lines"})
                              </span>
                            </label>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setShowToneConfirm(false)}
                                className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={
                                  skipManualOnToneApply &&
                                  manuallyEditedCount >= project.subtitles.length
                                }
                                onClick={() => {
                                  setShowToneConfirm(false);
                                  onRetranslateAll(editSettings.translationTone, {
                                    skipManuallyEdited: skipManualOnToneApply,
                                  });
                                }}
                                className="h-6 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-[11px] font-semibold disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer transition-colors"
                              >
                                Apply Tone
                              </button>
                            </div>
                          </div>
                          {skipManualOnToneApply &&
                            manuallyEditedCount >= project.subtitles.length && (
                              <p className="text-[11px] text-amber-800 dark:text-amber-200">
                                All lines are manually edited. Uncheck to re-translate them.
                              </p>
                            )}
                        </div>
                      )}

                      {/* Missed Speech Gaps Quick AI Fill Bar */}
                      {unmatchedSpeechGaps.length > 0 && onTranscribeRange && (
                        <div className="shrink-0 px-3.5 py-1.5 border-b border-[#d2dcf0] dark:border-[#21284c] bg-amber-50/70 dark:bg-amber-950/25 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-amber-900 dark:text-amber-200 inline-flex items-center gap-1 shrink-0">
                            <Sparkles className="w-3 h-3" />
                            <span>
                              Missed Speech ({unmatchedSpeechGaps.length}):
                            </span>
                          </span>
                          <div className="flex flex-wrap items-center gap-1">
                            {unmatchedSpeechGaps.slice(0, 6).map((gap) => {
                              const isBusy =
                                Boolean(transcribingRange) &&
                                Math.abs(transcribingRange!.startSec - gap.startSec) < 0.15 &&
                                Math.abs(transcribingRange!.endSec - gap.endSec) < 0.15;
                              return (
                                <button
                                  key={`gap-${gap.startSec}-${gap.endSec}`}
                                  type="button"
                                  disabled={Boolean(transcribingRange) || isResyncingTimings}
                                  onClick={() => {
                                    onSeek(gap.startSec);
                                    void triggerRangeTranscription(gap.startSec, gap.endSec);
                                  }}
                                  title={`AI transcribe missed speech from ${gap.startSec.toFixed(1)}s to ${gap.endSec.toFixed(1)}s`}
                                  className="h-6 px-2 rounded-sm border border-amber-400/80 dark:border-amber-500/50 bg-white/95 dark:bg-[#0d1022] hover:bg-amber-100/80 dark:hover:bg-amber-900/40 text-[11px] font-mono-tabular font-medium text-amber-950 dark:text-amber-100 inline-flex items-center gap-1 cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  {isBusy ? (
                                    <Loader2 className="w-3 h-3 animate-spin text-teal-700 dark:text-teal-400" />
                                  ) : (
                                    <Sparkles className="w-3 h-3 text-teal-700 dark:text-teal-400" />
                                  )}
                                  <span>
                                    {gap.startSec.toFixed(1)}–{gap.endSec.toFixed(1)}s
                                  </span>
                                  <span className="font-sans font-semibold text-teal-700 dark:text-teal-400">
                                    {isBusy ? "Filling..." : "AI Fill"}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Inline Add Subtitle / AI Transcribe Range Form */}
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
                          className="shrink-0 px-3.5 py-3 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#e7ecf8]/60 dark:bg-[#141933] space-y-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-display text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                              Add / AI Transcribe Range
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <label className="flex items-center gap-1 text-[#4d597d] dark:text-[#919ec4]">
                                <span>Start</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  max={project.targetDurationSec}
                                  value={newSubStart}
                                  onChange={(e) => setNewSubStart(e.target.value)}
                                  className="w-16 h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-xs"
                                />
                              </label>
                              <label className="flex items-center gap-1 text-[#4d597d] dark:text-[#919ec4]">
                                <span>End</span>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0.2}
                                  max={project.targetDurationSec}
                                  value={newSubEnd}
                                  onChange={(e) => setNewSubEnd(e.target.value)}
                                  className="w-16 h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-xs"
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
                                className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer whitespace-nowrap transition-colors"
                              >
                                Use playhead
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const maxDur = Math.max(0.5, project.targetDurationSec || 10);
                                  const suggested = suggestTranscribeRange(
                                    project.subtitles,
                                    cutSpeechRegions,
                                    cutTime,
                                    maxDur
                                  );
                                  setNewSubStart(suggested.startSec.toFixed(1));
                                  setNewSubEnd(suggested.endSec.toFixed(1));
                                }}
                                className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer whitespace-nowrap transition-colors"
                              >
                                Nearest gap
                              </button>
                            </div>
                          </div>

                          {onTranscribeRange && (
                            <div className="p-2 rounded-sm border border-teal-300/70 dark:border-teal-500/35 bg-teal-50/75 dark:bg-teal-950/30 flex flex-wrap items-center justify-between gap-2">
                              <span className="text-[11px] text-[#0c1026] dark:text-[#f3f5fc]">
                                Generate Thai & Burmese subtitles directly from audio for this range.
                              </span>
                              <button
                                type="button"
                                disabled={Boolean(transcribingRange) || isResyncingTimings}
                                onClick={() => {
                                  const s = parseFloat(newSubStart);
                                  const en = parseFloat(newSubEnd);
                                  if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s + 0.2) {
                                    setRangeFeedback({
                                      type: "error",
                                      text: "Enter a valid start and end range (at least 0.25s).",
                                    });
                                    return;
                                  }
                                  void triggerRangeTranscription(s, en);
                                }}
                                className="h-7 px-3 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer transition-colors"
                              >
                                {transcribingRange ? (
                                  <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    <span>Transcribing...</span>
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-3.5 h-3.5" />
                                    <span>AI Transcribe Range</span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}

                          {rangeFeedback && (
                            <p
                              className={`text-[11px] px-2 py-1 rounded-sm ${
                                rangeFeedback.type === "error"
                                  ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                                  : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                              }`}
                            >
                              {rangeFeedback.text}
                            </p>
                          )}

                          <div className="space-y-1.5 pt-0.5">
                            <span className="block text-[10px] font-medium uppercase tracking-wide text-[#4d597d] dark:text-[#919ec4]">
                              Or Type Manually
                            </span>
                            <input
                              type="text"
                              value={newSubPhonetic}
                              onChange={(e) => setNewSubPhonetic(e.target.value)}
                              placeholder="Thai phonetic (e.g. Sa-wat-dee khrap)"
                              aria-label="New Thai phonetic subtitle"
                              className="w-full h-8 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                            />

                            <input
                              type="text"
                              value={newSubBurmese}
                              onChange={(e) => setNewSubBurmese(e.target.value)}
                              placeholder="မြန်မာဘာသာပြန်..."
                              aria-label="New Burmese translation subtitle"
                              className="w-full h-8 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] font-myanmar text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                            />
                          </div>

                          <div className="flex items-center justify-end gap-1.5 pt-0.5">
                            <button
                              type="button"
                              onClick={() => setShowAddSub(false)}
                              className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={!newSubPhonetic.trim() && !newSubBurmese.trim()}
                              className="h-7 px-3 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                            >
                              Add Manual Line
                            </button>
                          </div>
                        </form>
                      )}

                      {subtitleRegenError && (
                        <div className="shrink-0 px-3.5 py-2 border-b border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
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

                      <SubtitleListViewport
                        ref={subtitleViewportRef}
                        playingSubtitleId={livePlayingSubId}
                        autoFollowState={autoFollowState}
                        onChangeAutoFollowState={setAutoFollowState}
                      >
                        {/* Sticky Floating Find & Replace Bar */}
                        {isSearchOpen && (
                          <div className="sticky top-0 z-20 px-3.5 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white/95 dark:bg-[#0d1022]/95 backdrop-blur-sm shadow-sm space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <div className="relative flex-1 min-w-0">
                                <Search className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                                <input
                                  ref={subSearchInputRef}
                                  type="text"
                                  value={subSearchQuery}
                                  onChange={(e) => setSubSearchQuery(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      setIsSearchOpen(false);
                                    }
                                  }}
                                  placeholder="Filter or find in phonetic, Thai, Burmese..."
                                  aria-label="Search subtitles"
                                  className="w-full h-7 pl-7 pr-6 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                />
                                {subSearchQuery && (
                                  <button
                                    type="button"
                                    onClick={() => setSubSearchQuery("")}
                                    aria-label="Clear search"
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
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
                                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                }`}
                              >
                                <Replace className="w-3 h-3" />
                                <span>Replace</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setIsSearchOpen(false)}
                                aria-label="Close search bar"
                                className="h-7 w-7 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] flex items-center justify-center cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
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
                                  className="flex-1 min-w-[130px] h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                />
                                <select
                                  value={subReplaceField}
                                  onChange={(e) =>
                                    setSubReplaceField(
                                      e.target.value as "all" | "burmese" | "thaiPhonetic" | "thaiScript"
                                    )
                                  }
                                  aria-label="Target field for replace"
                                  className="h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-[11px] text-[#0c1026] dark:text-[#f3f5fc] cursor-pointer"
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
                                  className="h-7 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap transition-colors"
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

                        {/* Compact Scenes Jump Strip */}
                        {project.scenes.length > 1 && (
                          <div className="px-3.5 py-1.5 border-b border-[#d2dcf0] dark:border-[#21284c] flex flex-wrap items-center gap-1">
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
                                  className={`px-2 py-0.5 rounded-sm text-[11px] font-mono-tabular border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                                    isSceneActive
                                      ? "bg-teal-700 text-white border-teal-700 dark:bg-teal-400 dark:text-[#060918] dark:border-teal-400 font-semibold"
                                      : "bg-[#f3f5fc] dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] border-[#d2dcf0] dark:border-[#21284c] hover:border-[#b4c2e3] dark:hover:border-[#2f3866]"
                                  }`}
                                >
                                  {idx + 1}. {formatRangeSec(sc.startSec)}–{formatRangeSec(sc.endSec)}
                                </button>
                              );
                            })}
                          </div>
                        )}

                      {/* Full-Bleed Hairline Subtitle Rows */}
                      {project.subtitles.length === 0 ? (
                        <div className="p-6 text-center space-y-2.5">
                          <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
                            No subtitles in this video yet.
                          </p>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            {onTranscribeRange && (
                              <button
                                type="button"
                                disabled={Boolean(transcribingRange)}
                                onClick={() => {
                                  const maxDur = Math.max(0.5, project.targetDurationSec || 10);
                                  const suggested = suggestTranscribeRange(
                                    project.subtitles,
                                    cutSpeechRegions,
                                    cutTime,
                                    maxDur
                                  );
                                  void triggerRangeTranscription(
                                    suggested.startSec,
                                    suggested.endSec
                                  );
                                }}
                                className="h-8 px-3.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                              >
                                {transcribingRange ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {transcribingRange ? "Transcribing..." : "AI Transcribe Range"}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={openAddSubtitleForm}
                              className="h-8 px-3.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Add Subtitle</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c] bg-white dark:bg-[#0d1022]">
                          {(() => {
                            const needle = subSearchQuery.trim().toLowerCase();
                            const visibleSubs = project.subtitles.filter((s) => {
                              if (qualityFilter !== "all") {
                                const qf = qualityMap[s.id];
                                if (!qf || !qf[qualityFilter]) return false;
                              }
                              if (!needle) return true;
                              const hay = `${s.thaiPhonetic} ${s.thaiScript} ${s.burmese} ${s.originalSpokenText} ${s.words
                                .map((w) => `${w.phonetic} ${w.burmeseGloss || ""}`)
                                .join(" ")}`.toLowerCase();
                              return hay.includes(needle);
                            });

                            if (visibleSubs.length === 0) {
                              return (
                                <div className="p-6 text-center space-y-2 bg-white dark:bg-[#0d1022]">
                                  <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
                                    {needle
                                      ? `No subtitles match “${subSearchQuery}”.`
                                      : "No subtitles match the selected quality filter."}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSubSearchQuery("");
                                      setQualityFilter("all");
                                    }}
                                    className="text-xs font-medium underline text-teal-700 dark:text-teal-400 cursor-pointer"
                                  >
                                    Clear filter
                                  </button>
                                </div>
                              );
                            }

                            return (
                              <>
                                {(needle || qualityFilter !== "all") && (
                                  <div className="px-3.5 py-1.5 bg-[#e7ecf8]/70 dark:bg-[#141933] text-[11px] text-[#4d597d] dark:text-[#919ec4] flex items-center justify-between">
                                    <span>
                                      Showing {visibleSubs.length} of {project.subtitles.length} subtitles
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSubSearchQuery("");
                                        setQualityFilter("all");
                                      }}
                                      className="underline hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
                                    >
                                      Show all
                                    </button>
                                  </div>
                                )}
                                {visibleSubs.map((sub: SubtitleItem) => {
                                  const subIdx = project.subtitles.findIndex(
                                    (item) => item.id === sub.id
                                  );
                                  const isSelected = selectedSubtitleId === sub.id;
                                  const isCurrent = sub.id === livePlayingSubId;
                                  const isLooping = loopingSubId === sub.id;
                                  const isEditingTime = editingTimeId === sub.id;
                                  const isAiPopoverOpen = aiPopoverId === sub.id;
                                  const isMoreMenuOpen = moreMenuId === sub.id;
                                  const isWordBarCollapsed = Boolean(collapsedWordBarSubIds[sub.id]);
                                  const isRegenerating = regeneratingSubIds.includes(sub.id);
                                  const isInFlightRetranslate =
                                    retranslatingSubIds.includes(sub.id) ||
                                    (isRetranslatingAll &&
                                      retranslatingSubIds.length === 0 &&
                                      !sub.isManuallyEdited);
                                  const isRowLocked = isRegenerating || isInFlightRetranslate;
                                  const canSplitSub = sub.endTime - sub.startTime >= 0.45;
                                  const canMergeNext =
                                    subIdx >= 0 && subIdx < project.subtitles.length - 1;
                                  const hintValue = hintDrafts[sub.id] ?? "";
                                  const qFlags = qualityMap[sub.id];

                                  if (!isSelected) {
                                    const issueLabels = qFlags?.issues.map((iss) =>
                                      iss === "overlap"
                                        ? "Overlap"
                                        : iss === "too_fast"
                                          ? "Too fast"
                                          : iss === "silent_mismatch"
                                            ? "Silent mismatch"
                                            : "Missing gloss"
                                    );
                                    return (
                                      <div
                                        key={sub.id}
                                        ref={(node) => {
                                          subCardRefs.current[sub.id] = node;
                                          subtitleViewportRef.current?.registerItemElement(
                                            sub.id,
                                            node
                                          );
                                        }}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Edit subtitle ${subIdx + 1}: ${
                                          sub.thaiPhonetic || sub.burmese || "empty"
                                        }${issueLabels?.length ? ` (${issueLabels.join(", ")})` : ""}`}
                                        onClick={() => {
                                          setAiPopoverId(null);
                                          setMoreMenuId(null);
                                          setEditingTimeId(null);
                                          setSelectedSubtitleId(sub.id);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            setAiPopoverId(null);
                                            setMoreMenuId(null);
                                            setEditingTimeId(null);
                                            setSelectedSubtitleId(sub.id);
                                          }
                                        }}
                                        className={`px-3.5 py-2 border-l-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
                                          isLooping
                                            ? "border-l-emerald-500 bg-emerald-50/45 dark:bg-emerald-950/20"
                                            : isCurrent
                                              ? "border-l-teal-700 dark:border-l-teal-400 bg-teal-50/45 dark:bg-teal-950/25"
                                              : "border-l-transparent bg-white dark:bg-[#0d1022] hover:bg-[#f3f5fc]/70 dark:hover:bg-[#141933]/60"
                                        }`}
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <div className="flex items-center gap-1.5 shrink-0">
                                            <span
                                              className={`text-[11px] font-mono-tabular ${
                                                isCurrent
                                                  ? "text-teal-700 dark:text-teal-400 font-semibold"
                                                  : "text-[#4d597d] dark:text-[#919ec4]"
                                              }`}
                                            >
                                              {formatRangeSec(sub.startTime / effectiveSpd)}
                                            </span>
                                            {sub.isManuallyEdited && (
                                              <span
                                                title="Manually edited"
                                                aria-label="Manually edited"
                                                className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 shrink-0"
                                              />
                                            )}
                                          </div>

                                          <div className="flex-1 min-w-0">
                                            <p className="text-[12.5px] font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate leading-snug">
                                              {sub.thaiPhonetic || "—"}
                                            </p>
                                            <p className="font-myanmar text-[12px] text-[#4d597d] dark:text-[#919ec4] truncate leading-snug">
                                              {sub.burmese || "—"}
                                            </p>
                                          </div>

                                          {(isLooping ||
                                            isRegenerating ||
                                            isInFlightRetranslate ||
                                            (qFlags && qFlags.issues.length > 0)) && (
                                            <div
                                              className="flex items-center gap-1 shrink-0"
                                              title={issueLabels?.join(" · ")}
                                            >
                                              {qFlags?.overlap && (
                                                <span
                                                  aria-label="Overlap issue"
                                                  className="w-2 h-2 rounded-full bg-rose-500"
                                                />
                                              )}
                                              {qFlags?.too_fast && (
                                                <span
                                                  aria-label="Too fast issue"
                                                  className="w-2 h-2 rounded-full bg-amber-500"
                                                />
                                              )}
                                              {qFlags?.silent_mismatch && (
                                                <span
                                                  aria-label="Silent mismatch issue"
                                                  className="w-2 h-2 rounded-full bg-orange-500"
                                                />
                                              )}
                                              {qFlags?.missing_gloss && (
                                                <span
                                                  aria-label="Missing gloss issue"
                                                  className="w-2 h-2 rounded-full bg-sky-500"
                                                />
                                              )}
                                              {isLooping && (
                                                <Repeat className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                              )}
                                              {(isRegenerating || isInFlightRetranslate) && (
                                                <Loader2 className="w-3 h-3 animate-spin text-teal-700 dark:text-teal-400" />
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  }

                                  return (
                                    <div
                                      key={sub.id}
                                      ref={(node) => {
                                        subCardRefs.current[sub.id] = node;
                                        subtitleViewportRef.current?.registerItemElement(
                                          sub.id,
                                          node
                                        );
                                      }}
                                      onFocusCapture={handleExpandedCardFocusCapture}
                                      onChangeCapture={handleExpandedCardInputActivity}
                                      onBlurCapture={handleExpandedCardBlurCapture}
                                      className={`px-3.5 py-2.5 border-l-2 transition-colors ${
                                        isLooping
                                          ? "border-l-emerald-500 bg-emerald-50/55 dark:bg-emerald-950/25"
                                          : isCurrent
                                            ? "border-l-teal-700 dark:border-l-teal-400 bg-teal-50/55 dark:bg-teal-950/30"
                                            : "border-l-amber-500 dark:border-l-amber-400 bg-[#f3f5fc]/55 dark:bg-[#141933]/55"
                                      }`}
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <div
                                            ref={isEditingTime ? timePopoverRef : undefined}
                                            className="relative shrink-0"
                                          >
                                            <button
                                              type="button"
                                              disabled={isRowLocked}
                                              onClick={() => {
                                                if (isEditingTime) {
                                                  setEditingTimeId(null);
                                                } else {
                                                  setAiPopoverId(null);
                                                  setMoreMenuId(null);
                                                  setEditingTimeId(sub.id);
                                                  setEditStartVal(sub.startTime.toFixed(1));
                                                  setEditEndVal(sub.endTime.toFixed(1));
                                                }
                                              }}
                                              title="Click to edit start/end timing"
                                              aria-label="Edit subtitle timing"
                                              aria-expanded={isEditingTime}
                                              className={`h-6 px-2 rounded-sm border text-[11px] font-mono-tabular inline-flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                                isEditingTime
                                                  ? "border-teal-600/80 bg-teal-50/90 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200 font-semibold"
                                                  : isCurrent
                                                    ? "border-teal-600/40 bg-teal-50/70 dark:border-teal-400/40 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 font-semibold"
                                                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                              }`}
                                            >
                                              <Clock className="w-3 h-3 shrink-0" />
                                              <span>
                                                {formatRangeSec(sub.startTime / effectiveSpd)} –{" "}
                                                {formatRangeSec(sub.endTime / effectiveSpd)}
                                              </span>
                                            </button>

                                            {isEditingTime && (
                                              <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-lg p-2.5 z-30 space-y-2 text-xs">
                                                <div className="flex items-center justify-between gap-2">
                                                  <label className="flex items-center gap-1.5 text-[#4d597d] dark:text-[#919ec4]">
                                                    <span>Start</span>
                                                    <input
                                                      type="number"
                                                      step="0.1"
                                                      min={0}
                                                      max={project.targetDurationSec}
                                                      value={editStartVal}
                                                      onChange={(e) => setEditStartVal(e.target.value)}
                                                      className="w-16 h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-xs"
                                                    />
                                                  </label>
                                                  <label className="flex items-center gap-1.5 text-[#4d597d] dark:text-[#919ec4]">
                                                    <span>End</span>
                                                    <input
                                                      type="number"
                                                      step="0.1"
                                                      min={0.2}
                                                      max={project.targetDurationSec}
                                                      value={editEndVal}
                                                      onChange={(e) => setEditEndVal(e.target.value)}
                                                      className="w-16 h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] font-mono-tabular text-xs"
                                                    />
                                                  </label>
                                                </div>

                                                <div className="flex items-center justify-between gap-1.5 pt-0.5">
                                                  <div className="flex items-center gap-1">
                                                    {[-0.1, 0.1].map((delta) => (
                                                      <button
                                                        key={delta}
                                                        type="button"
                                                        onClick={() => {
                                                          const maxDur = Math.max(
                                                            0.5,
                                                            project.targetDurationSec || 10
                                                          );
                                                          const curS = Number.isFinite(
                                                            parseFloat(editStartVal)
                                                          )
                                                            ? parseFloat(editStartVal)
                                                            : sub.startTime;
                                                          const curE = Number.isFinite(
                                                            parseFloat(editEndVal)
                                                          )
                                                            ? parseFloat(editEndVal)
                                                            : sub.endTime;
                                                          const dur = Math.max(0.2, curE - curS);
                                                          const nextS = Math.max(
                                                            0,
                                                            Math.min(maxDur - dur, curS + delta)
                                                          );
                                                          const nextE = Math.min(maxDur, nextS + dur);
                                                          setEditStartVal(nextS.toFixed(1));
                                                          setEditEndVal(nextE.toFixed(1));
                                                          onUpdateSubtitleTiming(sub.id, nextS, nextE);
                                                        }}
                                                        className="h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] font-mono-tabular text-[11px] text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] cursor-pointer transition-colors"
                                                      >
                                                        {delta > 0 ? `+${delta}s` : `${delta}s`}
                                                      </button>
                                                    ))}
                                                    <button
                                                      type="button"
                                                      onClick={() => onSeek(sub.startTime)}
                                                      className="h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
                                                    >
                                                      Seek
                                                    </button>
                                                  </div>
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
                                                    className="h-6 px-2 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                                                  >
                                                    <Check className="w-3 h-3" />
                                                    <span>Apply</span>
                                                  </button>
                                                </div>
                                              </div>
                                            )}
                                          </div>

                                          {sub.isManuallyEdited && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0">
                                              <span
                                                aria-hidden="true"
                                                className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
                                              />
                                              <span>Edited</span>
                                            </span>
                                          )}
                                          {isInFlightRetranslate && (
                                            <span className="text-[10px] font-medium text-teal-700 dark:text-teal-400 inline-flex items-center gap-1 shrink-0">
                                              <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                              <span>Updating</span>
                                            </span>
                                          )}
                                          <span className="text-[11px] text-[#4d597d]/75 dark:text-[#919ec4]/75 truncate">
                                            {sub.originalSpokenText}
                                          </span>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-1 shrink-0">
                                          <button
                                            type="button"
                                            onClick={() => onToggleLoopSubtitle(sub.id)}
                                            title={
                                              isLooping
                                                ? "Stop looping this line"
                                                : "Loop play this subtitle"
                                            }
                                            aria-label={
                                              isLooping
                                                ? "Stop looping this line"
                                                : "Loop play this subtitle"
                                            }
                                            className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                              isLooping
                                                ? "border-emerald-500 bg-emerald-100/90 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-200"
                                                : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                            }`}
                                          >
                                            {isLooping && isPlaying ? (
                                              <Square className="w-2.5 h-2.5 fill-current" />
                                            ) : (
                                              <Repeat className="w-3 h-3" />
                                            )}
                                            <span>{isLooping ? "Stop" : "Loop"}</span>
                                          </button>

                                          {sub.words.length > 0 && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setCollapsedWordBarSubIds((prev) => ({
                                                  ...prev,
                                                  [sub.id]: !prev[sub.id],
                                                }))
                                              }
                                              title="Toggle interactive word-chip gloss editor"
                                              aria-label="Toggle interactive word-chip gloss editor"
                                              aria-expanded={!isWordBarCollapsed}
                                              className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                                !isWordBarCollapsed
                                                  ? "border-teal-600/70 dark:border-teal-400/70 bg-teal-50/80 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200"
                                                  : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                              }`}
                                            >
                                              <BookOpen className="w-3 h-3" />
                                              <span>Words</span>
                                            </button>
                                          )}

                                          {/* Single Unified ✨ AI Popover Trigger */}
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
                                            <div
                                              ref={isAiPopoverOpen ? aiPopoverRef : undefined}
                                              className="relative"
                                            >
                                              <button
                                                type="button"
                                                disabled={isRetranslatingAll || isResyncingTimings}
                                                onClick={() => {
                                                  setMoreMenuId(null);
                                                  setEditingTimeId(null);
                                                  setAiPopoverId((cur) =>
                                                    cur === sub.id ? null : sub.id
                                                  );
                                                }}
                                                title="AI rewrite or hint"
                                                aria-label="AI rewrite or hint"
                                                aria-expanded={isAiPopoverOpen}
                                                className={`h-6 px-1.5 rounded-sm flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed ${
                                                  isAiPopoverOpen || hintValue.trim()
                                                    ? "border-teal-600/70 dark:border-teal-400/70 bg-teal-50/80 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200"
                                                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:border-teal-600/60 dark:hover:border-teal-400/60 hover:text-teal-700 dark:hover:text-teal-400"
                                                }`}
                                              >
                                                <Sparkles className="w-3 h-3" />
                                                <span>AI</span>
                                              </button>

                                              {isAiPopoverOpen && (
                                                <div className="absolute right-0 mt-1 w-72 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-lg p-2.5 z-30 space-y-2">
                                                  <div className="flex items-center justify-between gap-2">
                                                    <span className="text-[11px] font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                                                      AI Rewrite
                                                    </span>
                                                    <button
                                                      type="button"
                                                      disabled={
                                                        isRetranslatingAll || isResyncingTimings
                                                      }
                                                      onClick={() => {
                                                        setAiPopoverId(null);
                                                        onRegenerateSubtitle(sub.id);
                                                      }}
                                                      className="h-6 px-2 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                                    >
                                                      <Sparkles className="w-3 h-3" />
                                                      <span>Instant Regenerate</span>
                                                    </button>
                                                  </div>

                                                  <div className="border-t border-[#d2dcf0] dark:border-[#21284c] pt-2 space-y-1.5">
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
                                                          className="px-2 py-0.5 rounded-sm border border-teal-200/80 dark:border-teal-500/30 bg-[#f3f5fc] dark:bg-[#141933] text-[10px] font-medium text-teal-800 dark:text-teal-200 hover:bg-teal-50 dark:hover:bg-teal-900/50 cursor-pointer whitespace-nowrap"
                                                        >
                                                          {preset.label}
                                                        </button>
                                                      ))}
                                                    </div>

                                                    <form
                                                      onSubmit={(e) => {
                                                        e.preventDefault();
                                                        setAiPopoverId(null);
                                                        onRegenerateSubtitle(sub.id, hintValue);
                                                      }}
                                                      className="space-y-1.5"
                                                    >
                                                      <input
                                                        type="text"
                                                        value={hintValue}
                                                        onChange={(e) =>
                                                          setHintDrafts((prev) => ({
                                                            ...prev,
                                                            [sub.id]: e.target.value,
                                                          }))
                                                        }
                                                        placeholder="Custom AI hint..."
                                                        aria-label="AI regeneration hint"
                                                        className="w-full h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                                      />
                                                      <button
                                                        type="submit"
                                                        disabled={
                                                          isRetranslatingAll || isResyncingTimings
                                                        }
                                                        className="w-full h-7 px-2.5 rounded-sm border border-teal-600/60 dark:border-teal-400/60 bg-teal-50/80 dark:bg-teal-950/50 hover:bg-teal-100 dark:hover:bg-teal-900/60 text-teal-800 dark:text-teal-200 text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                                                      >
                                                        <Sparkles className="w-3 h-3" />
                                                        <span>Run with Hint</span>
                                                      </button>
                                                    </form>
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          )}

                                          {/* Compact ⋯ Overflow Menu (Split, Merge with Next, Delete) */}
                                          <div
                                            ref={isMoreMenuOpen ? moreMenuRef : undefined}
                                            className="relative"
                                          >
                                            <button
                                              type="button"
                                              disabled={isRowLocked}
                                              onClick={() => {
                                                setAiPopoverId(null);
                                                setEditingTimeId(null);
                                                setMoreMenuId((cur) =>
                                                  cur === sub.id ? null : sub.id
                                                );
                                              }}
                                              title="More subtitle actions"
                                              aria-label="More subtitle actions"
                                              aria-expanded={isMoreMenuOpen}
                                              className={`w-6 h-6 rounded-sm flex items-center justify-center border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                                isMoreMenuOpen
                                                  ? "border-teal-600/70 bg-teal-50 text-teal-800 dark:border-teal-400/70 dark:bg-teal-950/50 dark:text-teal-200"
                                                  : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                                              }`}
                                            >
                                              <MoreHorizontal className="w-3.5 h-3.5" />
                                            </button>

                                            {isMoreMenuOpen && (
                                              <div className="absolute right-0 mt-1 w-40 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-lg p-1 z-30 space-y-0.5">
                                                <button
                                                  type="button"
                                                  disabled={!canSplitSub || isRowLocked}
                                                  onClick={() => {
                                                    setMoreMenuId(null);
                                                    onSplitSubtitle(sub.id);
                                                  }}
                                                  className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                                                >
                                                  <Scissors className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
                                                  <span>Split</span>
                                                </button>
                                                {canMergeNext && (
                                                  <button
                                                    type="button"
                                                    disabled={isRowLocked}
                                                    onClick={() => {
                                                      setMoreMenuId(null);
                                                      onMergeSubtitleWithNext(sub.id);
                                                    }}
                                                    className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#141933] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                                                  >
                                                    <Merge className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4]" />
                                                    <span>Merge with Next</span>
                                                  </button>
                                                )}
                                                <div className="my-1 border-t border-[#d2dcf0] dark:border-[#21284c]" />
                                                <button
                                                  type="button"
                                                  disabled={isRowLocked}
                                                  onClick={() => {
                                                    setMoreMenuId(null);
                                                    if (editingTimeId === sub.id) setEditingTimeId(null);
                                                    if (aiPopoverId === sub.id) setAiPopoverId(null);
                                                    if (activeWordChip?.subId === sub.id) {
                                                      setActiveWordChip(null);
                                                      setChipSplitMode(false);
                                                    }
                                                    onDeleteSubtitle(sub.id);
                                                  }}
                                                  className="w-full px-2.5 py-1.5 rounded-sm text-left text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                                                >
                                                  <Trash2 className="w-3.5 h-3.5" />
                                                  <span>Delete</span>
                                                </button>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>

                                      {qFlags && qFlags.issues.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1.5 mt-1 mb-1">
                                          {qFlags.overlap && (
                                            <span className="px-1.5 py-0.5 rounded-sm border border-rose-300/80 dark:border-rose-700/70 bg-rose-50 dark:bg-rose-950/45 text-[10px] font-medium text-rose-800 dark:text-rose-200">
                                              Overlap
                                            </span>
                                          )}
                                          {qFlags.too_fast && (
                                            <span className="px-1.5 py-0.5 rounded-sm border border-amber-300/80 dark:border-amber-700/70 bg-amber-50 dark:bg-amber-950/45 text-[10px] font-medium text-amber-900 dark:text-amber-200">
                                              Too Fast (
                                              {qFlags.durationSec < 0.5
                                                ? `${qFlags.durationSec.toFixed(2)}s`
                                                : `${Math.round(
                                                    Math.max(qFlags.burmeseCps, qFlags.phoneticCps)
                                                  )}/s`}
                                              )
                                            </span>
                                          )}
                                          {qFlags.silent_mismatch && (
                                            <span className="px-1.5 py-0.5 rounded-sm border border-orange-300/80 dark:border-orange-700/70 bg-orange-50 dark:bg-orange-950/45 text-[10px] font-medium text-orange-800 dark:text-orange-200">
                                              No Speech Match
                                            </span>
                                          )}
                                          {qFlags.missing_gloss && (
                                            <span className="px-1.5 py-0.5 rounded-sm border border-sky-300/80 dark:border-sky-700/70 bg-sky-50 dark:bg-sky-950/45 text-[10px] font-medium text-sky-800 dark:text-sky-200">
                                              Missing Gloss ({qFlags.missingGlossCount})
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {editSettings.showThaiScript && (
                                        <input
                                          type="text"
                                          disabled={isRowLocked}
                                          value={sub.thaiScript}
                                          onChange={(e) =>
                                            onUpdateSubtitle(sub.id, "thaiScript", e.target.value)
                                          }
                                          placeholder="ภาษาไทย..."
                                          aria-label="Thai script"
                                          className="w-full text-[12px] font-medium text-teal-700 dark:text-teal-400 bg-transparent border-b border-transparent focus:border-teal-600 dark:focus:border-teal-400 focus:outline-none py-0.5 disabled:opacity-50"
                                        />
                                      )}

                                      <input
                                        ref={selectedPhoneticInputRef}
                                        type="text"
                                        disabled={isRowLocked}
                                        value={sub.thaiPhonetic}
                                        onChange={(e) =>
                                          onUpdateSubtitle(sub.id, "thaiPhonetic", e.target.value)
                                        }
                                        placeholder="Thai phonetic..."
                                        aria-label="Thai in English phonetics"
                                        className="w-full text-[13px] font-semibold text-[#0c1026] dark:text-[#f3f5fc] bg-transparent border-b border-transparent focus:border-teal-700 dark:focus:border-teal-400 focus:outline-none py-0.5 disabled:opacity-50"
                                      />

                                      <input
                                        type="text"
                                        disabled={isRowLocked}
                                        value={sub.burmese}
                                        onChange={(e) =>
                                          onUpdateSubtitle(sub.id, "burmese", e.target.value)
                                        }
                                        placeholder="မြန်မာဘာသာပြန်..."
                                        aria-label="Burmese translation"
                                        className="w-full font-myanmar text-[13px] text-[#4d597d] dark:text-[#919ec4] bg-transparent border-b border-transparent focus:border-teal-700 dark:focus:border-teal-400 focus:outline-none py-0.5 disabled:opacity-50"
                                      />

                                      {!isWordBarCollapsed && sub.words.length > 0 && (
                                        <div className="mt-2 pt-2 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2">
                                          <div className="flex flex-wrap items-center gap-1.5">
                                            {sub.words.map((word, wi) => {
                                              const isChipActive =
                                                activeWordChip?.subId === sub.id &&
                                                activeWordChip.wordIndex === wi;
                                              const isMissingWordGloss =
                                                editSettings.showWordGloss !== false &&
                                                (!word.burmeseGloss || !word.burmeseGloss.trim());
                                              return (
                                                <button
                                                  key={`${sub.id}-chip-${wi}`}
                                                  type="button"
                                                  disabled={isRowLocked}
                                                  aria-expanded={isChipActive}
                                                  onClick={() => {
                                                    if (isChipActive) {
                                                      setActiveWordChip(null);
                                                      setChipSplitMode(false);
                                                      return;
                                                    }
                                                    setActiveWordChip({ subId: sub.id, wordIndex: wi });
                                                    setChipPhoneticDraft(word.phonetic);
                                                    setChipThaiDraft(word.thai || "");
                                                    setChipGlossDraft(word.burmeseGloss || "");
                                                    setChipSplitMode(false);
                                                    const [a, b] = suggestChipSplitParts(word.phonetic);
                                                    setChipSplitA(a);
                                                    setChipSplitB(b);
                                                  }}
                                                  className={`px-2 py-0.5 rounded-sm border text-[11px] inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-45 ${
                                                    isChipActive
                                                      ? "border-teal-600 bg-teal-50 text-teal-900 dark:border-teal-400 dark:bg-teal-950/60 dark:text-teal-100 font-semibold"
                                                      : isMissingWordGloss
                                                        ? "border-sky-400/75 bg-sky-50/70 text-[#0c1026] dark:border-sky-500/60 dark:bg-sky-950/35 dark:text-[#f3f5fc] hover:border-sky-500"
                                                        : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-[#0c1026] dark:text-[#f3f5fc] hover:border-teal-600/60 dark:hover:border-teal-400/60"
                                                  }`}
                                                >
                                                  <span className="font-semibold">
                                                    {word.phonetic || "—"}
                                                  </span>
                                                  <span className="text-[#94a3b8] dark:text-[#4b588c]">
                                                    |
                                                  </span>
                                                  <span
                                                    className={`font-myanmar ${
                                                      word.burmeseGloss?.trim()
                                                        ? "text-teal-700 dark:text-teal-300"
                                                        : "text-[#94a3b8] dark:text-[#7c89b0]"
                                                    }`}
                                                  >
                                                    {word.burmeseGloss?.trim() || "—"}
                                                  </span>
                                                </button>
                                              );
                                            })}
                                          </div>

                                          {activeWordChip &&
                                            activeWordChip.subId === sub.id &&
                                            sub.words[activeWordChip.wordIndex] && (
                                              <div
                                                ref={wordChipPopoverRef}
                                                className="rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] shadow-md p-2.5 space-y-2 text-xs"
                                              >
                                                <div className="flex items-center justify-between gap-2">
                                                  <span className="text-[11px] font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                                                    Word {activeWordChip.wordIndex + 1} ·{" "}
                                                    <span className="font-mono-tabular text-[#4d597d] dark:text-[#919ec4]">
                                                      {sub.words[
                                                        activeWordChip.wordIndex
                                                      ].startOffsetSec.toFixed(2)}
                                                      s–
                                                      {sub.words[
                                                        activeWordChip.wordIndex
                                                      ].endOffsetSec.toFixed(2)}
                                                      s
                                                    </span>
                                                  </span>
                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      setActiveWordChip(null);
                                                      setChipSplitMode(false);
                                                    }}
                                                    aria-label="Close word editor"
                                                    className="p-0.5 rounded hover:bg-[#e7ecf8] dark:hover:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] cursor-pointer"
                                                  >
                                                    <X className="w-3.5 h-3.5" />
                                                  </button>
                                                </div>

                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                                                  <label className="space-y-0.5">
                                                    <span className="block text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                                                      Phonetic
                                                    </span>
                                                    <input
                                                      type="text"
                                                      disabled={isRowLocked}
                                                      value={chipPhoneticDraft}
                                                      onChange={(e) => {
                                                        const val = e.target.value;
                                                        setChipPhoneticDraft(val);
                                                        onUpdateWordChip?.(
                                                          sub.id,
                                                          activeWordChip.wordIndex,
                                                          { phonetic: val }
                                                        );
                                                      }}
                                                      className="w-full h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                                    />
                                                  </label>

                                                  <label className="space-y-0.5">
                                                    <span className="block text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                                                      Thai
                                                    </span>
                                                    <input
                                                      type="text"
                                                      disabled={isRowLocked}
                                                      value={chipThaiDraft}
                                                      onChange={(e) => {
                                                        const val = e.target.value;
                                                        setChipThaiDraft(val);
                                                        onUpdateWordChip?.(
                                                          sub.id,
                                                          activeWordChip.wordIndex,
                                                          { thai: val }
                                                        );
                                                      }}
                                                      className="w-full h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-xs text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                                    />
                                                  </label>

                                                  <label className="space-y-0.5">
                                                    <span className="block text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                                                      Burmese Gloss
                                                    </span>
                                                    <input
                                                      type="text"
                                                      disabled={isRowLocked}
                                                      value={chipGlossDraft}
                                                      placeholder="အနက်..."
                                                      onChange={(e) => {
                                                        const val = e.target.value;
                                                        setChipGlossDraft(val);
                                                        if (onUpdateWordChip) {
                                                          onUpdateWordChip(
                                                            sub.id,
                                                            activeWordChip.wordIndex,
                                                            { burmeseGloss: val }
                                                          );
                                                        } else {
                                                          onUpdateWordGloss(
                                                            sub.id,
                                                            activeWordChip.wordIndex,
                                                            val
                                                          );
                                                        }
                                                      }}
                                                      className="w-full h-7 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] font-myanmar text-xs text-teal-700 dark:text-teal-300 placeholder:text-[#4d597d] dark:placeholder:text-[#919ec4] focus:outline-none focus:border-teal-700 dark:focus:border-teal-400"
                                                    />
                                                  </label>
                                                </div>

                                                <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-[#d2dcf0] dark:border-[#21284c]">
                                                  <div className="flex flex-wrap items-center gap-1.5">
                                                    {onMergeWordChips &&
                                                      activeWordChip.wordIndex + 1 <
                                                        sub.words.length && (
                                                        <button
                                                          type="button"
                                                          disabled={isRowLocked}
                                                          onClick={() => {
                                                            const idx = activeWordChip.wordIndex;
                                                            const w1 = sub.words[idx];
                                                            const w2 = sub.words[idx + 1];
                                                            onMergeWordChips(sub.id, idx);
                                                            if (w1 && w2) {
                                                              const p1 = w1.phonetic.trim();
                                                              const p2 = w2.phonetic.trim();
                                                              setChipPhoneticDraft(
                                                                p1.endsWith("-") && p2
                                                                  ? `${p1}${p2}`
                                                                  : [p1, p2]
                                                                      .filter(Boolean)
                                                                      .join(" ")
                                                              );
                                                              setChipThaiDraft(
                                                                [w1.thai, w2.thai]
                                                                  .map((s) => (s || "").trim())
                                                                  .filter(Boolean)
                                                                  .join("")
                                                              );
                                                              setChipGlossDraft(
                                                                [w1.burmeseGloss, w2.burmeseGloss]
                                                                  .map((s) => (s || "").trim())
                                                                  .filter(Boolean)
                                                                  .join(" ")
                                                              );
                                                            }
                                                            setChipSplitMode(false);
                                                          }}
                                                          className="h-6 px-2 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1 cursor-pointer"
                                                        >
                                                          <Merge className="w-3 h-3" />
                                                          <span>Merge with Next</span>
                                                        </button>
                                                      )}
                                                    {onSplitWordChip && (
                                                      <button
                                                        type="button"
                                                        disabled={isRowLocked}
                                                        onClick={() => {
                                                          setChipSplitMode((v) => !v);
                                                          const [a, b] =
                                                            suggestChipSplitParts(chipPhoneticDraft);
                                                          setChipSplitA(a);
                                                          setChipSplitB(b);
                                                        }}
                                                        className={`h-6 px-2 rounded-sm border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer ${
                                                          chipSplitMode
                                                            ? "border-teal-600/80 bg-teal-50 text-teal-800 dark:border-teal-400/80 dark:bg-teal-950/60 dark:text-teal-200"
                                                            : "border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[#0c1026] dark:text-[#f3f5fc]"
                                                        }`}
                                                      >
                                                        <Scissors className="w-3 h-3" />
                                                        <span>Split Chip</span>
                                                      </button>
                                                    )}
                                                  </div>

                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      setActiveWordChip(null);
                                                      setChipSplitMode(false);
                                                    }}
                                                    className="h-6 px-2 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:text-[#060918] text-[11px] font-semibold cursor-pointer"
                                                  >
                                                    Done
                                                  </button>
                                                </div>

                                                {chipSplitMode && onSplitWordChip && (
                                                  <div className="pt-1.5 border-t border-[#d2dcf0] dark:border-[#21284c] flex flex-wrap items-end gap-1.5">
                                                    <label className="flex-1 min-w-[90px] space-y-0.5">
                                                      <span className="block text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                                                        Part A
                                                      </span>
                                                      <input
                                                        type="text"
                                                        value={chipSplitA}
                                                        onChange={(e) => setChipSplitA(e.target.value)}
                                                        className="w-full h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[11px] text-[#0c1026] dark:text-[#f3f5fc]"
                                                      />
                                                    </label>
                                                    <label className="flex-1 min-w-[90px] space-y-0.5">
                                                      <span className="block text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4]">
                                                        Part B
                                                      </span>
                                                      <input
                                                        type="text"
                                                        value={chipSplitB}
                                                        onChange={(e) => setChipSplitB(e.target.value)}
                                                        className="w-full h-6 px-1.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[11px] text-[#0c1026] dark:text-[#f3f5fc]"
                                                      />
                                                    </label>
                                                    <button
                                                      type="button"
                                                      disabled={!chipSplitA.trim() || !chipSplitB.trim()}
                                                      onClick={() => {
                                                        onSplitWordChip(
                                                          sub.id,
                                                          activeWordChip.wordIndex,
                                                          chipSplitA,
                                                          chipSplitB,
                                                          chipGlossDraft,
                                                          ""
                                                        );
                                                        setChipSplitMode(false);
                                                        setActiveWordChip(null);
                                                      }}
                                                      className="h-6 px-2.5 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:text-[#060918] text-[11px] font-semibold disabled:opacity-45 cursor-pointer"
                                                    >
                                                      Split
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                            )}
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
                      </SubtitleListViewport>
                    </div>
                  )}

                  {/* TAB 2: STYLE */}
                  {captionTab === "style" && (
                    <SubtitleStylePanel
                      editSettings={editSettings}
                      onChangeEditSettings={onChangeEditSettings}
                    />
                  )}

                  {/* TAB 3: SYNC */}
                  {captionTab === "sync" && (
                    <div className="px-3.5 py-3 space-y-4">
                      {/* Fix Overlaps & Gaps */}
                      <div className="space-y-2">
                        <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
                          Cleanup &amp; Timing Hygiene
                        </span>
                        <p className="text-xs text-[#4d597d] dark:text-[#919ec4] leading-relaxed">
                          Automatically clamp out-of-range lines, resolve overlaps, and smooth brief flicker gaps.
                        </p>
                        {onAutoFixSubtitleTimings && (
                          <button
                            type="button"
                            disabled={project.subtitles.length === 0 || isResyncingTimings}
                            onClick={onAutoFixSubtitleTimings}
                            className="h-8 px-3 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:border-teal-600/70 hover:text-teal-700 dark:hover:border-teal-400/70 dark:hover:text-teal-400 text-xs font-semibold text-[#0c1026] dark:text-[#f3f5fc] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                          >
                            <Wand2 className="w-3.5 h-3.5" />
                            <span>Fix Overlaps &amp; Gaps</span>
                          </button>
                        )}
                      </div>

                      {/* Coarse Offset Shift */}
                      <div className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2">
                        <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
                          Coarse Global Shift
                        </span>
                        <p className="text-xs text-[#4d597d] dark:text-[#919ec4]">
                          Shift all subtitle timestamps by half a second. Fine ±0.1s nudge controls are available on the Timeline toolbar.
                        </p>
                        <div className="flex items-center gap-2">
                          {[-0.5, 0.5].map((delta) => (
                            <button
                              key={delta}
                              type="button"
                              disabled={project.subtitles.length === 0 || isResyncingTimings}
                              onClick={() => onShiftAllSubtitles(delta)}
                              className="h-8 px-3 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-mono-tabular font-semibold text-[#0c1026] dark:text-[#f3f5fc] disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer transition-colors"
                            >
                              {delta > 0 ? `+${delta}s` : `${delta}s`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* AI Resync All with inline warning */}
                      {onAiResyncSubtitles && (
                        <div className="pt-3 border-t border-[#d2dcf0] dark:border-[#21284c] space-y-2.5">
                          <span className="block text-[11px] font-semibold uppercase tracking-wider text-[#4d597d] dark:text-[#919ec4]">
                            AI Audio Alignment
                          </span>
                          {isResyncingTimings ? (
                            <div className="flex items-center gap-2">
                              <span className="h-8 px-3 rounded-sm border border-teal-300 dark:border-teal-500/40 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 text-xs font-medium inline-flex items-center gap-1.5">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Resyncing timings...</span>
                              </span>
                              {onCancelAiResync && (
                                <button
                                  type="button"
                                  onClick={onCancelAiResync}
                                  aria-label="Cancel AI timing sync"
                                  className="h-8 px-2.5 rounded-sm border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-xs font-semibold text-red-700 dark:text-red-300 inline-flex items-center gap-1 cursor-pointer transition-colors"
                                >
                                  <Square className="w-3 h-3 fill-current" />
                                  <span>Stop</span>
                                </button>
                              )}
                            </div>
                          ) : showResyncConfirm ? (
                            <div className="p-3 rounded-sm border border-amber-300/80 dark:border-amber-500/40 bg-amber-50/80 dark:bg-amber-950/35 space-y-2.5">
                              <div className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-100">
                                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                                <p className="leading-relaxed">
                                  AI Resync All will re-align subtitle timestamps across the entire audio track. Manual timing adjustments may change.
                                </p>
                              </div>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setShowResyncConfirm(false)}
                                  className="h-7 px-2.5 rounded-sm border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] text-xs font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={isRetranslatingAll}
                                  onClick={() => {
                                    setShowResyncConfirm(false);
                                    onAiResyncSubtitles();
                                  }}
                                  className="h-7 px-3 rounded-sm bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                                >
                                  <RefreshCw className="w-3 h-3" />
                                  <span>Confirm AI Resync</span>
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={project.subtitles.length === 0 || isRetranslatingAll}
                              onClick={() => setShowResyncConfirm(true)}
                              className="h-8 px-3 rounded-sm border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/80 dark:bg-teal-950/50 hover:bg-teal-100 dark:hover:bg-teal-900/60 text-xs font-semibold text-teal-800 dark:text-teal-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>AI Resync All</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

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
                  onShiftAllSubtitles={onShiftAllSubtitles}
                  onUndo={onUndoProp ?? onUndoSubtitles}
                  onRedo={onRedoProp ?? onRedoSubtitles}
                  canUndo={canUndoProp ?? canUndoSubtitles}
                  canRedo={canRedoProp ?? canRedoSubtitles}
                  onResetTimeline={onResetTimeline}
                  onGoToScenes={() => onChangeStudioSection("clips")}
                  cutSpeechRegions={cutSpeechRegions}
                  onTranscribeRange={onTranscribeRange}
                  transcribingRange={transcribingRange}
                  clipSubtitleCounts={UNIFIED_CUT_FLOW ? clipSubtitleCounts : undefined}
                  regeneratingClipId={UNIFIED_CUT_FLOW ? regeneratingClipId : undefined}
                  regeneratingClipPercent={UNIFIED_CUT_FLOW ? regeneratingClipPercent : undefined}
                  onGenerateSingleClip={UNIFIED_CUT_FLOW ? onGenerateSingleClip : undefined}
                  isBusy={UNIFIED_CUT_FLOW ? isProcessing : undefined}
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
                    hasGeneratedProject(project)
                      ? project.targetDurationSec
                      : selectedScenes.length > 0
                        ? selectedScenes.reduce(
                            (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
                            0
                          )
                        : localMedia?.durationSec ?? youtubeMedia?.durationSec
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
                  onRestoreProjectSnapshot={onRestoreProjectSnapshot ?? NOOP_RESTORE_SNAPSHOT}
                  onResetTimeline={onResetTimeline}
                  onGoToScenes={() => onChangeStudioSection("clips")}
                />
              </div>
            )}
          </div>
        </div>
        {hasGeneratedProject(project) && onApplyPasteTranscriptSync && (
          <PasteTranscriptModal
            isOpen={showPasteSyncModal}
            projectTitle={project.title}
            subtitles={project.subtitles}
            exportOpts={{
              speed: getEffectivePlaybackSpeed(
                project.sourceType,
                editSettings.playbackSpeed,
                voiceSettings.speed
              ),
              showThaiScript: editSettings.showThaiScript,
              showWordGloss: editSettings.showWordGloss,
              showBurmeseLine: editSettings.showBurmeseLine,
            }}
            onClose={() => setShowPasteSyncModal(false)}
            onApplySync={onApplyPasteTranscriptSync}
          />
        )}
    </div>
  );
}
