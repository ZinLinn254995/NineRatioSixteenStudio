import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
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
  Palette,
  Plus,
  Redo2,
  RefreshCw,
  Repeat,
  Replace,
  Scissors,
  Search,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
  SpeakingScene,
  SubtitleFontScale,
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
import { VideoEditPanel } from "./VideoEditPanel";
import { SavedProjectsPanel } from "./SavedProjectsPanel";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { findActiveSubtitle, getSceneDurationSec } from "../utils/projectTimeline";
import { DEFAULT_VIDEO_EDIT } from "../utils/videoFilters";
import {
  buildSrtContent,
  buildStudyTextContent,
  buildVttContent,
  downloadTextFile,
  makeSafeFileSlug,
} from "../utils/exportSubtitles";

export type WorkspaceTab =
  | "youtube"
  | "scenes"
  | "edit"
  | "script"
  | "projects";

interface WorkspaceSidebarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
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
  isPlaying: boolean;
  timelineDirty: boolean;
  searchError: string | null;
  project: VideoProject | null;
  cutTime: number;
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
  onTabChange,
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
  isPlaying,
  timelineDirty,
  searchError,
  project,
  cutTime,
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
}: WorkspaceSidebarProps) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
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

  // Part 3: Subtitle Search / Find-Replace, Style Customization & Multi-format Export
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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Minimal Segmented Switch */}
      <div className={`flex items-center justify-between gap-4 border-b border-neutral-200 dark:border-neutral-800 shrink-0 ${inlineStage ? "pb-2" : "pb-3"}`}>
        <div className="inline-flex items-center p-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 overflow-x-auto no-scrollbar max-w-full">
          <button
            type="button"
            onClick={() => onTabChange("youtube")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "youtube"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Explore
          </button>
          <button
            type="button"
            onClick={() => onTabChange("scenes")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "scenes"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Scenes
          </button>
          <button
            type="button"
            onClick={() => onTabChange("edit")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "edit"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Adjust
          </button>
          <button
            type="button"
            onClick={() => onTabChange("script")}
            disabled={!project}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeTab === "script"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Captions
          </button>
          <button
            type="button"
            onClick={() => onTabChange("projects")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "projects"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Projects{savedProjects.length > 0 ? ` (${savedProjects.length})` : ""}
          </button>
        </div>

        {project && activeTab === "script" && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono-tabular whitespace-nowrap shrink-0">
            {project.scenes.length} {project.scenes.length === 1 ? "scene" : "scenes"} ·{" "}
            {Math.round(
              project.targetDurationSec /
                getEffectivePlaybackSpeed(
                  project.sourceType,
                  editSettings.playbackSpeed,
                  voiceSettings.speed
                )
            )}
            s
          </span>
        )}
      </div>

      {/* Inline 9:16 Stage directly below Tab Switcher (used on compact mobile Edit/Subtitles view) */}
      {inlineStage && (
        <div className="pt-2 pb-0 shrink-0 flex justify-center">
          {inlineStage}
        </div>
      )}

      {/* Tab Body */}
      <div
        ref={scrollRootRef}
        className={`flex-1 overflow-y-auto overscroll-y-contain pr-1 min-h-0 ${inlineStage ? "pt-2" : "pt-4"}`}
      >
        {isProcessing && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-3 text-sm text-neutral-800 dark:text-neutral-200">
            <div className="flex items-center gap-3 min-w-0">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span className="truncate">Transcribing spoken dialogue in your selected scenes...</span>
            </div>
            {onCancelGenerateSubtitles && (
              <button
                type="button"
                onClick={onCancelGenerateSubtitles}
                className="h-7 px-2.5 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                <span>Stop</span>
              </button>
            )}
          </div>
        )}

        {activeTab === "youtube" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start pb-6">
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

            {/* Right / Bottom: Search & Recommended Feed Catalog */}
            <div className="lg:col-span-5 flex flex-col gap-3 min-w-0">
              {/* Feed Header & Filter Controls */}
              <div className="space-y-2.5 pb-2.5 border-b border-neutral-200 dark:border-neutral-800">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-neutral-950 dark:text-neutral-50 truncate">
                      {activeQuery ? `Results for “${activeQuery}”` : "Recommended"}
                    </span>
                    {videos.length > 0 && !isSearching && (
                      <span className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400 shrink-0">
                        ({videos.length}{hasMoreVideos ? "+" : ""})
                      </span>
                    )}
                  </div>

                  {activeQuery ? (
                    <button
                      type="button"
                      onClick={onResetToRecommended}
                      className="text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
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
                        className="h-8 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 transition-colors"
                      >
                        <RefreshCw className={`w-3 h-3 ${isSearching ? "animate-spin" : ""}`} />
                        <span>Refresh</span>
                      </button>
                    )
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={thaiOnly}
                    onClick={onToggleThaiOnly}
                    disabled={isSearching}
                    title="Show Thai-language videos only"
                    className={`h-8 px-2.5 rounded-lg border text-[11px] font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50 ${
                      thaiOnly
                        ? "border-neutral-950 bg-neutral-950 text-white dark:border-white dark:bg-white dark:text-neutral-950"
                        : "border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-white"
                    }`}
                  >
                    <span>Thai Only</span>
                    <span
                      aria-hidden="true"
                      className={`w-7 h-4 rounded-full p-0.5 transition-colors flex items-center ${
                        thaiOnly
                          ? "bg-emerald-500 justify-end"
                          : "bg-neutral-300 dark:bg-neutral-700 justify-start"
                      }`}
                    >
                      <span className="w-3 h-3 rounded-full bg-white shadow-xs" />
                    </span>
                  </button>

                  <div
                    role="group"
                    aria-label="Reuse license filter"
                    className="inline-flex items-center p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shrink-0"
                  >
                    {(
                      [
                        { id: "all", label: "All" },
                        { id: "creative_commons", label: "Creative Commons" },
                        { id: "standard", label: "Standard" },
                      ] as const
                    ).map((opt) => {
                      const selected = licenseFilter === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onChangeLicenseFilter(opt.id)}
                          className={`px-2.5 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                            selected
                              ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                              : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {searchError && (
                <div className="p-3.5 rounded-xl border border-neutral-300 dark:border-neutral-700 text-xs text-neutral-800 dark:text-neutral-200">
                  {searchError}
                </div>
              )}

              {isSearching ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2 flex flex-col lg:flex-row gap-3 animate-pulse"
                    >
                      <div className="aspect-video w-full lg:w-40 lg:shrink-0 rounded-lg bg-neutral-100 dark:bg-neutral-900" />
                      <div className="flex-1 py-1 space-y-2">
                        <div className="h-3.5 bg-neutral-100 dark:bg-neutral-900 rounded w-5/6" />
                        <div className="h-3 bg-neutral-100 dark:bg-neutral-900 rounded w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : videos.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center text-center text-neutral-500 dark:text-neutral-400 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-6">
                  <Film className="w-6 h-6 mb-2 opacity-60" />
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
                        className="text-xs font-medium underline text-neutral-900 dark:text-neutral-100 cursor-pointer"
                      >
                        Show all languages
                      </button>
                    )}
                    {licenseFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => onChangeLicenseFilter("all")}
                        className="text-xs font-medium underline text-neutral-900 dark:text-neutral-100 cursor-pointer"
                      >
                        Show all licenses
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2.5">
                    {videos.map((v) => {
                      const isSelected = selectedVideoId === v.videoId;
                      return (
                        <button
                          key={v.videoId}
                          type="button"
                          onClick={() => handlePickYouTubeVideo(v)}
                          className={`group text-left rounded-xl p-2 border transition-colors cursor-pointer flex flex-col lg:flex-row gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:focus-visible:ring-white ${
                            isSelected
                              ? "border-neutral-950 dark:border-white bg-neutral-50 dark:bg-neutral-900"
                              : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 bg-white dark:bg-neutral-950"
                          }`}
                        >
                          <div className="relative w-full lg:w-40 aspect-video rounded-lg bg-neutral-100 dark:bg-neutral-900 overflow-hidden shrink-0">
                            <img
                              src={v.thumbnail}
                              alt={v.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                            />
                            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono-tabular">
                              {v.durationText}
                            </span>
                          </div>

                          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                            <p className="text-[13px] font-semibold text-neutral-950 dark:text-neutral-50 line-clamp-2 leading-snug">
                              {v.title}
                            </p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                              <span className="truncate max-w-[160px]">{v.channel}</span>
                              {v.viewCountText && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono-tabular shrink-0">{v.viewCountText}</span>
                                </>
                              )}
                              {v.license === "creative_commons" && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="shrink-0">Creative Commons</span>
                                </>
                              )}
                              {isSelected && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-semibold text-neutral-950 dark:text-white shrink-0">
                                    Now Previewing
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
                    <div ref={loadMoreSentinelRef} className="pt-2 flex justify-center">
                      <button
                        type="button"
                        onClick={onLoadMoreVideos}
                        disabled={isLoadingMore}
                        className="h-9 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-2 cursor-pointer disabled:opacity-50 transition-colors"
                      >
                        {isLoadingMore ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Loading more videos...</span>
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
        )}

        {localMedia && (
          <div className={activeTab === "scenes" ? "" : "hidden"}>
            <ScenePicker
              media={localMedia}
              scenes={selectedScenes}
              isProcessing={isProcessing}
              isTabActive={isWorkspaceVisible && activeTab === "scenes"}
              translationTone={editSettings.translationTone}
              onChangeTranslationTone={(tone) =>
                onChangeEditSettings({ ...editSettings, translationTone: tone })
              }
              onUpdateScene={onUpdateScene}
              onRemoveScene={onRemoveScene}
              onReplaceScenes={onReplaceScenes}
              onDetectedDuration={onDetectedLocalDuration}
              onGenerate={onGenerateSubtitles}
              onUploadVideo={onUploadLocalVideo}
              onClearVideo={onClearLocalVideo}
            />
          </div>
        )}

        {!localMedia && activeTab === "scenes" && (
          <ScenePicker
            media={null}
            scenes={selectedScenes}
            isProcessing={isProcessing}
            isTabActive={isWorkspaceVisible && activeTab === "scenes"}
            translationTone={editSettings.translationTone}
            onChangeTranslationTone={(tone) =>
              onChangeEditSettings({ ...editSettings, translationTone: tone })
            }
            onUpdateScene={onUpdateScene}
            onRemoveScene={onRemoveScene}
            onReplaceScenes={onReplaceScenes}
            onDetectedDuration={onDetectedLocalDuration}
            onGenerate={onGenerateSubtitles}
            onUploadVideo={onUploadLocalVideo}
            onClearVideo={onClearLocalVideo}
          />
        )}

        {activeTab === "edit" && (
          <VideoEditPanel
            settings={editSettings}
            voiceSettings={voiceSettings}
            sourceType={
              project?.sourceType ?? localMedia?.sourceType ?? youtubeMedia?.sourceType ?? "local"
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
            isTabActive={isWorkspaceVisible && activeTab === "edit"}
            timelineDirty={timelineDirty}
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
            onGoToScenes={() => onTabChange("scenes")}
          />
        )}

        {activeTab === "script" && project && (
          <div className="space-y-4 pb-6">
            {/* Extracted Scenes Strip & Add Subtitle Action */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
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
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-mono-tabular border transition-colors cursor-pointer whitespace-nowrap ${
                        isSceneActive
                          ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                          : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600"
                      }`}
                    >
                      {idx + 1}. {formatRangeSec(sc.startSec)}–{formatRangeSec(sc.endSec)}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <div className="inline-flex items-center border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-white dark:bg-neutral-950">
                  <button
                    type="button"
                    disabled={!canUndoSubtitles || !onUndoSubtitles}
                    onClick={onUndoSubtitles}
                    title="Undo subtitle edit (Ctrl+Z)"
                    aria-label="Undo subtitle edit"
                    className="h-8 px-2.5 flex items-center gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>Undo</span>
                  </button>
                  <button
                    type="button"
                    disabled={!canRedoSubtitles || !onRedoSubtitles}
                    onClick={onRedoSubtitles}
                    title="Redo subtitle edit (Ctrl+Shift+Z)"
                    aria-label="Redo subtitle edit"
                    className="h-8 px-2.5 flex items-center gap-1 text-xs font-medium border-l border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <Redo2 className="w-3.5 h-3.5" />
                    <span>Redo</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => (showAddSub ? setShowAddSub(false) : openAddSubtitleForm())}
                  className="h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 hover:opacity-90 transition-opacity cursor-pointer"
                >
                  {showAddSub ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  <span>{showAddSub ? "Close" : "Add Subtitle"}</span>
                </button>
              </div>
            </div>

            {/* AI Translation Tone & Thai Script Display Toolbar */}
            <div className="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/90 dark:bg-neutral-900/70 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                  Tone
                </span>
                <div
                  role="group"
                  aria-label="Translation tone"
                  className="inline-flex items-center p-0.5 rounded-lg bg-neutral-200/70 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800"
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
                        className={`px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                          active
                            ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                            : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white"
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
                      <span className="h-7 px-2.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Applying...</span>
                      </span>
                      {onCancelRetranslateAll && (
                        <button
                          type="button"
                          onClick={onCancelRetranslateAll}
                          title="Stop Apply Tone"
                          aria-label="Stop Apply Tone"
                          className="h-7 px-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
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
                      className="h-7 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>Apply Tone</span>
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
                className={`h-7 px-2.5 rounded-lg border text-[11px] font-medium flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer ${
                  editSettings.showThaiScript
                    ? "border-neutral-950 bg-neutral-950 text-white dark:border-white dark:bg-white dark:text-neutral-950"
                    : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 hover:border-neutral-400 dark:hover:border-neutral-500"
                }`}
              >
                <span>Thai Script</span>
                <span
                  aria-hidden="true"
                  className={`w-6 h-3.5 rounded-full p-0.5 transition-colors flex items-center ${
                    editSettings.showThaiScript
                      ? "bg-emerald-500 justify-end"
                      : "bg-neutral-300 dark:bg-neutral-700 justify-start"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-white shadow-xs" />
                </span>
              </button>

              {project.subtitles.length > 0 && (
                <div className="w-full pt-2 border-t border-neutral-200/80 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                      Timing
                    </span>
                    <div className="inline-flex items-center gap-1">
                      {[-0.5, -0.1, 0.1, 0.5].map((delta) => (
                        <button
                          key={delta}
                          type="button"
                          onClick={() => onShiftAllSubtitles(delta)}
                          title={`Shift all subtitles by ${delta > 0 ? `+${delta}` : delta}s`}
                          className="h-6 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:border-neutral-400 dark:hover:border-neutral-500 text-[11px] font-mono-tabular font-medium text-neutral-700 dark:text-neutral-200 cursor-pointer whitespace-nowrap transition-colors"
                        >
                          {delta > 0 ? `+${delta}s` : `${delta}s`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {onAutoFixSubtitleTimings && (
                      <button
                        type="button"
                        onClick={onAutoFixSubtitleTimings}
                        title="Automatically fix overlaps, flicker gaps, and out-of-range subtitle timings"
                        className="h-6 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:border-emerald-400 dark:hover:border-emerald-500 hover:text-emerald-700 dark:hover:text-emerald-300 text-[11px] font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                      >
                        <Wand2 className="w-3 h-3" />
                        <span>Auto-Fix</span>
                      </button>
                    )}
                    {onAiResyncSubtitles && (
                      isResyncingTimings ? (
                        <div className="inline-flex items-center gap-1">
                          <span className="h-6 px-2 rounded-md border border-indigo-200 dark:border-indigo-800 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-[11px] font-medium flex items-center gap-1 whitespace-nowrap">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Syncing...</span>
                          </span>
                          {onCancelAiResync && (
                            <button
                              type="button"
                              onClick={onCancelAiResync}
                              title="Cancel AI timing sync"
                              aria-label="Cancel AI timing sync"
                              className="h-6 px-2 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-[11px] font-semibold text-red-700 dark:text-red-300 flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
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
                          title="AI listens to the video audio and automatically re-aligns all subtitle timings"
                          className="h-6 px-2.5 rounded-md border border-indigo-300 dark:border-indigo-700 bg-indigo-50/80 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/70 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200 flex items-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-50 transition-colors"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>AI Sync</span>
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}

              {/* Part 3 Row: Search/Replace, Subtitle Style, Jump to Current & Export SRT/VTT/TXT */}
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
                  <div className="w-full pt-2 border-t border-neutral-200/80 dark:border-neutral-800 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setShowSubSearch((v) => !v)}
                          title="Search and find & replace in subtitles"
                          className={`h-6 px-2 rounded-md border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                            showSubSearch || subSearchQuery.trim()
                              ? "border-neutral-950 bg-neutral-950 text-white dark:border-white dark:bg-white dark:text-neutral-950"
                              : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-200 hover:border-neutral-400 dark:hover:border-neutral-500"
                          }`}
                        >
                          <Search className="w-3 h-3" />
                          <span>Search</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setShowSubStyle((v) => !v)}
                          title="Customize 9:16 subtitle theme, font size, highlight & visibility"
                          className={`h-6 px-2 rounded-md border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                            showSubStyle || subStyleCustomized
                              ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/60 dark:text-indigo-200"
                              : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-200 hover:border-neutral-400 dark:hover:border-neutral-500"
                          }`}
                        >
                          <Palette className="w-3 h-3" />
                          <span>Style</span>
                          {subStyleCustomized && (
                            <span
                              aria-hidden="true"
                              className="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400"
                            />
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={jumpToActiveSubtitle}
                          title="Scroll to currently active subtitle at playhead"
                          className="h-6 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:border-neutral-400 dark:hover:border-neutral-500 text-[11px] font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                        >
                          <LocateFixed className="w-3 h-3" />
                          <span>Jump</span>
                        </button>
                      </div>

                      <div ref={exportMenuRef} className="relative">
                        <button
                          type="button"
                          onClick={() => setShowExportMenu((v) => !v)}
                          className="h-6 px-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:border-neutral-400 dark:hover:border-neutral-500 text-[11px] font-medium text-neutral-800 dark:text-neutral-100 flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors"
                        >
                          {copiedTranscript ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                              <span className="text-emerald-700 dark:text-emerald-300">Copied</span>
                            </>
                          ) : (
                            <>
                              <Download className="w-3 h-3" />
                              <span>Export Subtitles</span>
                            </>
                          )}
                        </button>

                        {showExportMenu && (
                          <div className="absolute right-0 mt-1.5 w-44 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg p-1.5 z-30 space-y-0.5">
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
                              className="w-full px-2.5 py-1.5 rounded-lg text-left text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2 cursor-pointer"
                            >
                              <FileText className="w-3.5 h-3.5 text-neutral-500" />
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
                              className="w-full px-2.5 py-1.5 rounded-lg text-left text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2 cursor-pointer"
                            >
                              <FileText className="w-3.5 h-3.5 text-neutral-500" />
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
                              className="w-full px-2.5 py-1.5 rounded-lg text-left text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2 cursor-pointer"
                            >
                              <BookOpen className="w-3.5 h-3.5 text-neutral-500" />
                              <span>Study Sheet .TXT</span>
                            </button>
                            <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
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
                              className="w-full px-2.5 py-1.5 rounded-lg text-left text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2 cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5 text-neutral-500" />
                              <span>Copy Transcript</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Inline Search & Find/Replace Drawer */}
                    {showSubSearch && (
                      <div className="p-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <div className="relative flex-1 min-w-0">
                            <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            <input
                              type="text"
                              value={subSearchQuery}
                              onChange={(e) => setSubSearchQuery(e.target.value)}
                              placeholder="Filter or find in phonetic, Thai, Burmese..."
                              aria-label="Search subtitles"
                              className="w-full h-7 pl-8 pr-7 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-xs text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                            />
                            {subSearchQuery && (
                              <button
                                type="button"
                                onClick={() => setSubSearchQuery("")}
                                aria-label="Clear search"
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setShowReplaceRow((v) => !v)}
                            className={`h-7 px-2 rounded-md border text-[11px] font-medium flex items-center gap-1 cursor-pointer whitespace-nowrap transition-colors ${
                              showReplaceRow
                                ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/60 dark:text-indigo-200"
                                : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                              className="flex-1 min-w-[140px] h-7 px-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-xs text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-indigo-500"
                            />
                            <select
                              value={subReplaceField}
                              onChange={(e) =>
                                setSubReplaceField(
                                  e.target.value as "all" | "burmese" | "thaiPhonetic" | "thaiScript"
                                )
                              }
                              aria-label="Target field for replace"
                              className="h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-[11px] text-neutral-700 dark:text-neutral-200 cursor-pointer"
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
                              className="h-7 px-2.5 rounded-md bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 cursor-pointer whitespace-nowrap"
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
                      <div className="p-2.5 rounded-lg border border-indigo-200/80 dark:border-indigo-900/60 bg-white dark:bg-neutral-950 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                              Theme
                            </span>
                            <div className="inline-flex items-center p-0.5 rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
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
                                  className={`px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-colors ${
                                    editSettings.subtitleTheme === t.id
                                      ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                                  }`}
                                >
                                  {t.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                              Size
                            </span>
                            <div className="inline-flex items-center p-0.5 rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
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
                                  className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer transition-colors ${
                                    editSettings.subtitleFontScale === sz.id
                                      ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                                  }`}
                                >
                                  {sz.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-neutral-100 dark:border-neutral-800">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400 mr-0.5">
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
                                  className={`w-5 h-5 rounded-full ${c.swatch} cursor-pointer transition-transform ${
                                    selected
                                      ? "ring-2 ring-offset-1 ring-neutral-950 dark:ring-white dark:ring-offset-neutral-950 scale-110"
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
                              className={`h-6 px-2 rounded-md border text-[11px] font-medium cursor-pointer transition-colors ${
                                editSettings.showWordGloss
                                  ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-600 dark:bg-teal-950/60 dark:text-teal-200"
                                  : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-500"
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
                              className={`h-6 px-2 rounded-md border text-[11px] font-medium cursor-pointer transition-colors ${
                                editSettings.showBurmeseLine
                                  ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-600 dark:bg-teal-950/60 dark:text-teal-200"
                                  : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-500"
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
                                className="h-6 px-2 rounded-md text-[11px] font-medium text-neutral-500 hover:text-neutral-950 dark:hover:text-white underline cursor-pointer"
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
                className="p-3.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                    New Subtitle
                  </span>
                  <div className="flex items-center gap-1.5 text-xs">
                    <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
                      <span>Start</span>
                      <input
                        type="number"
                        step="0.1"
                        min={0}
                        max={project.targetDurationSec}
                        value={newSubStart}
                        onChange={(e) => setNewSubStart(e.target.value)}
                        className="w-16 h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white font-mono-tabular text-xs"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
                      <span>End</span>
                      <input
                        type="number"
                        step="0.1"
                        min={0.2}
                        max={project.targetDurationSec}
                        value={newSubEnd}
                        onChange={(e) => setNewSubEnd(e.target.value)}
                        className="w-16 h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white font-mono-tabular text-xs"
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
                      className="h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-[11px] font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer whitespace-nowrap"
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
                  className="w-full h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-sm font-medium text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                />

                <input
                  type="text"
                  value={newSubBurmese}
                  onChange={(e) => setNewSubBurmese(e.target.value)}
                  placeholder="မြန်မာဘာသာပြန်..."
                  aria-label="New Burmese translation subtitle"
                  className="w-full h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 font-myanmar text-[13px] text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                />

                <div className="flex items-center justify-end gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setShowAddSub(false)}
                    className="h-8 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!newSubPhonetic.trim() && !newSubBurmese.trim()}
                    className="h-8 px-3.5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 cursor-pointer"
                  >
                    Add
                  </button>
                </div>
              </form>
            )}

            {subtitleRegenError && (
              <div className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
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

            {/* Editable Subtitles */}
            {project.subtitles.length === 0 ? (
              <div className="p-6 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 text-center space-y-2.5">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  No subtitles in this video yet.
                </p>
                <button
                  type="button"
                  onClick={openAddSubtitleForm}
                  className="h-8 px-3.5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center gap-1.5 hover:opacity-90 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Subtitle</span>
                </button>
              </div>
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
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
                      <div className="p-6 text-center space-y-2 bg-white dark:bg-neutral-950">
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          No subtitles match “{subSearchQuery}”.
                        </p>
                        <button
                          type="button"
                          onClick={() => setSubSearchQuery("")}
                          className="text-xs font-medium underline text-neutral-900 dark:text-neutral-100 cursor-pointer"
                        >
                          Clear filter
                        </button>
                      </div>
                    );
                  }

                  return (
                    <>
                      {needle && (
                        <div className="px-3.5 py-2 bg-neutral-50 dark:bg-neutral-900 text-[11px] text-neutral-500 dark:text-neutral-400 flex items-center justify-between">
                          <span>
                            Showing {visibleSubs.length} of {project.subtitles.length} subtitles
                          </span>
                          <button
                            type="button"
                            onClick={() => setSubSearchQuery("")}
                            className="underline hover:text-neutral-900 dark:hover:text-white cursor-pointer"
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
                            className={`p-3.5 transition-colors ${
                              isLooping
                                ? "bg-emerald-50/70 dark:bg-emerald-950/30"
                                : isCurrent
                                  ? "bg-neutral-100 dark:bg-neutral-900"
                                  : "bg-white dark:bg-neutral-950"
                            }`}
                          >
                        <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <button
                              type="button"
                              onClick={() => onSeek(sub.startTime)}
                              className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white cursor-pointer shrink-0"
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
                            <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate">
                              {sub.originalSpokenText}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => onToggleLoopSubtitle(sub.id)}
                              title={isLooping ? "Stop looping this line" : "Loop play this subtitle"}
                              aria-label={isLooping ? "Stop looping this line" : "Loop play this subtitle"}
                              className={`h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                isLooping
                                  ? "border-emerald-400 dark:border-emerald-600 bg-emerald-100/90 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-200"
                                  : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                                className="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-semibold border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 hover:bg-red-100 dark:hover:bg-red-900/70 text-red-700 dark:text-red-300 transition-colors cursor-pointer whitespace-nowrap"
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
                                className="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
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
                              className={`h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                isHintOpen || hintValue.trim()
                                  ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50/70 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300"
                                  : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                                className={`h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                                  isEditingWords
                                    ? "border-teal-400 dark:border-teal-600 bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300"
                                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                              title="Split subtitle into two lines (at playhead if inside, or midpoint)"
                              aria-label="Split subtitle into two lines"
                              className="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
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
                                className="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-medium border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer whitespace-nowrap"
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
                              className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer ${
                                isEditingTime
                                  ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-950 dark:text-white"
                                  : "text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                              className="w-7 h-7 rounded-md flex items-center justify-center text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
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
                            className="mb-2.5 p-2.5 rounded-lg border border-indigo-200/80 dark:border-indigo-900/70 bg-indigo-50/50 dark:bg-indigo-950/30 space-y-2"
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
                                  className="px-2 py-0.5 rounded border border-indigo-200/80 dark:border-indigo-800 bg-white dark:bg-neutral-950 text-[10px] font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100/70 dark:hover:bg-indigo-900/50 cursor-pointer whitespace-nowrap"
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
                                className="flex-1 min-w-0 h-8 px-2.5 rounded-md border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-neutral-950 text-xs text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:border-indigo-500"
                              />
                              {isRegenerating ? (
                                <button
                                  type="button"
                                  onClick={() => onCancelRegenerateSubtitle?.(sub.id)}
                                  className="h-8 px-3 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/70 hover:bg-red-100 dark:hover:bg-red-900 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <Square className="w-2.5 h-2.5 fill-current" />
                                  <span>Stop</span>
                                </button>
                              ) : (
                                <button
                                  type="submit"
                                  disabled={isRetranslatingAll || isResyncingTimings}
                                  className="h-8 px-3 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                                >
                                  <Sparkles className="w-3 h-3" />
                                  <span>Regenerate</span>
                                </button>
                              )}
                            </div>
                          </form>
                        )}

                        {isEditingTime && (
                          <div className="mb-2 flex flex-wrap items-center gap-2 p-2 rounded-lg bg-neutral-100/80 dark:bg-neutral-800/70 text-xs">
                            <label className="flex items-center gap-1 text-neutral-600 dark:text-neutral-300">
                              <span>Start (s)</span>
                              <input
                                type="number"
                                step="0.1"
                                min={0}
                                max={project.targetDurationSec}
                                value={editStartVal}
                                onChange={(e) => setEditStartVal(e.target.value)}
                                className="w-16 h-7 px-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono-tabular text-xs"
                              />
                            </label>
                            <label className="flex items-center gap-1 text-neutral-600 dark:text-neutral-300">
                              <span>End (s)</span>
                              <input
                                type="number"
                                step="0.1"
                                min={0.2}
                                max={project.targetDurationSec}
                                value={editEndVal}
                                onChange={(e) => setEditEndVal(e.target.value)}
                                className="w-16 h-7 px-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono-tabular text-xs"
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
                                  className="h-7 px-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono-tabular text-[11px] hover:bg-neutral-200/70 dark:hover:bg-neutral-800 cursor-pointer"
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
                                className="h-7 px-2.5 rounded bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
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
                            className="w-full text-[13px] font-medium text-indigo-700 dark:text-indigo-300 bg-transparent border-b border-transparent focus:border-indigo-400 dark:focus:border-indigo-500 focus:outline-none py-0.5 mb-0.5"
                          />
                        )}

                        <input
                          type="text"
                          value={sub.thaiPhonetic}
                          onChange={(e) => onUpdateSubtitle(sub.id, "thaiPhonetic", e.target.value)}
                          placeholder="Thai phonetic..."
                          aria-label="Thai in English phonetics"
                          className="w-full text-sm font-semibold text-neutral-950 dark:text-neutral-50 bg-transparent border-b border-transparent focus:border-neutral-400 dark:focus:border-neutral-600 focus:outline-none py-0.5"
                        />

                        <input
                          type="text"
                          value={sub.burmese}
                          onChange={(e) => onUpdateSubtitle(sub.id, "burmese", e.target.value)}
                          placeholder="မြန်မာဘာသာပြန်..."
                          aria-label="Burmese translation"
                          className="w-full font-myanmar text-[13px] text-neutral-700 dark:text-neutral-300 bg-transparent border-b border-transparent focus:border-neutral-400 dark:focus:border-neutral-600 focus:outline-none py-0.5 mt-1"
                        />

                        {isEditingWords && sub.words.length > 0 && (
                          <div className="mt-2.5 pt-2.5 border-t border-neutral-200/80 dark:border-neutral-800 space-y-1.5">
                            <span className="block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                              Word-by-Word Burmese Gloss (9:16 Stage)
                            </span>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              {sub.words.map((word, wi) => (
                                <div
                                  key={`${sub.id}-gloss-${wi}`}
                                  className="flex items-center gap-2 px-2 py-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
                                >
                                  <div className="min-w-0 shrink-0 max-w-[45%]">
                                    <p className="text-[11px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                                      {word.phonetic}
                                    </p>
                                    {word.thai && word.thai !== word.phonetic && (
                                      <p className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
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
                                    className="flex-1 min-w-0 h-6 px-1.5 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 font-myanmar text-[11px] text-teal-800 dark:text-teal-200 placeholder:text-neutral-400 focus:outline-none focus:border-teal-500"
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
  );
}
