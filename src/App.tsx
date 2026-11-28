import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpFromLine,
  Bookmark,
  Check,
  Clapperboard,
  Compass,
  FolderOpen,
  Loader2,
  Moon,
  RefreshCw,
  Sun,
} from "lucide-react";
import type {
  LocalStudioMedia,
  SavedProjectRecord,
  SceneSelection,
  SpeechRegion,
  SpeakingScene,
  SubtitleGenerationConfig,
  SubtitleGenerationProgress,
  SubtitleItem,
  SubtitleSourceLanguage,
  SubtitleWord,
  TranscriptModelId,
  TranscriptProgress,
  TranscriptResult,
  TranslationTone,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeSourcePreview,
  YouTubeVideo,
} from "./types";
import { DEFAULT_STAGE_PREVIEW_SCALE, Stage9x16, type Stage9x16Handle } from "./components/Stage9x16";
import { mapCutTimeToSource } from "./components/ScenePlayer";
import {
  WorkspaceSidebar,
  type StudioSectionId,
  type WorkspaceTab,
} from "./components/WorkspaceSidebar";
import { ProjectTimelineEditor } from "./components/ProjectTimelineEditor";
import { EmptyStudioUpload } from "./components/EmptyStudioUpload";
import { ExportSheet } from "./components/ExportSheet";
import { PasteStructuredTranscriptDialog } from "./components/PasteStructuredTranscriptDialog";
import { OfflineIndicator, PWAInstallButton } from "./components/PWAInstallButton";
import {
  exportProjectToMp4,
  type ExportedVideoResult,
  type ExportProgress,
} from "./utils/exportVideo";
import { DEFAULT_VOICE_SETTINGS } from "./utils/voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./utils/videoFilters";
import {
  loadSavedSubtitleGenConfig,
  saveSubtitleGenConfig,
} from "./utils/subtitleGenerationConfig";
import { resumeAllVoiceContexts } from "./utils/webAudioVoice";
import {
  formatReadableApiError,
  readStreamingProcessResponse,
  safeReadJson,
  uploadBlobInChunks,
} from "./utils/uploadFile";
import { extractMp4AudioClips } from "./utils/mp4ClipAudio";
import { runTranscriptGeneration } from "./utils/whisperTranscriber";
import type { StructuredTranscriptImportResult } from "./utils/pasteTranscriptSync";
import { makeSafeFileSlug } from "./utils/exportSubtitles";
import {
  ensureSceneIds,
  findActiveSubtitle,
  getSceneDurationSec,
  remapSubtitlesToScenes,
  withSceneId,
} from "./utils/projectTimeline";
import { seedPassiveTimelineThumbsForVideoUrl } from "./utils/timelineThumbBus";
import { hasGeneratedProject, hasProjectMedia } from "./utils/projectState";
import {
  MAX_HISTORY,
  pushCapped,
  snapshotsEqual,
  type ProjectSnapshot,
} from "./utils/projectHistory";
import {
  attachLocalVideoToSavedProject,
  deleteSavedProject,
  exportProjectAsJson,
  getSavedProjectBlob,
  importProjectFromJsonText,
  inferVideoMimeType,
  isLegacyYouTubeProject,
  listSavedProjects,
  materializeReadableBlob,
  renameSavedProject,
  sanitizeEditSettings,
  sanitizeVoiceSettings,
  saveOfflineProject,
} from "./utils/offlineProjects";
import {
  projectSpeechRegionsToCutTimeline,
  type TimelineSegmentLike,
} from "./utils/audioSpeechAnalyzer";
import {
  applyFindReplaceToSubtitles,
  buildWordsFromPhonetic,
  findExactSubtitleAtTime,
  isKeyboardShortcutBlockedByElement,
  mergeRetranslatedSubtitles,
  mergeWordChipsInSubtitle,
  resolveNextSelectedSubtitleId,
  selectSubtitlesForRetranslation,
  splitWordChipInSubtitle,
  updateWordChipInSubtitle,
  type AutoFollowState,
} from "./utils/subtitleState";

// Temporarily hide all caption-related UI while keeping underlying caption logic intact
const SHOW_CAPTIONS_UI = false;

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("theme") === "dark";
  });

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [licenseFilter, setLicenseFilter] = useState<YouTubeLicenseFilter>("all");
  const [thaiOnly, setThaiOnly] = useState<boolean>(false);
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [nextContinuation, setNextContinuation] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("youtube");
  const [studioSection, setStudioSection] = useState<StudioSectionId>("edit");
  const [timelineCollapsed, setTimelineCollapsed] = useState<boolean>(false);
  const [localMedia, setLocalMedia] = useState<LocalStudioMedia | null>(null);
  const [sourcePreview, setSourcePreview] = useState<YouTubeSourcePreview | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    ...DEFAULT_VOICE_SETTINGS,
  });
  const [videoEdit, setVideoEdit] = useState<VideoEditSettings>({
    ...DEFAULT_VIDEO_EDIT,
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<SubtitleGenerationProgress | null>(
    null
  );
  const [regeneratingClipId, setRegeneratingClipId] = useState<string | null>(null);
  const [regeneratingClipPercent, setRegeneratingClipPercent] = useState<number | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [regeneratingSubIds, setRegeneratingSubIds] = useState<string[]>([]);
  const [retranslatingSubIds, setRetranslatingSubIds] = useState<string[]>([]);
  const [isRetranslatingAll, setIsRetranslatingAll] = useState(false);
  const [isResyncingTimings, setIsResyncingTimings] = useState(false);
  const [transcribingRange, setTranscribingRange] = useState<{
    startSec: number;
    endSec: number;
  } | null>(null);
  const [subtitleRegenError, setSubtitleRegenError] = useState<string | null>(null);
  const [loopingSubId, setLoopingSubId] = useState<string | null>(null);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null);
  const [editingSubtitleId, setEditingSubtitleId] = useState<string | null>(null);
  const [showPasteTranscriptDialog, setShowPasteTranscriptDialog] = useState(false);
  const [subtitleGenConfig, setSubtitleGenConfig] = useState<SubtitleGenerationConfig>(
    () => loadSavedSubtitleGenConfig()
  );
  const [captionTab, setCaptionTab] = useState<"script" | "style" | "sync">("script");
  const [isSubtitleSearchOpen, setIsSubtitleSearchOpen] = useState(false);
  const [autoFollowState, setAutoFollowState] = useState<AutoFollowState>("following");
  const [stageSelectRequest, setStageSelectRequest] = useState<{
    id: string;
    focusPhonetic?: boolean;
    source?: "stage" | "timeline" | "keyboard";
    nonce: number;
  } | null>(null);
  const [shortcutToast, setShortcutToast] = useState<string | null>(null);
  const [baselineSubRegions, setBaselineSubRegions] = useState<SpeechRegion[]>([]);

  const [project, setProject] = useState<VideoProject | null>(null);
  const selectedScenes = useMemo<SceneSelection[]>(() => {
    if (!project) return [];
    return ensureSceneIds(project.scenes).map((sc) => ({
      id: sc.id!,
      startSec: sc.startSec,
      endSec: sc.endSec,
    }));
  }, [project]);
  const [cutTime, setCutTime] = useState(0);
  const [seekNonce, setSeekNonce] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [readyDownload, setReadyDownload] = useState<ExportedVideoResult | null>(null);
  const [exportedSignature, setExportedSignature] = useState<string | null>(null);
  const [hasSavedExport, setHasSavedExport] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  const exportAbortRef = useRef<AbortController | null>(null);

  const [savedProjects, setSavedProjects] = useState<SavedProjectRecord[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [isLoadingSaved, setIsLoadingSaved] = useState(true);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [ytPreviewSec, setYtPreviewSec] = useState(0);
  const [ytSeekRequest, setYtSeekRequest] = useState<{ sec: number; nonce: number } | null>(null);
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true
  );
  const [stagePreviewScale, setStagePreviewScale] = useState<number>(DEFAULT_STAGE_PREVIEW_SCALE);

  const [isExportingAudio, setIsExportingAudio] = useState(false);

  const [transcriptModelId, setTranscriptModelId] =
    useState<TranscriptModelId>("whisper-base");
  const [transcriptLanguage, setTranscriptLanguage] =
    useState<SubtitleSourceLanguage>("auto");
  const [transcriptWordTimestamps, setTranscriptWordTimestamps] = useState(false);
  const [isTranscribingStandalone, setIsTranscribingStandalone] = useState(false);
  const [transcriptProgress, setTranscriptProgress] =
    useState<TranscriptProgress | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptResult, setTranscriptResult] = useState<TranscriptResult | null>(null);

  const activeRunIdRef = useRef(0);
  const lastGenActionRef = useRef<{ type: "all" } | { type: "clip"; sceneId: string } | null>(null);
  const generateAbortRef = useRef<AbortController | null>(null);
  const standaloneTranscriptAbortRef = useRef<AbortController | null>(null);
  const resyncAbortRef = useRef<AbortController | null>(null);
  const transcribeRangeAbortRef = useRef<AbortController | null>(null);
  const retranslateAbortRef = useRef<AbortController | null>(null);
  const regenAbortMapRef = useRef<Map<string, AbortController>>(new Map());
  const searchSeqRef = useRef(0);
  const createdUrlsRef = useRef<string[]>([]);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef<VideoProject | null>(null);
  projectRef.current = project;
  const loopingSubIdRef = useRef<string | null>(null);
  loopingSubIdRef.current = loopingSubId;
  const selectedSubtitleIdRef = useRef<string | null>(null);
  selectedSubtitleIdRef.current = selectedSubtitleId;
  const autoFollowStateRef = useRef<AutoFollowState>(autoFollowState);
  autoFollowStateRef.current = autoFollowState;
  const isSubtitleSearchOpenRef = useRef(false);
  isSubtitleSearchOpenRef.current = isSubtitleSearchOpen;
  const exportSheetOpenRef = useRef(false);
  exportSheetOpenRef.current = exportSheetOpen;
  const activeTabRef = useRef<WorkspaceTab>(activeTab);
  activeTabRef.current = activeTab;
  const studioSectionRef = useRef<StudioSectionId>(studioSection);
  studioSectionRef.current = studioSection;
  const prevSubtitlesRef = useRef<SubtitleItem[]>([]);
  const shortcutToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cutTimeRef = useRef(0);
  cutTimeRef.current = cutTime;
  const liveCutTimeRef = useRef(0);
  const cutTimeListenersRef = useRef<Set<(sec: number) => void>>(new Set());
  const lastReactCutSyncAtRef = useRef(0);
  const lastLoopSeekAtRef = useRef(0);

  const showShortcutToast = useCallback((message: string) => {
    setShortcutToast(message);
    if (shortcutToastTimerRef.current) {
      clearTimeout(shortcutToastTimerRef.current);
    }
    shortcutToastTimerRef.current = setTimeout(() => {
      setShortcutToast(null);
      shortcutToastTimerRef.current = null;
    }, 2400);
  }, []);

  useEffect(() => {
    return () => {
      if (shortcutToastTimerRef.current) {
        clearTimeout(shortcutToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!editingSubtitleId) return;
    if (studioSection !== "edit") {
      setEditingSubtitleId(null);
      return;
    }
    if (!project || !project.subtitles.some((s) => s.id === editingSubtitleId)) {
      setEditingSubtitleId(null);
    }
  }, [editingSubtitleId, studioSection, project]);

  const handleChangeSubtitleGenConfig = useCallback((next: SubtitleGenerationConfig) => {
    setSubtitleGenConfig(next);
    saveSubtitleGenConfig(next);
  }, []);

  const subscribeCutTime = useCallback((listener: (sec: number) => void) => {
    cutTimeListenersRef.current.add(listener);
    return () => {
      cutTimeListenersRef.current.delete(listener);
    };
  }, []);

  const getLiveCutTime = useCallback(() => liveCutTimeRef.current, []);

  const lastLiveSeekAtRef = useRef<number>(0);

  const publishCutTime = useCallback((sec: number, syncReactNow = true) => {
    const safeSec = typeof sec === "number" && Number.isFinite(sec) ? Math.max(0, sec) : 0;
    liveCutTimeRef.current = safeSec;
    cutTimeListenersRef.current.forEach((fn) => fn(safeSec));
    if (syncReactNow) {
      lastReactCutSyncAtRef.current = performance.now();
      setCutTime(safeSec);
    }
  }, []);

  useEffect(() => {
    if (!isPlaying && performance.now() - lastLiveSeekAtRef.current > 400) {
      liveCutTimeRef.current = cutTime;
      cutTimeListenersRef.current.forEach((fn) => fn(cutTime));
    }
  }, [cutTime, isPlaying]);
  const timelineBaselineRef = useRef<{
    scenes: SpeakingScene[];
    subtitles: SubtitleItem[];
  } | null>(null);
  const [timelineDirty, setTimelineDirty] = useState(false);

  const [undoStack, setUndoStack] = useState<ProjectSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectSnapshot[]>([]);
  const undoStackRef = useRef<ProjectSnapshot[]>([]);
  undoStackRef.current = undoStack;
  const redoStackRef = useRef<ProjectSnapshot[]>([]);
  redoStackRef.current = redoStack;
  const lastSubTypingCoalesceRef = useRef<{ key: string; at: number } | null>(null);

  const cloneSubtitleList = useCallback(
    (subs: SubtitleItem[]): SubtitleItem[] =>
      subs.map((sub) => ({
        ...sub,
        words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
      })),
    []
  );

  const captureProjectSnapshot = useCallback(
    (proj: VideoProject): ProjectSnapshot => ({
      scenes: proj.scenes,
      subtitles: proj.subtitles,
      baselineSubtitles: timelineBaselineRef.current?.subtitles ?? null,
      baselineScenes: timelineBaselineRef.current?.scenes ?? null,
    }),
    []
  );

  const applyProjectSnapshot = useCallback((snap: ProjectSnapshot) => {
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current = {
        scenes: snap.baselineScenes ?? timelineBaselineRef.current.scenes,
        subtitles: snap.baselineSubtitles ?? timelineBaselineRef.current.subtitles,
      };
    } else if (snap.baselineScenes || snap.baselineSubtitles) {
      timelineBaselineRef.current = {
        scenes: snap.baselineScenes ?? [],
        subtitles: snap.baselineSubtitles ?? [],
      };
    }

    const baseScenes = timelineBaselineRef.current?.scenes;
    if (!baseScenes) {
      setTimelineDirty(false);
    } else {
      const dirty =
        baseScenes.length !== snap.scenes.length ||
        baseScenes.some(
          (b, idx) =>
            Math.abs(b.startSec - snap.scenes[idx].startSec) > 0.05 ||
            Math.abs(b.endSec - snap.scenes[idx].endSec) > 0.05
        );
      setTimelineDirty(dirty);
    }

    setProject((prev) => {
      if (!prev) return prev;
      const nextTargetDurationSec =
        prev.scenes === snap.scenes
          ? prev.targetDurationSec
          : Number(
              snap.scenes
                .reduce((acc, sc) => acc + getSceneDurationSec(sc), 0)
                .toFixed(2)
            );
      return {
        ...prev,
        scenes: snap.scenes,
        subtitles: snap.subtitles,
        targetDurationSec: nextTargetDurationSec,
      };
    });
  }, []);

  const pushProjectUndo = useCallback(
    (coalesceKey?: string) => {
      const curProj = projectRef.current;
      if (!curProj) return;
      if (coalesceKey) {
        const now = performance.now();
        if (
          lastSubTypingCoalesceRef.current &&
          lastSubTypingCoalesceRef.current.key === coalesceKey &&
          now - lastSubTypingCoalesceRef.current.at < 800
        ) {
          lastSubTypingCoalesceRef.current.at = now;
          return;
        }
        lastSubTypingCoalesceRef.current = { key: coalesceKey, at: now };
      } else {
        lastSubTypingCoalesceRef.current = null;
      }

      const snap = captureProjectSnapshot(curProj);
      setUndoStack((prev) =>
        prev.length > 0 && snapshotsEqual(prev[prev.length - 1], snap)
          ? prev
          : pushCapped(prev, snap, MAX_HISTORY)
      );
      setRedoStack([]);
    },
    [captureProjectSnapshot]
  );

  const pushSubtitleUndo = pushProjectUndo;

  const handleUndo = useCallback(() => {
    const curProj = projectRef.current;
    const undoList = undoStackRef.current;
    if (!curProj || undoList.length === 0) return;

    const prevSnap = undoList[undoList.length - 1];
    const currentSnap = captureProjectSnapshot(curProj);

    lastSubTypingCoalesceRef.current = null;
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) =>
      prev.length > 0 && snapshotsEqual(prev[prev.length - 1], currentSnap)
        ? prev
        : pushCapped(prev, currentSnap, MAX_HISTORY)
    );
    applyProjectSnapshot(prevSnap);
  }, [applyProjectSnapshot, captureProjectSnapshot]);

  const handleRedo = useCallback(() => {
    const curProj = projectRef.current;
    const redoList = redoStackRef.current;
    if (!curProj || redoList.length === 0) return;

    const nextSnap = redoList[redoList.length - 1];
    const currentSnap = captureProjectSnapshot(curProj);

    lastSubTypingCoalesceRef.current = null;
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) =>
      prev.length > 0 && snapshotsEqual(prev[prev.length - 1], currentSnap)
        ? prev
        : pushCapped(prev, currentSnap, MAX_HISTORY)
    );
    applyProjectSnapshot(nextSnap);
  }, [applyProjectSnapshot, captureProjectSnapshot]);

  const setBaselineFromProject = useCallback((proj: VideoProject | null) => {
    resyncAbortRef.current?.abort();
    resyncAbortRef.current = null;
    transcribeRangeAbortRef.current?.abort();
    transcribeRangeAbortRef.current = null;
    retranslateAbortRef.current?.abort();
    retranslateAbortRef.current = null;
    regenAbortMapRef.current.forEach((ctrl) => ctrl.abort());
    regenAbortMapRef.current.clear();
    setIsResyncingTimings(false);
    setTranscribingRange(null);
    setIsRetranslatingAll(false);
    setRetranslatingSubIds([]);
    setRegeneratingSubIds([]);

    lastSubTypingCoalesceRef.current = null;
    setUndoStack([]);
    setRedoStack([]);
    prevSubtitlesRef.current = proj?.subtitles ?? [];
    setSelectedSubtitleId(null);
    setIsSubtitleSearchOpen(false);
    setAutoFollowState("following");
    setBaselineSubRegions(
      proj?.subtitles.map((s) => ({
        sourceStartSec: s.sourceStartSec,
        sourceEndSec: s.sourceEndSec,
      })) ?? []
    );
    if (!proj) {
      timelineBaselineRef.current = null;
      setTimelineDirty(false);
      return;
    }
    timelineBaselineRef.current = {
      scenes: ensureSceneIds(proj.scenes).map((s) => ({ ...s })),
      subtitles: proj.subtitles.map((sub) => ({
        ...sub,
        words: sub.words.map((w) => ({ ...w })),
      })),
    };
    setTimelineDirty(false);
  }, []);

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

  const cutSpeechRegions = useMemo(() => {
    if (!project) return [];
    const normalized = ensureSceneIds(project.scenes);
    let cursor = 0;
    const segments: TimelineSegmentLike[] = normalized.map((sc) => {
      const clipDur = Math.max(0.1, sc.endSec - sc.startSec);
      const seg: TimelineSegmentLike = {
        startSec: sc.startSec,
        endSec: sc.endSec,
        clipDur,
        cutStart: cursor,
        cutEnd: cursor + clipDur,
      };
      cursor += clipDur;
      return seg;
    });
    const resolvedSpeechRegions: SpeechRegion[] =
      project.speechRegions && project.speechRegions.length > 0
        ? project.speechRegions
        : baselineSubRegions.length > 0
          ? baselineSubRegions
          : project.subtitles.map((s) => ({
              sourceStartSec: s.sourceStartSec,
              sourceEndSec: s.sourceEndSec,
            }));
    const primary = projectSpeechRegionsToCutTimeline(segments, resolvedSpeechRegions);
    if (primary.length > 0) return primary;
    const fallbackSubs: SpeechRegion[] =
      baselineSubRegions.length > 0
        ? baselineSubRegions
        : project.subtitles.map((s) => ({
            sourceStartSec: s.sourceStartSec,
            sourceEndSec: s.sourceEndSec,
          }));
    return projectSpeechRegionsToCutTimeline(segments, fallbackSubs);
  }, [project, baselineSubRegions]);

  // Automatically fall back selectedSubtitleId to adjacent row or null when removed via delete/merge/undo/redo/trim
  useEffect(() => {
    const prevSubs = prevSubtitlesRef.current;
    const nextSubs = project?.subtitles ?? [];
    prevSubtitlesRef.current = nextSubs;
    setSelectedSubtitleId((cur) => resolveNextSelectedSubtitleId(prevSubs, nextSubs, cur));
  }, [project?.subtitles]);

  useEffect(() => {
    if (!localMedia && !hasProjectMedia(project) && studioSection !== "edit") {
      setStudioSection("edit");
    }
  }, [localMedia, project, studioSection]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsDesktop(mql.matches);
    setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const registerBlobUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    createdUrlsRef.current.push(url);
    return url;
  }, []);

  useEffect(() => {
    return () => {
      for (const u of createdUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      createdUrlsRef.current = [];
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Sync dark mode class onto <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [darkMode]);

  const runSearch = useCallback(
    async (
      query: string,
      license: YouTubeLicenseFilter,
      onlyThai: boolean,
      continuation?: string | null,
      forceRefresh = false
    ) => {
      const seq = ++searchSeqRef.current;
      const cleanQuery = query.trim();
      const isAppend = Boolean(continuation);

      if (isAppend) {
        setIsLoadingMore(true);
      } else {
        setActiveQuery(cleanQuery);
        setIsSearching(true);
        setSearchError(null);
      }

      try {
        const params = new URLSearchParams({
          q: cleanQuery,
          license,
          ...(onlyThai ? { thaiOnly: "1" } : {}),
        });
        if (continuation) {
          params.set("continuation", continuation);
        } else if (forceRefresh) {
          params.set("refresh", "1");
        }

        const resp = await fetch(`/api/youtube/search?${params.toString()}`, {
          cache: "no-store",
        });
        const data = await safeReadJson<{
          videos?: YouTubeVideo[];
          nextContinuation?: string | null;
          error?: string;
        }>(resp);
        if (!resp.ok) throw new Error(data.error || "Search failed");
        if (searchSeqRef.current !== seq) return;

        const incoming = data.videos || [];
        if (isAppend) {
          setVideos((prev) => {
            const seen = new Set(prev.map((v) => v.videoId));
            const extra = incoming.filter((v) => !seen.has(v.videoId));
            return [...prev, ...extra];
          });
        } else {
          setVideos(incoming);
          if (incoming.length === 1 && /^https?:\/\//i.test(cleanQuery)) {
            const first = incoming[0];
            setYtPreviewSec(0);
            setYtSeekRequest(null);
            setSourcePreview({
              sourceType: "youtube",
              videoId: first.videoId,
              title: first.title,
              channel: first.channel,
              durationSec: first.durationSec,
              thumbnail: first.thumbnail,
            });
          }
        }
        setNextContinuation(data.nextContinuation ?? null);
      } catch (err) {
        if (searchSeqRef.current === seq) {
          setSearchError(err instanceof Error ? err.message : "Failed to load videos.");
        }
      } finally {
        if (searchSeqRef.current === seq) {
          if (isAppend) {
            setIsLoadingMore(false);
          } else {
            setIsSearching(false);
          }
        }
      }
    },
    []
  );

  useEffect(() => {
    runSearch("", "all", false);
  }, [runSearch]);

  // Pre-load the first recommended YouTube video into Source preview by default
  useEffect(() => {
    if (!sourcePreview && videos.length > 0) {
      const first = videos[0];
      setSourcePreview({
        sourceType: "youtube",
        videoId: first.videoId,
        title: first.title,
        channel: first.channel,
        durationSec: first.durationSec,
        thumbnail: first.thumbnail,
      });
    }
  }, [sourcePreview, videos]);

  const handleChangeLicenseFilter = useCallback(
    (nextLicense: YouTubeLicenseFilter) => {
      setLicenseFilter(nextLicense);
      runSearch(activeQuery, nextLicense, thaiOnly);
    },
    [activeQuery, thaiOnly, runSearch]
  );

  const handleToggleThaiOnly = useCallback(() => {
    const nextThai = !thaiOnly;
    setThaiOnly(nextThai);
    runSearch(activeQuery, licenseFilter, nextThai, null, true);
  }, [activeQuery, licenseFilter, thaiOnly, runSearch]);

  const handleLoadMoreVideos = useCallback(() => {
    if (!nextContinuation || isSearching || isLoadingMore) return;
    runSearch(activeQuery, licenseFilter, thaiOnly, nextContinuation);
  }, [activeQuery, licenseFilter, thaiOnly, nextContinuation, isSearching, isLoadingMore, runSearch]);

  const handleResetToRecommended = useCallback(() => {
    setSearchInput("");
    runSearch("", licenseFilter, thaiOnly, null, true);
  }, [licenseFilter, thaiOnly, runSearch]);

  const handleRefreshRecommended = useCallback(() => {
    if (isSearching) return;
    runSearch("", licenseFilter, thaiOnly, null, true);
  }, [isSearching, licenseFilter, thaiOnly, runSearch]);

  useEffect(() => {
    let mounted = true;
    listSavedProjects()
      .then((items) => {
        if (mounted) setSavedProjects(items);
      })
      .catch(() => {
        // Ignore if IndexedDB is blocked in private mode
      })
      .finally(() => {
        if (mounted) setIsLoadingSaved(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Clicking a YouTube video updates only Source tab preview without touching Studio state
  const handleSelectVideo = (video: YouTubeVideo) => {
    setYtPreviewSec(0);
    setYtSeekRequest(null);
    setSourcePreview({
      sourceType: "youtube",
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      durationSec: video.durationSec,
      thumbnail: video.thumbnail,
    });
    setActiveTab("youtube");
  };

  const buildDraftLocalProject = useCallback(
    (
      media: LocalStudioMedia,
      scenesInput: SceneSelection[],
      overrides?: {
        title?: string;
        channel?: string;
        sourceDurationSec?: number;
        keyframeUrls?: string[];
      }
    ): VideoProject => {
      const normalizedScenes: SpeakingScene[] = scenesInput.map((sc, idx) => {
        const dur = Math.max(0.1, Number((sc.endSec - sc.startSec).toFixed(2)));
        return {
          id: sc.id,
          index: idx,
          startSec: sc.startSec,
          endSec: sc.endSec,
          durationSec: dur,
          summary: `Scene ${idx + 1}`,
        };
      });
      const totalDurationSec = Number(
        normalizedScenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0).toFixed(2)
      );
      return {
        isDraft: true,
        localUrl: media.localUrl,
        localFile: media.localFile,
        uploadId: media.uploadId,
        title: overrides?.title || media.title,
        channel: overrides?.channel || media.channel,
        sourceDurationSec: overrides?.sourceDurationSec ?? media.durationSec,
        targetDurationSec: totalDurationSec,
        scenes: normalizedScenes,
        subtitles: [],
        keyframeUrls:
          overrides?.keyframeUrls ?? (media.thumbnail ? [media.thumbnail] : []),
      };
    },
    []
  );

  // Uploading a local video opens it in Watch & Scenes first without auto-generating
  const handleUploadLocalVideo = async (rawFile: File) => {
    const uploadRunId = ++activeRunIdRef.current;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);
    setProject(null);
    setBaselineFromProject(null);
    standaloneTranscriptAbortRef.current?.abort();
    standaloneTranscriptAbortRef.current = null;
    setIsTranscribingStandalone(false);
    setTranscriptProgress(null);
    setTranscriptError(null);
    setTranscriptResult(null);

    const resolvedMime = inferVideoMimeType(rawFile.name, rawFile.type);
    let file: File = rawFile;
    if (rawFile.size > 0 && rawFile.size <= 64 * 1024 * 1024) {
      try {
        const byteBlob = await materializeReadableBlob(rawFile, resolvedMime);
        if (activeRunIdRef.current !== uploadRunId) return;
        file = new File(
          [byteBlob],
          rawFile.name,
          resolvedMime ? { type: resolvedMime } : undefined
        );
      } catch {
        file = rawFile;
      }
    }
    if (activeRunIdRef.current !== uploadRunId) return;

    const localUrl = registerBlobUrl(file);
    const durationSec = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      let done = false;
      const finish = (dur: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.onloadedmetadata = null;
        v.onerror = null;
        try {
          v.pause();
          v.removeAttribute("src");
          v.load();
        } catch {
          // ignore
        }
        resolve(dur);
      };
      const timer = setTimeout(() => finish(120), 6000);
      v.onloadedmetadata = () => {
        const raw = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 120;
        finish(Math.max(0.5, Math.round(raw * 10) / 10));
      };
      v.onerror = () => finish(120);
      v.src = localUrl;
    });
    if (activeRunIdRef.current !== uploadRunId) {
      URL.revokeObjectURL(localUrl);
      createdUrlsRef.current = createdUrlsRef.current.filter((u) => u !== localUrl);
      return;
    }

    const uploadedMedia: LocalStudioMedia = {
      sourceType: "local",
      localUrl,
      localFile: file,
      title: file.name.replace(/\.[^.]+$/, ""),
      channel: "Local Video",
      durationSec,
    };
    const initialScenes: SceneSelection[] = [
      {
        id: `sc-${Date.now()}`,
        startSec: 0,
        endSec: durationSec,
      },
    ];
    const draftProj = buildDraftLocalProject(uploadedMedia, initialScenes);
    setLocalMedia(uploadedMedia);
    setProject(draftProj);
    setBaselineFromProject(draftProj);
    setActiveTab("studio");
    setStudioSection("edit");
  };

  const handleDetectedLocalDuration = useCallback((rawDur: number) => {
    const dur = Math.max(0.5, Math.round(rawDur * 10) / 10);
    if (!Number.isFinite(dur) || dur <= 0) return;

    setLocalMedia((prev) => (prev ? { ...prev, durationSec: dur } : prev));

    const curProj = projectRef.current;
    const canAutoSyncDraftScene = Boolean(
      curProj &&
        curProj.isDraft &&
        undoStackRef.current.length === 0 &&
        redoStackRef.current.length === 0 &&
        curProj.scenes.length === 1 &&
        !curProj.scenes[0].mediaUrl &&
        curProj.scenes[0].mediaType !== "image" &&
        curProj.scenes[0].startSec === 0 &&
        Math.abs(curProj.scenes[0].endSec - (curProj.sourceDurationSec || dur)) < 0.25 &&
        Math.abs(curProj.scenes[0].endSec - dur) > 0.05
    );

    if (canAutoSyncDraftScene && curProj) {
      const syncedScene: SpeakingScene = {
        ...curProj.scenes[0],
        endSec: dur,
        durationSec: Number(dur.toFixed(2)),
      };
      if (timelineBaselineRef.current) {
        timelineBaselineRef.current = {
          ...timelineBaselineRef.current,
          scenes: [{ ...syncedScene }],
        };
      }
      setProject((prev) => {
        if (!prev || !prev.isDraft || prev.scenes.length !== 1) {
          return prev;
        }
        return {
          ...prev,
          sourceDurationSec: dur,
          targetDurationSec: Number(dur.toFixed(2)),
          scenes: [
            {
              ...prev.scenes[0],
              endSec: dur,
              durationSec: Number(dur.toFixed(2)),
            },
          ],
        };
      });
      return;
    }

    setProject((prev) => (prev ? { ...prev, sourceDurationSec: dur } : prev));
  }, []);

  const handleAddMediaClip = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const curProj = projectRef.current;
    if (!curProj) {
      const firstVideo = files.find(
        (f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(f.name)
      );
      if (firstVideo) {
        await handleUploadLocalVideo(firstVideo);
      }
      return;
    }

    const sessionRunId = activeRunIdRef.current;
    const addedScenes: SpeakingScene[] = [];
    const baseIdx = curProj.scenes.length;

    for (let i = 0; i < files.length; i++) {
      const rawFile = files[i];
      const isImage =
        rawFile.type.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|svg)$/i.test(rawFile.name);
      const cleanName = rawFile.name.replace(/\.[^.]+$/, "").trim();

      if (isImage) {
        const mediaUrl = registerBlobUrl(rawFile);
        await new Promise<void>((resolve) => {
          const img = new Image();
          const timer = window.setTimeout(resolve, 2500);
          img.onload = () => {
            window.clearTimeout(timer);
            resolve();
          };
          img.onerror = () => {
            window.clearTimeout(timer);
            resolve();
          };
          img.src = mediaUrl;
        });
        if (activeRunIdRef.current !== sessionRunId) return;

        addedScenes.push({
          id: `proj-img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          index: baseIdx + addedScenes.length,
          startSec: 0,
          endSec: 3,
          durationSec: 3,
          summary: cleanName || `Image ${baseIdx + addedScenes.length + 1}`,
          mediaType: "image",
          mediaUrl,
          mediaFile: rawFile,
          sourceDurationSec: 60,
        });
      } else {
        const resolvedMime = inferVideoMimeType(rawFile.name, rawFile.type);
        let file: File = rawFile;
        if (rawFile.size > 0 && rawFile.size <= 64 * 1024 * 1024) {
          try {
            const byteBlob = await materializeReadableBlob(rawFile, resolvedMime);
            if (activeRunIdRef.current !== sessionRunId) return;
            file = new File(
              [byteBlob],
              rawFile.name,
              resolvedMime ? { type: resolvedMime } : undefined
            );
          } catch {
            file = rawFile;
          }
        }
        if (activeRunIdRef.current !== sessionRunId) return;

        const mediaUrl = registerBlobUrl(file);
        const durationSec = await new Promise<number>((resolve) => {
          const v = document.createElement("video");
          v.muted = true;
          v.playsInline = true;
          v.preload = "metadata";
          let done = false;
          const finish = (dur: number) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            v.onloadedmetadata = null;
            v.onerror = null;
            try {
              v.pause();
              v.removeAttribute("src");
              v.load();
            } catch {
              // ignore
            }
            resolve(dur);
          };
          const timer = setTimeout(() => finish(10), 6000);
          v.onloadedmetadata = () => {
            const raw = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10;
            finish(Math.max(0.5, Math.round(raw * 10) / 10));
          };
          v.onerror = () => finish(10);
          v.src = mediaUrl;
        });
        if (activeRunIdRef.current !== sessionRunId) return;

        void seedPassiveTimelineThumbsForVideoUrl(mediaUrl, durationSec);

        addedScenes.push({
          id: `proj-vid-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          index: baseIdx + addedScenes.length,
          startSec: 0,
          endSec: durationSec,
          durationSec,
          summary: cleanName || `Clip ${baseIdx + addedScenes.length + 1}`,
          mediaType: "video",
          mediaUrl,
          mediaFile: file,
          sourceDurationSec: durationSec,
        });
      }
    }

    if (addedScenes.length === 0) return;

    const latestProj = projectRef.current;
    if (!latestProj) return;

    pushProjectUndo();
    const prevCutDuration = latestProj.scenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0);
    const nextScenes = ensureSceneIds([...latestProj.scenes, ...addedScenes]);
    const nextDuration = Number(
      nextScenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0).toFixed(2)
    );
    checkTimelineDirty(nextScenes);

    setProject((prev) => {
      if (!prev) return prev;
      const baselineSubs = timelineBaselineRef.current?.subtitles ?? prev.subtitles;
      const nextSubtitles = remapSubtitlesToScenes(baselineSubs, nextScenes);
      return {
        ...prev,
        scenes: nextScenes,
        targetDurationSec: nextDuration,
        subtitles: nextSubtitles,
      };
    });

    setIsPlaying(false);
    publishCutTime(prevCutDuration, true);
    setSeekNonce((n) => n + 1);
    setSaveNotice(
      addedScenes.length === 1
        ? `Added ${addedScenes[0].mediaType === "image" ? "image" : "video"} clip to timeline.`
        : `Added ${addedScenes.length} clips to timeline.`
    );
  };

  const handleClearLocalVideo = () => {
    activeRunIdRef.current++;
    if (localMedia?.localUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(localMedia.localUrl);
      createdUrlsRef.current = createdUrlsRef.current.filter((u) => u !== localMedia.localUrl);
    }
    for (const sc of projectRef.current?.scenes ?? []) {
      if (sc.mediaUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(sc.mediaUrl);
        createdUrlsRef.current = createdUrlsRef.current.filter((u) => u !== sc.mediaUrl);
      }
    }
    setIsProcessing(false);
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);
    setLocalMedia(null);
    standaloneTranscriptAbortRef.current?.abort();
    standaloneTranscriptAbortRef.current = null;
    setIsTranscribingStandalone(false);
    setTranscriptProgress(null);
    setTranscriptError(null);
    setTranscriptResult(null);
    setProject((prev) => {
      if (prev) {
        setBaselineFromProject(null);
        return null;
      }
      return prev;
    });
    setActiveTab("studio");
    setStudioSection("edit");
  };

  const handleCancelStandaloneTranscript = useCallback(() => {
    standaloneTranscriptAbortRef.current?.abort();
    standaloneTranscriptAbortRef.current = null;
    setIsTranscribingStandalone(false);
    setTranscriptProgress(null);
  }, []);

  const handleStartStandaloneTranscript = useCallback(async () => {
    const file = projectRef.current?.localFile || localMedia?.localFile;
    if (!file) {
      setTranscriptError("Please upload or link a local video file first.");
      return;
    }

    standaloneTranscriptAbortRef.current?.abort();
    const ctrl = new AbortController();
    standaloneTranscriptAbortRef.current = ctrl;

    setTranscriptError(null);
    setIsTranscribingStandalone(true);
    setTranscriptProgress({
      phase: "extracting",
      label: "Preparing audio...",
      percent: 5,
    });

    try {
      const projectScenesById = new Map(
        (projectRef.current?.scenes ?? []).map((sc, idx) => [
          sc.id || `sc-${idx}-${sc.startSec}-${sc.endSec}`,
          sc,
        ])
      );
      const videoOnlyScenes = selectedScenes.filter((sel) => {
        const matched = projectScenesById.get(sel.id);
        return !matched || matched.mediaType !== "image";
      });
      const activeScenes =
        videoOnlyScenes.length > 0
          ? videoOnlyScenes
          : [
              {
                id: "sc-full",
                startSec: 0,
                endSec: Math.max(1, localMedia?.durationSec ?? projectRef.current?.sourceDurationSec ?? 120),
              },
            ];

      const result = await runTranscriptGeneration({
        file,
        title: localMedia?.title || projectRef.current?.title || file.name,
        scenes: activeScenes,
        modelId: transcriptModelId,
        language: transcriptLanguage,
        wordTimestamps: transcriptWordTimestamps,
        uploadId: projectRef.current?.uploadId || localMedia?.uploadId,
        onUploadId: (uploadId) => {
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          setProject((prev) => (prev ? { ...prev, uploadId } : prev));
        },
        signal: ctrl.signal,
        onProgress: (p) => {
          if (!ctrl.signal.aborted) {
            setTranscriptProgress(p);
          }
        },
      });

      if (ctrl.signal.aborted) return;
      setTranscriptResult(result);
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setTranscriptError(
        formatReadableApiError(err, "Failed to generate transcript. Try a smaller model or Cloud AI.")
      );
    } finally {
      if (standaloneTranscriptAbortRef.current === ctrl) {
        standaloneTranscriptAbortRef.current = null;
      }
      setIsTranscribingStandalone(false);
      setTranscriptProgress(null);
    }
  }, [
    localMedia,
    selectedScenes,
    transcriptLanguage,
    transcriptModelId,
    transcriptWordTimestamps,
  ]);

  const handleUpdateTranscriptSegmentText = useCallback(
    (segmentId: string, text: string) => {
      setTranscriptResult((prev) => {
        if (!prev) return prev;
        const nextSegments = prev.segments.map((seg) =>
          seg.id === segmentId ? { ...seg, text } : seg
        );
        return {
          ...prev,
          segments: nextSegments,
          text: nextSegments.map((s) => s.text.trim()).filter(Boolean).join(" "),
        };
      });
    },
    []
  );

  const handleCancelGenerateSubtitles = useCallback(() => {
    activeRunIdRef.current++;
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    setIsProcessing(false);
    setGenerationProgress(null);
    setRegeneratingClipId(null);
    setRegeneratingClipPercent(null);
    setProcessError(null);
  }, []);

  const mergeSingleClipIntoProject = useCallback(
    (
      prevProj: VideoProject | null,
      allSelectedScenes: SceneSelection[],
      targetIdx: number,
      returnedData: VideoProject,
      targetMedia: LocalStudioMedia
    ): VideoProject => {
      const prevScenes = prevProj ? ensureSceneIds(prevProj.scenes) : [];
      const prevOffsets: number[] = [];
      let prevCursor = 0;
      for (const sc of prevScenes) {
        prevOffsets.push(prevCursor);
        prevCursor += getSceneDurationSec(sc);
      }

      const returnedScene = returnedData.scenes[0];
      const mergedScenes: SpeakingScene[] = allSelectedScenes.map((sel, idx) => {
        const dur = Math.max(0.1, Math.round((sel.endSec - sel.startSec) * 100) / 100);
        if (idx === targetIdx) {
          return {
            id: sel.id,
            index: idx,
            startSec: sel.startSec,
            endSec: sel.endSec,
            durationSec: dur,
            summary: returnedScene?.summary || `Clip ${idx + 1}`,
          };
        }
        const matchedPrev = prevScenes.find(
          (ps) =>
            ps.id === sel.id ||
            (Math.abs(ps.startSec - sel.startSec) < 0.15 &&
              Math.abs(ps.endSec - sel.endSec) < 0.15)
        );
        return {
          id: sel.id,
          index: idx,
          startSec: sel.startSec,
          endSec: sel.endSec,
          durationSec: dur,
          summary: matchedPrev?.summary || `Clip ${idx + 1}`,
        };
      });

      const mergedOffsets: number[] = [];
      let mergedCursor = 0;
      for (const sc of mergedScenes) {
        mergedOffsets.push(mergedCursor);
        mergedCursor += getSceneDurationSec(sc);
      }
      const totalDurationSec = Math.round(mergedCursor * 100) / 100;

      const preservedSubs: SubtitleItem[] = [];
      if (prevProj && prevScenes.length > 0) {
        for (const sub of prevProj.subtitles) {
          const idMatchedOldIdx = sub.sceneId
            ? prevScenes.findIndex((ps) => ps.id === sub.sceneId)
            : -1;
          const oldIdx =
            idMatchedOldIdx !== -1
              ? idMatchedOldIdx
              : sub.sceneIndex >= 0 && sub.sceneIndex < prevScenes.length
                ? sub.sceneIndex
                : 0;
          const oldScene = prevScenes[oldIdx];
          if (!oldScene) continue;

          let matchedNewIdx = sub.sceneId
            ? mergedScenes.findIndex((ms) => ms.id === sub.sceneId)
            : -1;
          if (matchedNewIdx === -1) {
            matchedNewIdx = mergedScenes.findIndex(
              (ms) =>
                ms.id === oldScene.id ||
                (Math.abs(ms.startSec - oldScene.startSec) < 0.15 &&
                  Math.abs(ms.endSec - oldScene.endSec) < 0.15)
            );
          }
          if (matchedNewIdx === -1 || matchedNewIdx === targetIdx) {
            continue;
          }

          const localStart = Math.max(0, sub.startTime - (prevOffsets[oldIdx] ?? 0));
          const localEnd = Math.max(localStart + 0.08, sub.endTime - (prevOffsets[oldIdx] ?? 0));
          const targetDur = getSceneDurationSec(mergedScenes[matchedNewIdx]);
          const clampedStart = Math.min(targetDur, localStart);
          const clampedEnd = Math.min(targetDur, localEnd);
          const newStart = Math.round(((mergedOffsets[matchedNewIdx] ?? 0) + clampedStart) * 100) / 100;
          const newEnd = Math.round(((mergedOffsets[matchedNewIdx] ?? 0) + clampedEnd) * 100) / 100;

          preservedSubs.push(
            withSceneId(
              {
                ...sub,
                sceneIndex: matchedNewIdx,
                startTime: newStart,
                endTime: Math.max(newStart + 0.08, newEnd),
              },
              mergedScenes
            )
          );
        }
      }

      const targetOffset = mergedOffsets[targetIdx] ?? 0;
      const targetClipDur = getSceneDurationSec(mergedScenes[targetIdx]);
      const batchNonce = Date.now().toString(36);
      const newClipSubs: SubtitleItem[] = returnedData.subtitles.map((sub, k) => {
        const clampedStart = Math.max(0, Math.min(targetClipDur, sub.startTime));
        const clampedEnd = Math.max(clampedStart + 0.08, Math.min(targetClipDur, sub.endTime));
        const absStart = Math.round((targetOffset + clampedStart) * 100) / 100;
        const absEnd = Math.round((targetOffset + clampedEnd) * 100) / 100;
        return withSceneId(
          {
            ...sub,
            id: `sub-c${targetIdx}-${batchNonce}-${k + 1}`,
            sceneIndex: targetIdx,
            startTime: absStart,
            endTime: Math.max(absStart + 0.08, absEnd),
          },
          mergedScenes
        );
      });

      const mergedSubtitles = [...preservedSubs, ...newClipSubs].sort(
        (a, b) => a.startTime - b.startTime
      );
      const speechRegions = mergedSubtitles.map((s) => ({
        sourceStartSec: s.sourceStartSec,
        sourceEndSec: s.sourceEndSec,
      }));

      const { isDraft: _dropDraft, ...baseProj } = prevProj || returnedData;

      return {
        ...baseProj,
        title: prevProj?.title || targetMedia.title,
        channel: prevProj?.channel || targetMedia.channel,
        sourceDurationSec: targetMedia.durationSec,
        targetDurationSec: totalDurationSec,
        scenes: mergedScenes,
        subtitles: mergedSubtitles,
        speechRegions,
        keyframeUrls: prevProj?.keyframeUrls?.length ? prevProj.keyframeUrls : returnedData.keyframeUrls,
        localUrl: targetMedia.localUrl,
        localFile: targetMedia.localFile,
        uploadId: targetMedia.uploadId,
      };
    },
    []
  );

  const attachSceneIdsFromServerProject = useCallback(
    (
      serverData: VideoProject,
      priorScenes?: Array<{ id?: string; startSec: number; endSec: number }>
    ): VideoProject => {
      const rawScenes = Array.isArray(serverData.scenes) ? serverData.scenes : [];
      const usedIds = new Set<string>();
      const scenesWithPreservedIds = rawScenes.map((sc, idx) => {
        if (sc.id) {
          usedIds.add(sc.id);
          return sc;
        }
        if (!priorScenes || priorScenes.length === 0) return sc;
        const sameIdx = priorScenes[idx];
        const matched =
          sameIdx &&
          sameIdx.id &&
          !usedIds.has(sameIdx.id) &&
          Math.abs(sameIdx.startSec - sc.startSec) < 0.15 &&
          Math.abs(sameIdx.endSec - sc.endSec) < 0.15
            ? sameIdx
            : priorScenes.find(
                (ps) =>
                  ps.id &&
                  !usedIds.has(ps.id) &&
                  Math.abs(ps.startSec - sc.startSec) < 0.15 &&
                  Math.abs(ps.endSec - sc.endSec) < 0.15
              );
        if (matched?.id) {
          usedIds.add(matched.id);
          return { ...sc, id: matched.id };
        }
        return sc;
      });
      const scenes = ensureSceneIds(scenesWithPreservedIds);
      const subtitles = (Array.isArray(serverData.subtitles) ? serverData.subtitles : []).map(
        (sub) =>
          withSceneId(
            {
              ...sub,
              aiSourceStartSec:
                typeof sub.aiSourceStartSec === "number" && Number.isFinite(sub.aiSourceStartSec)
                  ? sub.aiSourceStartSec
                  : sub.sourceStartSec,
              aiSourceEndSec:
                typeof sub.aiSourceEndSec === "number" && Number.isFinite(sub.aiSourceEndSec)
                  ? sub.aiSourceEndSec
                  : sub.sourceEndSec,
            },
            scenes
          )
      );
      return {
        ...serverData,
        scenes,
        subtitles,
      };
    },
    []
  );

  // Triggered explicitly by the user after configuring Advanced Settings for Generate/Regenerate Subtitle
  const handleGenerateSubtitles = async (configOverride?: SubtitleGenerationConfig) => {
    const targetMedia = localMedia;
    if (!targetMedia || !targetMedia.localFile || selectedScenes.length === 0) return;

    const activeGenConfig = configOverride ?? subtitleGenConfig;
    if (configOverride) {
      handleChangeSubtitleGenConfig(configOverride);
    }

    const legacyTone: TranslationTone =
      activeGenConfig.translationTone === "formal" ||
      activeGenConfig.translationTone === "dramatic" ||
      activeGenConfig.translationTone === "literal"
        ? activeGenConfig.translationTone
        : "casual";

    lastGenActionRef.current = { type: "all" };
    const runId = ++activeRunIdRef.current;
    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setIsPlaying(false);
    setCutTime(0);
    setIsProcessing(true);
    setRegeneratingClipId(null);
    setRegeneratingClipPercent(null);
    setProcessError(null);
    setGenerationProgress({
      stage: "extracting",
      label: !targetMedia.uploadId ? "Extracting clip audio..." : "Preparing clips...",
      percent: 4,
      totalClips: selectedScenes.length,
    });

    try {
      const scenePayload = selectedScenes.map(({ startSec, endSec }) => ({
        startSec,
        endSec,
      }));

      {
        let uploadId = targetMedia.uploadId;
        let resp: Response | null = null;

        if (!uploadId) {
          const fastClips = await extractMp4AudioClips(targetMedia.localFile, scenePayload);
          if (activeRunIdRef.current !== runId) return;
          if (fastClips && fastClips.length === scenePayload.length) {
            setGenerationProgress({
              stage: "extracting",
              label: "Sending clip audio...",
              percent: 16,
              totalClips: selectedScenes.length,
            });
            resp = await fetch("/api/process-clip-audio", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/x-ndjson",
              },
              body: JSON.stringify({
                title: targetMedia.title,
                durationSec: targetMedia.durationSec,
                clips: fastClips,
                translationTone: legacyTone,
                generationConfig: activeGenConfig,
                stream: true,
              }),
              signal: controller.signal,
            });
          } else {
            uploadId = await uploadBlobInChunks(
              targetMedia.localFile,
              targetMedia.localFile.name,
              controller.signal,
              (frac) => {
                if (activeRunIdRef.current !== runId) return;
                const pct = Math.max(2, Math.min(20, Math.round(frac * 20)));
                setGenerationProgress({
                  stage: "uploading",
                  label: `Uploading video (${Math.round(frac * 100)}%)...`,
                  percent: pct,
                  totalClips: selectedScenes.length,
                });
              }
            );
            if (activeRunIdRef.current !== runId) return;
            setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          }
        }

        if (!resp) {
          resp = await fetch("/api/process-upload", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson",
            },
            body: JSON.stringify({
              uploadId,
              title: targetMedia.title,
              durationSec: targetMedia.durationSec,
              selectedScenes: scenePayload,
              translationTone: legacyTone,
              generationConfig: activeGenConfig,
              stream: true,
            }),
            signal: controller.signal,
          });

          // If server restarted and tmp upload expired, try fast clip audio first, else re-upload
          if (resp.status === 404) {
            const fastClips = await extractMp4AudioClips(targetMedia.localFile, scenePayload);
            if (activeRunIdRef.current !== runId) return;
            if (fastClips && fastClips.length === scenePayload.length) {
              setLocalMedia((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
              resp = await fetch("/api/process-clip-audio", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/x-ndjson",
                },
                body: JSON.stringify({
                  title: targetMedia.title,
                  durationSec: targetMedia.durationSec,
                  clips: fastClips,
                  translationTone: legacyTone,
                  generationConfig: activeGenConfig,
                  stream: true,
                }),
                signal: controller.signal,
              });
            } else {
              uploadId = await uploadBlobInChunks(
                targetMedia.localFile,
                targetMedia.localFile.name,
                controller.signal,
                (frac) => {
                  if (activeRunIdRef.current !== runId) return;
                  const pct = Math.max(2, Math.min(20, Math.round(frac * 20)));
                  setGenerationProgress({
                    stage: "uploading",
                    label: `Uploading video (${Math.round(frac * 100)}%)...`,
                    percent: pct,
                    totalClips: selectedScenes.length,
                  });
                }
              );
              if (activeRunIdRef.current !== runId) return;
              setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
              resp = await fetch("/api/process-upload", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/x-ndjson",
                },
                body: JSON.stringify({
                  uploadId,
                  title: targetMedia.title,
                  durationSec: targetMedia.durationSec,
                  selectedScenes: scenePayload,
                  translationTone: legacyTone,
                  generationConfig: activeGenConfig,
                  stream: true,
                }),
                signal: controller.signal,
              });
            }
          }
        }

        const data = await readStreamingProcessResponse<VideoProject & { error?: string }>(
          resp,
          (ev) => {
            if (activeRunIdRef.current !== runId) return;
            setGenerationProgress(ev);
          }
        );
        if (activeRunIdRef.current !== runId) return;

        if (project && project.subtitles.length > 0) {
          pushSubtitleUndo();
        }

        const normalizedServerProj = attachSceneIdsFromServerProject(data, selectedScenes);
        const nextProj: VideoProject = {
          ...normalizedServerProj,
          localUrl: targetMedia.localUrl,
          localFile: targetMedia.localFile,
        };
        setProject(nextProj);
        setBaselineFromProject(nextProj);

        // Sync subtitle display toggles to match chosen generation format cleanly
        const hasTranslationLine =
          activeGenConfig.subtitleFormat !== "translation_only" &&
          activeGenConfig.subtitleFormat !== "original_only" &&
          activeGenConfig.targetLanguage !== "none";
        setVideoEdit((prev) => ({
          ...prev,
          translationTone: legacyTone,
          showBurmeseLine: hasTranslationLine,
          showWordGloss: hasTranslationLine && activeGenConfig.includeWordGloss,
          showThaiScript:
            activeGenConfig.subtitleFormat === "bilingual_phonetic"
              ? activeGenConfig.includeNativeScript && prev.showThaiScript
              : activeGenConfig.subtitleFormat === "bilingual_native"
                ? activeGenConfig.includeNativeScript
                : false,
        }));

        setActiveTab("studio");
        setStudioSection("edit");
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      if (activeRunIdRef.current === runId) {
        setProcessError(formatReadableApiError(err, "Failed to transcribe scenes."));
      }
    } finally {
      if (generateAbortRef.current === controller) {
        generateAbortRef.current = null;
      }
      if (activeRunIdRef.current === runId) {
        setIsProcessing(false);
        setGenerationProgress(null);
      }
    }
  };

  const handleExportAudioOnly = async () => {
    const targetMedia = localMedia;
    if (!targetMedia || isExportingAudio) return;

    const totalDur = Math.max(
      1,
      targetMedia.durationSec || project?.sourceDurationSec || 60
    );
    const scenePayload =
      selectedScenes.length > 0
        ? selectedScenes.map(({ startSec, endSec }) => ({ startSec, endSec }))
        : [{ startSec: 0, endSec: totalDur }];

    setIsExportingAudio(true);
    setProcessError(null);
    showShortcutToast("Extracting audio (.mp3)...");

    try {
      let uploadId = targetMedia.uploadId;
      let resp: Response | null = null;

      if (!uploadId && targetMedia.localFile) {
        const fastClips = await extractMp4AudioClips(targetMedia.localFile, scenePayload);
        if (fastClips && fastClips.length === scenePayload.length) {
          resp = await fetch("/api/export-audio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: targetMedia.title,
              durationSec: totalDur,
              clips: fastClips,
              format: "mp3",
            }),
          });
        } else {
          uploadId = await uploadBlobInChunks(
            targetMedia.localFile,
            targetMedia.localFile.name
          );
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        }
      }

      if (!resp) {
        if (!uploadId) {
          throw new Error("Please upload a local video file first before exporting audio.");
        }
        resp = await fetch("/api/export-audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId,
            title: targetMedia.title,
            durationSec: totalDur,
            selectedScenes: scenePayload,
            format: "mp3",
          }),
        });
      }

      if (!resp.ok) {
        const errData = await safeReadJson<{ error?: string }>(resp);
        throw new Error(errData?.error || "Failed to export audio.");
      }

      const audioBlob = await resp.blob();
      const slug = makeSafeFileSlug(targetMedia.title || "video");
      const filename = `${slug}-audio.mp3`;
      const url = URL.createObjectURL(audioBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      showShortcutToast(`Exported ${filename}`);
    } catch (err) {
      setProcessError(formatReadableApiError(err, "Failed to export audio."));
    } finally {
      setIsExportingAudio(false);
    }
  };

  const handleGenerateSingleClip = async (sceneId: string) => {
    const targetMedia = localMedia;
    if (!targetMedia || !targetMedia.localFile || selectedScenes.length === 0) return;

    const targetIdx = selectedScenes.findIndex((s) => s.id === sceneId);
    if (targetIdx === -1) return;
    const targetScene = selectedScenes[targetIdx];

    lastGenActionRef.current = { type: "clip", sceneId };
    const runId = ++activeRunIdRef.current;
    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setIsPlaying(false);
    setRegeneratingClipId(sceneId);
    setRegeneratingClipPercent(4);
    setProcessError(null);
    setSaveNotice(null);
    setGenerationProgress({
      stage: "extracting",
      label: `Clip ${targetIdx + 1}: Extracting audio...`,
      percent: 4,
      clipIndex: targetIdx + 1,
      totalClips: selectedScenes.length,
    });

    try {
      const singleScenePayload = [{ startSec: targetScene.startSec, endSec: targetScene.endSec }];
      let resolvedMedia = targetMedia;
      let data: VideoProject & { error?: string };

      {
        let uploadId = targetMedia.uploadId;
        let resp: Response | null = null;

        if (!uploadId) {
          const fastClips = await extractMp4AudioClips(targetMedia.localFile, singleScenePayload);
          if (activeRunIdRef.current !== runId) return;
          if (fastClips && fastClips.length === 1) {
            setRegeneratingClipPercent(16);
            setGenerationProgress({
              stage: "extracting",
              label: `Clip ${targetIdx + 1}: Sending clip audio...`,
              percent: 16,
              clipIndex: targetIdx + 1,
              totalClips: selectedScenes.length,
            });
            resp = await fetch("/api/process-clip-audio", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/x-ndjson",
              },
              body: JSON.stringify({
                title: targetMedia.title,
                durationSec: targetMedia.durationSec,
                clips: fastClips,
                translationTone: videoEdit.translationTone,
                generationConfig: subtitleGenConfig,
                stream: true,
              }),
              signal: controller.signal,
            });
          } else {
            uploadId = await uploadBlobInChunks(
              targetMedia.localFile,
              targetMedia.localFile.name,
              controller.signal,
              (frac) => {
                if (activeRunIdRef.current !== runId) return;
                const pct = Math.max(2, Math.min(20, Math.round(frac * 20)));
                setRegeneratingClipPercent(pct);
                setGenerationProgress({
                  stage: "uploading",
                  label: `Clip ${targetIdx + 1}: Uploading video (${Math.round(frac * 100)}%)...`,
                  percent: pct,
                  clipIndex: targetIdx + 1,
                  totalClips: selectedScenes.length,
                });
              }
            );
            if (activeRunIdRef.current !== runId) return;
            resolvedMedia = { ...targetMedia, uploadId };
            setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          }
        }

        if (!resp) {
          resp = await fetch("/api/process-upload", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson",
            },
            body: JSON.stringify({
              uploadId,
              title: targetMedia.title,
              durationSec: targetMedia.durationSec,
              selectedScenes: singleScenePayload,
              translationTone: videoEdit.translationTone,
              generationConfig: subtitleGenConfig,
              stream: true,
            }),
            signal: controller.signal,
          });

          if (resp.status === 404) {
            const fastClips = await extractMp4AudioClips(targetMedia.localFile, singleScenePayload);
            if (activeRunIdRef.current !== runId) return;
            if (fastClips && fastClips.length === 1) {
              resolvedMedia = { ...targetMedia, uploadId: undefined };
              setLocalMedia((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
              resp = await fetch("/api/process-clip-audio", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/x-ndjson",
                },
                body: JSON.stringify({
                  title: targetMedia.title,
                  durationSec: targetMedia.durationSec,
                  clips: fastClips,
                  translationTone: videoEdit.translationTone,
                  generationConfig: subtitleGenConfig,
                  stream: true,
                }),
                signal: controller.signal,
              });
            } else {
              uploadId = await uploadBlobInChunks(
                targetMedia.localFile,
                targetMedia.localFile.name,
                controller.signal,
                (frac) => {
                  if (activeRunIdRef.current !== runId) return;
                  const pct = Math.max(2, Math.min(20, Math.round(frac * 20)));
                  setRegeneratingClipPercent(pct);
                  setGenerationProgress({
                    stage: "uploading",
                    label: `Clip ${targetIdx + 1}: Uploading video (${Math.round(frac * 100)}%)...`,
                    percent: pct,
                    clipIndex: targetIdx + 1,
                    totalClips: selectedScenes.length,
                  });
                }
              );
              if (activeRunIdRef.current !== runId) return;
              resolvedMedia = { ...targetMedia, uploadId };
              setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
              resp = await fetch("/api/process-upload", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/x-ndjson",
                },
                body: JSON.stringify({
                  uploadId,
                  title: targetMedia.title,
                  durationSec: targetMedia.durationSec,
                  selectedScenes: singleScenePayload,
                  translationTone: videoEdit.translationTone,
                  stream: true,
                }),
                signal: controller.signal,
              });
            }
          }
        }

        data = await readStreamingProcessResponse<VideoProject & { error?: string }>(resp, (ev) => {
          if (activeRunIdRef.current !== runId) return;
          setRegeneratingClipPercent(ev.percent);
          setGenerationProgress({
            ...ev,
            label: `Clip ${targetIdx + 1}: ${ev.label}`,
            clipIndex: targetIdx + 1,
            totalClips: selectedScenes.length,
          });
        });
      }

      if (activeRunIdRef.current !== runId) return;
      const prevProj = projectRef.current;
      const hadGeneratedProj = hasGeneratedProject(prevProj);
      if (hadGeneratedProj) {
        pushProjectUndo();
      }
      const nextProj = mergeSingleClipIntoProject(
        prevProj,
        selectedScenes,
        targetIdx,
        data,
        resolvedMedia
      );
      setProject(nextProj);
      if (!hadGeneratedProj) {
        setBaselineFromProject(nextProj);
      } else if (timelineBaselineRef.current) {
        timelineBaselineRef.current = {
          scenes: ensureSceneIds(nextProj.scenes).map((s) => ({ ...s })),
          subtitles: cloneSubtitleList(nextProj.subtitles),
        };
        setTimelineDirty(false);
      }
      setSaveNotice(
        `Updated Clip ${targetIdx + 1} (${data.subtitles.length} ${
          data.subtitles.length === 1 ? "subtitle" : "subtitles"
        })`
      );
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      if (activeRunIdRef.current === runId) {
        setProcessError(
          `Clip ${targetIdx + 1}: ${formatReadableApiError(
            err,
            `Failed to generate subtitles for Clip ${targetIdx + 1}.`
          )}`
        );
      }
    } finally {
      if (generateAbortRef.current === controller) {
        generateAbortRef.current = null;
      }
      if (activeRunIdRef.current === runId) {
        setRegeneratingClipId(null);
        setRegeneratingClipPercent(null);
        setGenerationProgress(null);
      }
    }
  };

  const handleSeek = (sec: number, opts?: { live?: boolean }) => {
    const activeLoopId = loopingSubIdRef.current;
    if (activeLoopId) {
      const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
      if (!loopSub || sec < loopSub.startTime - 0.1 || sec > loopSub.endTime + 0.1) {
        setLoopingSubId(null);
      }
    }
    if (opts?.live) {
      lastLiveSeekAtRef.current = performance.now();
      publishCutTime(sec, false);
      stageRef.current?.seekCutTime(sec);
      return;
    }
    publishCutTime(sec, true);
    stageRef.current?.seekCutTime(sec, { force: true });
    setSeekNonce((n) => n + 1);
  };

  const handlePlayerTimeUpdate = useCallback(
    (rawCutTime: number) => {
      const newCutTime =
        typeof rawCutTime === "number" && Number.isFinite(rawCutTime) ? Math.max(0, rawCutTime) : 0;
      const activeLoopId = loopingSubIdRef.current;
      if (activeLoopId) {
        const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
        if (loopSub && newCutTime >= loopSub.endTime - 0.04) {
          const now = performance.now();
          if (now - lastLoopSeekAtRef.current > 180) {
            lastLoopSeekAtRef.current = now;
            publishCutTime(loopSub.startTime, true);
            setSeekNonce((n) => n + 1);
            return;
          }
        }
      }
      liveCutTimeRef.current = newCutTime;
      cutTimeListenersRef.current.forEach((fn) => fn(newCutTime));
      const now = performance.now();
      if (now - lastReactCutSyncAtRef.current >= 1000) {
        lastReactCutSyncAtRef.current = now;
        setCutTime(newCutTime);
      }
    },
    [publishCutTime]
  );

  const stageRef = useRef<Stage9x16Handle | null>(null);
  const handlePreviewSourceSeek = useCallback(
    (sourceSec: number | null, opts?: { skipResync?: boolean }) => {
      stageRef.current?.previewSourceTime(sourceSec, opts);
    },
    []
  );

  const handleScrubbingChange = useCallback((active: boolean) => {
    stageRef.current?.setScrubbing(active);
  }, []);

  const handlePlayingChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
    if (!playing) {
      lastReactCutSyncAtRef.current = performance.now();
      setCutTime(liveCutTimeRef.current);
    }
  }, []);

  const handlePlaybackEnded = useCallback(() => {
    const activeLoopId = loopingSubIdRef.current;
    if (activeLoopId) {
      const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
      if (loopSub) {
        lastLoopSeekAtRef.current = performance.now();
        publishCutTime(loopSub.startTime, true);
        setSeekNonce((n) => n + 1);
        setIsPlaying(true);
        return;
      }
    }
    setLoopingSubId(null);
    setIsPlaying(false);
    publishCutTime(0, true);
    setSeekNonce((n) => n + 1);
  }, [publishCutTime]);

  const handleTogglePlay = () => {
    const playableProj = hasProjectMedia(projectRef.current) ? projectRef.current : null;
    if (!playableProj || playableProj.scenes.length === 0) return;
    resumeAllVoiceContexts();
    if (isPlaying) {
      setLoopingSubId(null);
      stageRef.current?.pause();
      setIsPlaying(false);
      setCutTime(liveCutTimeRef.current);
    } else {
      stageRef.current?.play();
      setIsPlaying(true);
    }
  };

  const handlePause = useCallback(() => {
    setLoopingSubId(null);
    stageRef.current?.pause();
    setIsPlaying(false);
    setCutTime(liveCutTimeRef.current);
  }, []);

  const handlePlayFromTime = useCallback(
    (sec: number) => {
      const playableProj = hasProjectMedia(projectRef.current) ? projectRef.current : null;
      if (!playableProj || playableProj.scenes.length === 0) return;
      resumeAllVoiceContexts();
      setLoopingSubId(null);
      publishCutTime(sec, true);
      stageRef.current?.play();
      setIsPlaying(true);
    },
    [publishCutTime]
  );

  const handleToggleLoopSubtitle = useCallback(
    (id: string) => {
      if (!hasGeneratedProject(project) || project.scenes.length === 0) return;
      const targetSub = project.subtitles.find((s) => s.id === id);
      if (!targetSub) return;

      if (loopingSubIdRef.current === id && isPlaying) {
        setLoopingSubId(null);
        setIsPlaying(false);
        setCutTime(liveCutTimeRef.current);
        return;
      }

      resumeAllVoiceContexts();
      lastLoopSeekAtRef.current = performance.now();
      setLoopingSubId(id);
      publishCutTime(targetSub.startTime, true);
      setSeekNonce((n) => n + 1);
      setIsPlaying(true);
    },
    [project, isPlaying, publishCutTime]
  );

  const checkTimelineDirty = useCallback((nextScenes: SpeakingScene[]) => {
    const base = timelineBaselineRef.current?.scenes;
    if (!base) {
      setTimelineDirty(false);
      return;
    }
    const dirty =
      base.length !== nextScenes.length ||
      base.some(
        (b, idx) =>
          Math.abs(b.startSec - nextScenes[idx].startSec) > 0.05 ||
          Math.abs(b.endSec - nextScenes[idx].endSec) > 0.05 ||
          (b.mediaUrl || "") !== (nextScenes[idx].mediaUrl || "") ||
          (b.mediaType || "video") !== (nextScenes[idx].mediaType || "video")
      );
    setTimelineDirty(dirty);
  }, []);

  const handleUpdateProjectScenes = useCallback(
    (nextScenesRaw: SpeakingScene[]) => {
      const curProj = projectRef.current;
      if (!curProj) return;
      const prevScenes = ensureSceneIds(curProj.scenes);
      const nextScenes = ensureSceneIds(nextScenesRaw);
      const changed =
        nextScenes.length !== prevScenes.length ||
        nextScenes.some(
          (sc, idx) =>
            sc.id !== prevScenes[idx].id ||
            Math.abs(sc.startSec - prevScenes[idx].startSec) > 0.001 ||
            Math.abs(sc.endSec - prevScenes[idx].endSec) > 0.001 ||
            sc.summary !== prevScenes[idx].summary ||
            (sc.mediaUrl || "") !== (prevScenes[idx].mediaUrl || "") ||
            (sc.mediaType || "video") !== (prevScenes[idx].mediaType || "video")
        );
      if (!changed) return;

      pushProjectUndo();
      const nextDuration = Number(
        nextScenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0).toFixed(2)
      );
      checkTimelineDirty(nextScenes);

      setProject((prev) => {
        if (!prev) return prev;
        const baselineSubs = timelineBaselineRef.current?.subtitles ?? prev.subtitles;
        const nextSubtitles = remapSubtitlesToScenes(baselineSubs, nextScenes);
        return {
          ...prev,
          scenes: nextScenes,
          targetDurationSec: nextDuration,
          subtitles: nextSubtitles,
        };
      });
    },
    [checkTimelineDirty, pushProjectUndo]
  );

  const handleResetTimeline = useCallback(() => {
    const base = timelineBaselineRef.current;
    const curProj = projectRef.current;
    if (!base || !curProj) return;
    pushProjectUndo();
    const nextScenes = ensureSceneIds(base.scenes).map((s) => ({ ...s }));
    const nextDuration = Number(
      nextScenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0).toFixed(2)
    );
    setTimelineDirty(false);
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        scenes: nextScenes,
        targetDurationSec: nextDuration,
        subtitles: base.subtitles.map((sub) => ({
          ...sub,
          words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
        })),
      };
    });
  }, [pushProjectUndo]);

  const handleUpdateSubtitle = (
    id: string,
    field: "thaiPhonetic" | "burmese" | "thaiScript",
    value: string
  ) => {
    pushSubtitleUndo(`sub:${id}:${field}`);
    const applyEdit = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub: SubtitleItem) => {
        if (sub.id !== id) return sub;
        if (field === "burmese") return { ...sub, burmese: value, isManuallyEdited: true };
        if (field === "thaiScript") return { ...sub, thaiScript: value, isManuallyEdited: true };

        const tokens = value.split(/\s+/).filter(Boolean);
        if (tokens.length === sub.words.length && sub.words.length > 0) {
          const words = tokens.map((tok, wi) => ({
            ...sub.words[wi],
            phonetic: tok,
          }));
          return { ...sub, thaiPhonetic: value, words, isManuallyEdited: true };
        }

        const spanStart = sub.words[0]?.startOffsetSec ?? 0;
        const spanEnd = sub.words[sub.words.length - 1]?.endOffsetSec ?? (sub.endTime - sub.startTime);
        const words = buildWordsFromPhonetic(value, spanStart, spanEnd, sub.words);
        return { ...sub, thaiPhonetic: value, words, isManuallyEdited: true };
      });

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applyEdit(timelineBaselineRef.current.subtitles);
    }

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        subtitles: applyEdit(prev.subtitles),
      };
    });
  };

  const handleUpdateWordGloss = (
    subId: string,
    wordIndex: number,
    burmeseGloss: string
  ) => {
    pushSubtitleUndo(`gloss:${subId}:${wordIndex}`);
    const applyWordEdit = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub) => {
        if (sub.id !== subId) return sub;
        const words = sub.words.map((w, wi) =>
          wi === wordIndex ? { ...w, burmeseGloss } : w
        );
        return { ...sub, words, isManuallyEdited: true };
      });

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applyWordEdit(
        timelineBaselineRef.current.subtitles
      );
    }

    setProject((prev) =>
      prev ? { ...prev, subtitles: applyWordEdit(prev.subtitles) } : prev
    );
  };

  const handleUpdateWordChip = (
    subId: string,
    wordIndex: number,
    patch: { phonetic?: string; thai?: string; burmeseGloss?: string }
  ) => {
    pushSubtitleUndo(`wordchip:${subId}:${wordIndex}`);
    const applyChipEdit = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub) =>
        sub.id === subId ? updateWordChipInSubtitle(sub, wordIndex, patch) : sub
      );

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applyChipEdit(
        timelineBaselineRef.current.subtitles
      );
    }

    setProject((prev) =>
      prev ? { ...prev, subtitles: applyChipEdit(prev.subtitles) } : prev
    );
  };

  const handleMergeWordChips = (subId: string, leftIndex: number) => {
    pushSubtitleUndo();
    const applyMerge = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub) =>
        sub.id === subId ? mergeWordChipsInSubtitle(sub, leftIndex) : sub
      );

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applyMerge(
        timelineBaselineRef.current.subtitles
      );
    }

    setProject((prev) =>
      prev ? { ...prev, subtitles: applyMerge(prev.subtitles) } : prev
    );
  };

  const handleSplitWordChip = (
    subId: string,
    wordIndex: number,
    partA: string,
    partB: string,
    partAGloss?: string,
    partBGloss?: string
  ) => {
    pushSubtitleUndo();
    const applySplit = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub) =>
        sub.id === subId
          ? splitWordChipInSubtitle(
              sub,
              wordIndex,
              partA,
              partB,
              partAGloss,
              partBGloss
            )
          : sub
      );

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applySplit(
        timelineBaselineRef.current.subtitles
      );
    }

    setProject((prev) =>
      prev ? { ...prev, subtitles: applySplit(prev.subtitles) } : prev
    );
  };

  const handleAddSubtitle = (
    input: {
      startTime: number;
      endTime: number;
      thaiPhonetic: string;
      burmese: string;
      originalSpokenText?: string;
    },
    opts?: { select?: boolean; seekToStart?: boolean }
  ) => {
    if (!project) return;
    pushSubtitleUndo();
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);
    const startTime = Number(Math.max(0, Math.min(maxDur - 0.2, input.startTime)).toFixed(2));
    const endTime = Number(Math.max(startTime + 0.2, Math.min(maxDur, input.endTime)).toFixed(2));
    const duration = Math.max(0.2, endTime - startTime);
    const thaiPhonetic = input.thaiPhonetic.trim();
    const burmese = input.burmese.trim();
    const originalSpokenText =
      input.originalSpokenText !== undefined ? input.originalSpokenText.trim() : "Custom subtitle";
    const mappedStart = mapCutTimeToSource(project.scenes, startTime);
    const mappedEnd = mapCutTimeToSource(project.scenes, endTime);

    const mappedStartScene = project.scenes[mappedStart.sceneIndex];
    const newItem: SubtitleItem = withSceneId(
      {
        id: `sub-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sceneIndex: mappedStart.sceneIndex,
        mediaUrl: mappedStartScene?.mediaUrl,
        startTime,
        endTime,
        sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
        sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
        originalSpokenText,
        thaiPhonetic,
        thaiScript: thaiPhonetic,
        burmese,
        words: buildWordsFromPhonetic(thaiPhonetic, 0, duration),
        isManuallyEdited: true,
      },
      project.scenes
    );

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = [
        ...timelineBaselineRef.current.subtitles,
        { ...newItem, words: newItem.words.map((w) => ({ ...w })) },
      ].sort((a, b) => a.startTime - b.startTime);
    }

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        isDraft: false,
        subtitles: [...prev.subtitles, newItem].sort((a, b) => a.startTime - b.startTime),
      };
    });
    if (opts?.select !== false) {
      setSelectedSubtitleId(newItem.id);
      setStageSelectRequest({ id: newItem.id, focusPhonetic: false, nonce: Date.now() });
    }
    if (opts?.seekToStart !== false) {
      handleSeek(startTime);
    }
  };

  const handleApplyPastedTranscript = (
    result: StructuredTranscriptImportResult,
    mode: "replace" | "append"
  ) => {
    const curProj = projectRef.current;
    if (!curProj || result.subtitles.length === 0) return;

    const maxCutDur = Math.max(
      0.5,
      curProj.targetDurationSec || localMedia?.durationSec || result.targetDurationSec || 10
    );

    const clampSub = (sub: SubtitleItem): SubtitleItem => {
      const startTime = Number(Math.max(0, Math.min(maxCutDur - 0.15, sub.startTime)).toFixed(2));
      const endTime = Number(
        Math.max(startTime + 0.15, Math.min(maxCutDur, sub.endTime)).toFixed(2)
      );
      const duration = Math.max(0.15, endTime - startTime);
      const oldDur = Math.max(0.15, sub.endTime - sub.startTime);
      const ratio = duration / oldDur;
      const mappedStart = mapCutTimeToSource(curProj.scenes, startTime);
      const mappedEnd = mapCutTimeToSource(curProj.scenes, endTime);
      return withSceneId(
        {
          ...sub,
          sceneIndex: mappedStart.sceneIndex,
          startTime,
          endTime,
          sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
          sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
          words: sub.words.map((w) => ({
            ...w,
            startOffsetSec: Number(
              Math.max(0, Math.min(duration - 0.02, w.startOffsetSec * ratio)).toFixed(2)
            ),
            endOffsetSec: Number(
              Math.max(0.02, Math.min(duration, w.endOffsetSec * ratio)).toFixed(2)
            ),
          })),
        },
        curProj.scenes
      );
    };

    const normalizedSubs = result.subtitles.map(clampSub).sort((a, b) => a.startTime - b.startTime);
    if (normalizedSubs.length === 0) return;

    pushSubtitleUndo();

    const mergeSubtitles = (base: SubtitleItem[]) =>
      mode === "replace"
        ? normalizedSubs.map((s) => ({ ...s, words: s.words.map((w) => ({ ...w })) }))
        : [
            ...base,
            ...normalizedSubs.map((s) => ({ ...s, words: s.words.map((w) => ({ ...w })) })),
          ].sort((a, b) => a.startTime - b.startTime);

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = mergeSubtitles(
        timelineBaselineRef.current.subtitles
      );
    }

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        isDraft: false,
        subtitles: mergeSubtitles(prev.subtitles),
      };
    });

    setVideoEdit((prev) => ({
      ...prev,
      showBurmeseLine: result.hasBurmese ? true : prev.showBurmeseLine,
      showWordGloss: result.hasWords ? true : prev.showWordGloss,
      showThaiScript: result.hasThai ? true : prev.showThaiScript,
    }));

    const firstSub = normalizedSubs[0];
    setEditingSubtitleId(null);
    setSelectedSubtitleId(firstSub.id);
    setStageSelectRequest({ id: firstSub.id, focusPhonetic: false, nonce: Date.now() });
    handleSeek(firstSub.startTime);
    setShowPasteTranscriptDialog(false);
    setSaveNotice(
      mode === "replace" && curProj.subtitles.length > 0
        ? `Replaced subtitles with ${normalizedSubs.length} pasted ${
            normalizedSubs.length === 1 ? "line" : "lines"
          }.`
        : `Added ${normalizedSubs.length} pasted ${
            normalizedSubs.length === 1 ? "subtitle" : "subtitles"
          }.`
    );
  };

  const handleDeleteSubtitle = (id: string) => {
    if (project?.subtitles.some((s) => s.id === id)) {
      pushSubtitleUndo();
    }
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = timelineBaselineRef.current.subtitles.filter(
        (sub) => sub.id !== id
      );
    }
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        subtitles: prev.subtitles.filter((sub) => sub.id !== id),
      };
    });
  };

  const handleClearAllSubtitles = () => {
    const curProj = projectRef.current;
    if (!curProj || curProj.subtitles.length === 0) return;
    const clearedCount = curProj.subtitles.length;
    pushSubtitleUndo();
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = [];
    }
    setProject((prev) => (prev ? { ...prev, subtitles: [] } : prev));
    setSelectedSubtitleId(null);
    setEditingSubtitleId(null);
    setLoopingSubId(null);
    setSaveNotice(
      `Cleared ${clearedCount} ${clearedCount === 1 ? "subtitle" : "subtitles"}.`
    );
  };

  const handleFindReplaceSubtitles = (opts: {
    findText: string;
    replaceText: string;
    field: "all" | "burmese" | "thaiPhonetic" | "thaiScript";
    caseSensitive?: boolean;
  }): number => {
    if (!project || !opts.findText) return 0;
    const { subtitles: nextSubs, totalMatches } = applyFindReplaceToSubtitles(
      project.subtitles,
      opts
    );
    if (totalMatches === 0) return 0;

    pushSubtitleUndo();
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = applyFindReplaceToSubtitles(
        timelineBaselineRef.current.subtitles,
        opts
      ).subtitles;
    }
    setProject((prev) => (prev ? { ...prev, subtitles: nextSubs } : prev));
    return totalMatches;
  };

  const handleApplyPasteTranscriptSync = (
    syncedSubtitles: SubtitleItem[],
    changedCount: number
  ) => {
    if (!project || syncedSubtitles.length === 0 || changedCount <= 0) return;

    pushSubtitleUndo();
    const syncedById = new Map(syncedSubtitles.map((sub) => [sub.id, sub]));

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = timelineBaselineRef.current.subtitles.map(
        (baseSub) => {
          const updated = syncedById.get(baseSub.id);
          if (!updated) return baseSub;
          return {
            ...baseSub,
            thaiPhonetic: updated.thaiPhonetic,
            thaiScript: updated.thaiScript,
            burmese: updated.burmese,
            words: updated.words.map((w) => ({ ...w })),
            isManuallyEdited: Boolean(updated.isManuallyEdited),
          };
        }
      );
    }

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        subtitles: prev.subtitles.map((sub) => {
          const updated = syncedById.get(sub.id);
          if (!updated) return sub;
          return {
            ...sub,
            thaiPhonetic: updated.thaiPhonetic,
            thaiScript: updated.thaiScript,
            burmese: updated.burmese,
            words: updated.words.map((w) => ({ ...w })),
            isManuallyEdited: Boolean(updated.isManuallyEdited),
          };
        }),
      };
    });

    setSaveNotice(
      `Synced ${changedCount} subtitle ${changedCount === 1 ? "line" : "lines"} (timings preserved).`
    );
  };

  const handleUpdateSubtitleTiming = (id: string, nextStart: number, nextEnd: number) => {
    if (!project) return;
    pushSubtitleUndo();
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);
    const startTime = Number(Math.max(0, Math.min(maxDur - 0.2, nextStart)).toFixed(2));
    const endTime = Number(Math.max(startTime + 0.2, Math.min(maxDur, nextEnd)).toFixed(2));
    const newDur = Math.max(0.2, endTime - startTime);
    const mappedStart = mapCutTimeToSource(project.scenes, startTime);
    const mappedEnd = mapCutTimeToSource(project.scenes, endTime);

    const updateList = (list: SubtitleItem[]) =>
      list
        .map((sub) => {
          if (sub.id !== id) return sub;
          const oldDur = Math.max(0.2, sub.endTime - sub.startTime);
          const scale = newDur / oldDur;
          const words =
            sub.words.length > 0
              ? sub.words.map((w) => ({
                  ...w,
                  startOffsetSec: Number((w.startOffsetSec * scale).toFixed(2)),
                  endOffsetSec: Number(Math.min(newDur, w.endOffsetSec * scale).toFixed(2)),
                }))
              : buildWordsFromPhonetic(sub.thaiPhonetic, 0, newDur);
          return withSceneId(
            {
              ...sub,
              aiSourceStartSec:
                typeof sub.aiSourceStartSec === "number" && Number.isFinite(sub.aiSourceStartSec)
                  ? sub.aiSourceStartSec
                  : sub.sourceStartSec,
              aiSourceEndSec:
                typeof sub.aiSourceEndSec === "number" && Number.isFinite(sub.aiSourceEndSec)
                  ? sub.aiSourceEndSec
                  : sub.sourceEndSec,
              sceneIndex: mappedStart.sceneIndex,
              startTime,
              endTime,
              sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
              sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
              words,
            },
            project.scenes
          );
        })
        .sort((a, b) => a.startTime - b.startTime);

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = updateList(timelineBaselineRef.current.subtitles);
    }

    setProject((prev) => (prev ? { ...prev, subtitles: updateList(prev.subtitles) } : prev));
  };

  const handleShiftAllSubtitles = (deltaSec: number) => {
    if (!project || project.subtitles.length === 0 || !Number.isFinite(deltaSec)) return;
    pushSubtitleUndo();
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);

    const shiftList = (list: SubtitleItem[]): SubtitleItem[] =>
      list
        .map((sub) => {
          const origDur = Math.max(0.2, sub.endTime - sub.startTime);
          const nextStart = Number(
            Math.max(0, Math.min(Math.max(0, maxDur - 0.2), sub.startTime + deltaSec)).toFixed(2)
          );
          const nextEnd = Number(
            Math.max(nextStart + 0.2, Math.min(maxDur, nextStart + origDur)).toFixed(2)
          );
          const mappedStart = mapCutTimeToSource(project.scenes, nextStart);
          const mappedEnd = mapCutTimeToSource(project.scenes, nextEnd);
          return withSceneId(
            {
              ...sub,
              aiSourceStartSec:
                typeof sub.aiSourceStartSec === "number" && Number.isFinite(sub.aiSourceStartSec)
                  ? sub.aiSourceStartSec
                  : sub.sourceStartSec,
              aiSourceEndSec:
                typeof sub.aiSourceEndSec === "number" && Number.isFinite(sub.aiSourceEndSec)
                  ? sub.aiSourceEndSec
                  : sub.sourceEndSec,
              sceneIndex: mappedStart.sceneIndex,
              startTime: nextStart,
              endTime: nextEnd,
              sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
              sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
            },
            project.scenes
          );
        })
        .sort((a, b) => a.startTime - b.startTime);

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = shiftList(timelineBaselineRef.current.subtitles);
    }

    setProject((prev) => (prev ? { ...prev, subtitles: shiftList(prev.subtitles) } : prev));
  };

  const handleSplitSubtitle = (id: string) => {
    if (!project) return;
    const targetCheck = project.subtitles.find((s) => s.id === id);
    if (!targetCheck || targetCheck.endTime - targetCheck.startTime < 0.45) return;
    pushSubtitleUndo();
    const splitTextProportional = (text: string, ratio: number): [string, string] => {
      const clean = text.trim();
      if (!clean) return ["", ""];
      const tokens = clean.split(/\s+/);
      if (tokens.length >= 2) {
        const cutIdx = Math.max(1, Math.min(tokens.length - 1, Math.round(tokens.length * ratio)));
        return [tokens.slice(0, cutIdx).join(" "), tokens.slice(cutIdx).join(" ")];
      }
      const chars = Array.from(clean);
      if (chars.length < 4) return [clean, clean];
      const cutChar = Math.max(2, Math.min(chars.length - 2, Math.round(chars.length * ratio)));
      return [chars.slice(0, cutChar).join("").trim(), chars.slice(cutChar).join("").trim()];
    };

    const splitInList = (list: SubtitleItem[]): SubtitleItem[] => {
      const idx = list.findIndex((s) => s.id === id);
      if (idx === -1) return list;
      const target = list[idx];
      const dur = target.endTime - target.startTime;
      if (dur < 0.45) return list;

      const curCut = liveCutTimeRef.current;
      const usePlayhead =
        curCut > target.startTime + 0.22 && curCut < target.endTime - 0.22;
      let splitTime = usePlayhead ? curCut : target.startTime + dur * 0.5;
      let ratio = Math.max(0.2, Math.min(0.8, (splitTime - target.startTime) / dur));

      let words1: SubtitleWord[];
      let words2: SubtitleWord[];
      let phonetic1: string;
      let phonetic2: string;

      if (target.words.length >= 2) {
        const targetLocal = splitTime - target.startTime;
        let splitWordIdx = target.words.findIndex((w, wi) => wi > 0 && w.startOffsetSec >= targetLocal);
        if (splitWordIdx === -1) {
          splitWordIdx = Math.max(
            1,
            Math.min(target.words.length - 1, Math.round(target.words.length * ratio))
          );
        }
        splitWordIdx = Math.max(1, Math.min(target.words.length - 1, splitWordIdx));

        const boundaryLocal = target.words[splitWordIdx].startOffsetSec;
        if (boundaryLocal >= 0.2 && dur - boundaryLocal >= 0.2) {
          splitTime = target.startTime + boundaryLocal;
        }
        splitTime = Number(
          Math.max(target.startTime + 0.2, Math.min(target.endTime - 0.2, splitTime)).toFixed(2)
        );
        const firstDur = Math.max(0.2, Number((splitTime - target.startTime).toFixed(2)));
        const secondDur = Math.max(0.2, Number((target.endTime - splitTime).toFixed(2)));
        ratio = Math.max(0.15, Math.min(0.85, firstDur / dur));

        words1 = target.words.slice(0, splitWordIdx).map((w, wi, arr) => ({
          ...w,
          startOffsetSec: Number(Math.min(firstDur - 0.05, Math.max(0, w.startOffsetSec)).toFixed(2)),
          endOffsetSec: Number(
            (wi === arr.length - 1
              ? firstDur
              : Math.min(firstDur, Math.max(w.startOffsetSec + 0.04, w.endOffsetSec))
            ).toFixed(2)
          ),
        }));
        words2 = target.words.slice(splitWordIdx).map((w, wi, arr) => {
          const s = Math.max(0, w.startOffsetSec - firstDur);
          const e = Math.max(s + 0.04, w.endOffsetSec - firstDur);
          return {
            ...w,
            startOffsetSec: Number(Math.min(secondDur - 0.05, s).toFixed(2)),
            endOffsetSec: Number((wi === arr.length - 1 ? secondDur : Math.min(secondDur, e)).toFixed(2)),
          };
        });
        phonetic1 = words1.map((w) => w.phonetic).join(" ");
        phonetic2 = words2.map((w) => w.phonetic).join(" ");
      } else {
        splitTime = Number(splitTime.toFixed(2));
        const firstDur = Math.max(0.2, Number((splitTime - target.startTime).toFixed(2)));
        const secondDur = Math.max(0.2, Number((target.endTime - splitTime).toFixed(2)));
        [phonetic1, phonetic2] = splitTextProportional(target.thaiPhonetic, ratio);
        words1 = buildWordsFromPhonetic(phonetic1, 0, firstDur);
        words2 = buildWordsFromPhonetic(phonetic2, 0, secondDur);
      }

      const [burmese1, burmese2] = splitTextProportional(target.burmese, ratio);
      const [thaiScript1, thaiScript2] = splitTextProportional(target.thaiScript, ratio);
      const [spoken1, spoken2] = splitTextProportional(target.originalSpokenText, ratio);

      const mappedStart = mapCutTimeToSource(project.scenes, target.startTime);
      const mappedSplit = mapCutTimeToSource(project.scenes, splitTime);
      const mappedEnd = mapCutTimeToSource(project.scenes, target.endTime);

      const firstItem: SubtitleItem = withSceneId(
        {
          ...target,
          endTime: splitTime,
          sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
          sourceEndSec: Number(mappedSplit.sourceSec.toFixed(2)),
          originalSpokenText: spoken1,
          thaiScript: thaiScript1,
          thaiPhonetic: phonetic1,
          burmese: burmese1,
          words: words1,
          isManuallyEdited: true,
        },
        project.scenes
      );
      const secondItem: SubtitleItem = withSceneId(
        {
          id: `${target.id}-sp-${Date.now().toString(36).slice(-4)}`,
          sceneIndex: mappedSplit.sceneIndex,
          startTime: splitTime,
          endTime: target.endTime,
          sourceStartSec: Number(mappedSplit.sourceSec.toFixed(2)),
          sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
          originalSpokenText: spoken2,
          thaiScript: thaiScript2,
          thaiPhonetic: phonetic2,
          burmese: burmese2,
          words: words2,
          isManuallyEdited: true,
        },
        project.scenes
      );

      const next = [...list];
      next.splice(idx, 1, firstItem, secondItem);
      return next.sort((a, b) => a.startTime - b.startTime);
    };

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = splitInList(timelineBaselineRef.current.subtitles);
    }

    setProject((prev) => (prev ? { ...prev, subtitles: splitInList(prev.subtitles) } : prev));
  };

  const handleMergeSubtitleWithNext = (id: string) => {
    if (!project) return;
    const mergeInList = (list: SubtitleItem[]): SubtitleItem[] => {
      const idx = list.findIndex((s) => s.id === id);
      if (idx === -1 || idx + 1 >= list.length) return list;
      const cur = list[idx];
      const nxt = list[idx + 1];

      const mergedStart = Math.min(cur.startTime, nxt.startTime);
      const mergedEnd = Math.max(cur.endTime, nxt.endTime);
      const curShift = Math.max(0, cur.startTime - mergedStart);
      const offsetShift = Math.max(0, nxt.startTime - mergedStart);

      const mergedWords: SubtitleWord[] = [
        ...cur.words.map((w) => ({
          ...w,
          startOffsetSec: Number((w.startOffsetSec + curShift).toFixed(2)),
          endOffsetSec: Number((w.endOffsetSec + curShift).toFixed(2)),
        })),
        ...nxt.words.map((w) => ({
          ...w,
          startOffsetSec: Number((w.startOffsetSec + offsetShift).toFixed(2)),
          endOffsetSec: Number((w.endOffsetSec + offsetShift).toFixed(2)),
        })),
      ];

      const mappedStart = mapCutTimeToSource(project.scenes, mergedStart);
      const mappedEnd = mapCutTimeToSource(project.scenes, mergedEnd);

      const mergedItem: SubtitleItem = withSceneId(
        {
          ...cur,
          startTime: Number(mergedStart.toFixed(2)),
          endTime: Number(mergedEnd.toFixed(2)),
          sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
          sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
          originalSpokenText: [cur.originalSpokenText, nxt.originalSpokenText]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" "),
          thaiScript: [cur.thaiScript, nxt.thaiScript]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" "),
          thaiPhonetic: [cur.thaiPhonetic, nxt.thaiPhonetic]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" "),
          burmese: [cur.burmese, nxt.burmese]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" "),
          words: mergedWords,
          isManuallyEdited: true,
        },
        project.scenes
      );

      const next = [...list];
      next.splice(idx, 2, mergedItem);
      return next;
    };

    if (loopingSubIdRef.current) setLoopingSubId(null);

    const mergeIdx = project.subtitles.findIndex((s) => s.id === id);
    if (mergeIdx !== -1 && mergeIdx + 1 < project.subtitles.length) {
      const curSub = project.subtitles[mergeIdx];
      const nxtSub = project.subtitles[mergeIdx + 1];
      pushSubtitleUndo();
      if (selectedSubtitleId === nxtSub.id) {
        setSelectedSubtitleId(curSub.id);
      }
      if (editingSubtitleId === nxtSub.id) {
        setEditingSubtitleId(curSub.id);
      }
    }

    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = mergeInList(timelineBaselineRef.current.subtitles);
    }

    setProject((prev) => (prev ? { ...prev, subtitles: mergeInList(prev.subtitles) } : prev));
  };

  const handleCancelRegenerateSubtitle = useCallback((id: string) => {
    const ctrl = regenAbortMapRef.current.get(id);
    if (ctrl) {
      ctrl.abort();
      regenAbortMapRef.current.delete(id);
    }
    setRegeneratingSubIds((prev) => prev.filter((itemId) => itemId !== id));
  }, []);

  const handleRegenerateSubtitle = async (
    id: string,
    customHint?: string,
    toneOverride?: TranslationTone
  ) => {
    if (!project) return;
    const idx = project.subtitles.findIndex((s) => s.id === id);
    if (idx === -1) return;
    if (regeneratingSubIds.includes(id)) return;

    const targetSub = project.subtitles[idx];
    const prevSub = idx > 0 ? project.subtitles[idx - 1] : null;
    const nextSub = idx + 1 < project.subtitles.length ? project.subtitles[idx + 1] : null;

    const controller = new AbortController();
    regenAbortMapRef.current.set(id, controller);
    setSubtitleRegenError(null);
    setRegeneratingSubIds((prev) => (prev.includes(id) ? prev : [...prev, id]));

    try {
      const resolvedUploadId = project.uploadId || localMedia?.uploadId;
      const localFile = project.localFile || localMedia?.localFile;
      let clipAudioBase64: string | undefined;
      let clipMimeType: string | undefined;
      if (!resolvedUploadId && localFile) {
        const lineStart = Math.max(0, (targetSub.sourceStartSec ?? targetSub.startTime) - 0.18);
        const lineEnd = Math.max(
          lineStart + 0.5,
          (targetSub.sourceEndSec ?? targetSub.endTime) + 0.18
        );
        const extracted = await extractMp4AudioClips(localFile, [
          { startSec: lineStart, endSec: lineEnd },
        ]);
        if (controller.signal.aborted) return;
        if (extracted?.[0]) {
          clipAudioBase64 = extracted[0].audioBase64;
          clipMimeType = extracted[0].mimeType;
        }
      }

      const resp = await fetch("/api/regenerate-subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          uploadId: resolvedUploadId,
          clipAudioBase64,
          clipMimeType,
          customHint: customHint?.trim() || undefined,
          translationTone: toneOverride ?? videoEdit.translationTone,
          subtitle: {
            id: targetSub.id,
            startTime: targetSub.startTime,
            endTime: targetSub.endTime,
            sourceStartSec: targetSub.sourceStartSec,
            sourceEndSec: targetSub.sourceEndSec,
            originalSpokenText: targetSub.originalSpokenText,
            thaiScript: targetSub.thaiScript,
            thaiPhonetic: targetSub.thaiPhonetic,
            burmese: targetSub.burmese,
          },
          prevContext: prevSub
            ? {
                originalSpokenText: prevSub.originalSpokenText,
                thaiScript: prevSub.thaiScript,
                thaiPhonetic: prevSub.thaiPhonetic,
                burmese: prevSub.burmese,
              }
            : null,
          nextContext: nextSub
            ? {
                originalSpokenText: nextSub.originalSpokenText,
                thaiScript: nextSub.thaiScript,
                thaiPhonetic: nextSub.thaiPhonetic,
                burmese: nextSub.burmese,
              }
            : null,
        }),
      });

      const data = await safeReadJson<{
        subtitle?: {
          originalSpokenText: string;
          thaiScript: string;
          thaiPhonetic: string;
          burmese: string;
          words: SubtitleWord[];
        };
        error?: string;
      }>(resp);

      if (!resp.ok || !data.subtitle) {
        throw new Error(data.error || "Failed to regenerate subtitle with AI.");
      }
      if (controller.signal.aborted) return;

      const updatedFields = data.subtitle;
      const applyRegen = (list: SubtitleItem[]): SubtitleItem[] =>
        list.map((sub) =>
          sub.id === id
            ? {
                ...sub,
                originalSpokenText: updatedFields.originalSpokenText,
                thaiScript: updatedFields.thaiScript,
                thaiPhonetic: updatedFields.thaiPhonetic,
                burmese: updatedFields.burmese,
                words: Array.isArray(updatedFields.words) ? updatedFields.words : sub.words,
                isManuallyEdited: false,
              }
            : sub
        );

      pushSubtitleUndo();

      if (timelineBaselineRef.current) {
        timelineBaselineRef.current.subtitles = applyRegen(
          timelineBaselineRef.current.subtitles
        );
      }

      setProject((prev) =>
        prev ? { ...prev, subtitles: applyRegen(prev.subtitles) } : prev
      );
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSubtitleRegenError(
        formatReadableApiError(err, "Failed to regenerate subtitle with AI.")
      );
    } finally {
      if (regenAbortMapRef.current.get(id) === controller) {
        regenAbortMapRef.current.delete(id);
      }
      setRegeneratingSubIds((prev) => prev.filter((itemId) => itemId !== id));
    }
  };

  const handleCancelRetranslateAll = useCallback(() => {
    retranslateAbortRef.current?.abort();
    retranslateAbortRef.current = null;
    setIsRetranslatingAll(false);
    setRetranslatingSubIds([]);
  }, []);

  const handleRetranslateAll = async (
    tone: TranslationTone,
    options?: { skipManuallyEdited?: boolean }
  ) => {
    if (!project || project.subtitles.length === 0 || isRetranslatingAll) return;
    const skipManuallyEdited = Boolean(options?.skipManuallyEdited);
    const targetSubtitles = selectSubtitlesForRetranslation(
      project.subtitles,
      skipManuallyEdited
    );
    if (targetSubtitles.length === 0) return;

    retranslateAbortRef.current?.abort();
    const controller = new AbortController();
    retranslateAbortRef.current = controller;

    setSubtitleRegenError(null);
    setIsRetranslatingAll(true);
    setRetranslatingSubIds(targetSubtitles.map((s) => s.id));

    try {
      const resp = await fetch("/api/retranslate-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          translationTone: tone,
          subtitles: targetSubtitles.map((s) => ({
            id: s.id,
            startTime: s.startTime,
            endTime: s.endTime,
            originalSpokenText: s.originalSpokenText,
            thaiScript: s.thaiScript,
            thaiPhonetic: s.thaiPhonetic,
            burmese: s.burmese,
          })),
        }),
      });

      const data = await safeReadJson<{
        subtitles?: Array<{
          id: string;
          thaiScript: string;
          thaiPhonetic: string;
          burmese: string;
          words: SubtitleWord[];
        }>;
        error?: string;
      }>(resp);

      if (!resp.ok || !Array.isArray(data.subtitles)) {
        throw new Error(data.error || "Failed to re-translate subtitles.");
      }
      if (controller.signal.aborted) return;

      const patches = data.subtitles;
      const applyBatch = (list: SubtitleItem[]): SubtitleItem[] =>
        mergeRetranslatedSubtitles(list, patches);

      pushSubtitleUndo();

      if (timelineBaselineRef.current) {
        timelineBaselineRef.current.subtitles = applyBatch(
          timelineBaselineRef.current.subtitles
        );
      }

      setProject((prev) =>
        prev ? { ...prev, subtitles: applyBatch(prev.subtitles) } : prev
      );
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSubtitleRegenError(
        formatReadableApiError(err, "Failed to re-translate subtitles.")
      );
    } finally {
      if (retranslateAbortRef.current === controller) {
        retranslateAbortRef.current = null;
      }
      setIsRetranslatingAll(false);
      setRetranslatingSubIds([]);
    }
  };

  const handleFillMissingGlosses = async (subIds: string[]) => {
    if (!project || subIds.length === 0 || isRetranslatingAll) return;
    const idSet = new Set(subIds);
    const targetSubtitles = project.subtitles.filter((s) => idSet.has(s.id));
    if (targetSubtitles.length === 0) return;

    retranslateAbortRef.current?.abort();
    const controller = new AbortController();
    retranslateAbortRef.current = controller;

    setSubtitleRegenError(null);
    setIsRetranslatingAll(true);
    setRetranslatingSubIds(targetSubtitles.map((s) => s.id));

    try {
      const resp = await fetch("/api/retranslate-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          translationTone: videoEdit.translationTone,
          subtitles: targetSubtitles.map((s) => ({
            id: s.id,
            startTime: s.startTime,
            endTime: s.endTime,
            originalSpokenText: s.originalSpokenText,
            thaiScript: s.thaiScript,
            thaiPhonetic: s.thaiPhonetic,
            burmese: s.burmese,
          })),
        }),
      });

      const data = await safeReadJson<{
        subtitles?: Array<{
          id: string;
          thaiScript: string;
          thaiPhonetic: string;
          burmese: string;
          words: SubtitleWord[];
        }>;
        error?: string;
      }>(resp);

      if (!resp.ok || !Array.isArray(data.subtitles)) {
        throw new Error(data.error || "Failed to fill missing Burmese glosses.");
      }
      if (controller.signal.aborted) return;

      const byId = new Map(data.subtitles.map((item) => [item.id, item]));
      const applyGlossFill = (list: SubtitleItem[]): SubtitleItem[] =>
        list.map((sub) => {
          const patch = byId.get(sub.id);
          if (!patch || !Array.isArray(patch.words) || patch.words.length === 0) {
            return sub;
          }
          const nextWords = sub.words.map((w, wi) => {
            if (w.burmeseGloss && w.burmeseGloss.trim()) return w;
            const norm = w.phonetic.trim().toLowerCase();
            const byIndex = patch.words[wi];
            const candidate =
              byIndex && byIndex.burmeseGloss?.trim()
                ? byIndex
                : patch.words.find(
                    (pw) =>
                      pw.phonetic.trim().toLowerCase() === norm &&
                      Boolean(pw.burmeseGloss?.trim())
                  );
            return candidate?.burmeseGloss?.trim()
              ? { ...w, burmeseGloss: candidate.burmeseGloss.trim() }
              : w;
          });
          return { ...sub, words: nextWords };
        });

      pushSubtitleUndo();

      if (timelineBaselineRef.current) {
        timelineBaselineRef.current.subtitles = applyGlossFill(
          timelineBaselineRef.current.subtitles
        );
      }

      setProject((prev) =>
        prev ? { ...prev, subtitles: applyGlossFill(prev.subtitles) } : prev
      );
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSubtitleRegenError(
        formatReadableApiError(err, "Failed to fill missing Burmese glosses.")
      );
    } finally {
      if (retranslateAbortRef.current === controller) {
        retranslateAbortRef.current = null;
      }
      setIsRetranslatingAll(false);
      setRetranslatingSubIds([]);
    }
  };

  const applySyncedTimingsToList = (
    list: SubtitleItem[],
    timingById: Map<string, { startTime: number; endTime: number }>,
    scenes: SpeakingScene[],
    maxDur: number
  ): SubtitleItem[] => {
    return list
      .map((sub) => {
        const next = timingById.get(sub.id);
        const rawStart = next ? next.startTime : sub.startTime;
        const rawEnd = next ? next.endTime : sub.endTime;
        const startTime = Number(Math.max(0, Math.min(maxDur - 0.25, rawStart)).toFixed(2));
        const endTime = Number(Math.max(startTime + 0.25, Math.min(maxDur, rawEnd)).toFixed(2));
        const newDur = Math.max(0.25, endTime - startTime);
        const oldDur = Math.max(0.2, sub.endTime - sub.startTime);
        const scale = newDur / oldDur;
        const mappedStart = mapCutTimeToSource(scenes, startTime);
        const mappedEnd = mapCutTimeToSource(scenes, endTime);

        const words =
          sub.words.length > 0
            ? sub.words.map((w, wi, arr) => {
                const sOff = Number(
                  Math.max(0, Math.min(newDur - 0.04, w.startOffsetSec * scale)).toFixed(2)
                );
                const eOff = Number(
                  (wi === arr.length - 1
                    ? newDur
                    : Math.max(sOff + 0.04, Math.min(newDur, w.endOffsetSec * scale))
                  ).toFixed(2)
                );
                return { ...w, startOffsetSec: sOff, endOffsetSec: eOff };
              })
            : buildWordsFromPhonetic(sub.thaiPhonetic, 0, newDur);

        return withSceneId(
          {
            ...sub,
            sceneIndex: mappedStart.sceneIndex,
            startTime,
            endTime,
            sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
            sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
            words,
          },
          scenes
        );
      })
      .sort((a, b) => a.startTime - b.startTime);
  };

  const handleAutoFixSubtitleTimings = () => {
    if (!project || project.subtitles.length === 0) return;
    setSubtitleRegenError(null);
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);

    const fixList = (list: SubtitleItem[]): SubtitleItem[] => {
      if (list.length === 0) return list;
      const sorted = cloneSubtitleList(list).sort(
        (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
      );

      // Step 1: Clamp each subtitle within [0, maxDur] and ensure minimum readable span
      const cleaned = sorted.map((sub) => {
        const s = Number(Math.max(0, Math.min(maxDur - 0.35, sub.startTime)).toFixed(2));
        const desiredEnd = Math.max(s + 0.4, sub.endTime);
        const e = Number(Math.min(maxDur, desiredEnd).toFixed(2));
        return { ...sub, nextStart: s, nextEnd: e };
      });

      // Step 2: Eliminate overlaps cleanly & smooth micro-flicker gaps (< 0.14s)
      for (let i = 1; i < cleaned.length; i++) {
        const prev = cleaned[i - 1];
        const curr = cleaned[i];
        const minGap = 0.02;

        if (curr.nextStart < prev.nextEnd + minGap) {
          const totalAvailable = curr.nextEnd - prev.nextStart;
          if (totalAvailable >= 0.72) {
            const mid = (prev.nextEnd + curr.nextStart) / 2;
            const prevEnd = Math.max(prev.nextStart + 0.35, Math.min(curr.nextEnd - 0.37, mid - 0.01));
            prev.nextEnd = Number(prevEnd.toFixed(2));
            curr.nextStart = Number((prev.nextEnd + minGap).toFixed(2));
            curr.nextEnd = Number(Math.max(curr.nextStart + 0.35, Math.min(maxDur, curr.nextEnd)).toFixed(2));
          } else {
            const nextS = Math.min(maxDur - 0.35, prev.nextEnd + minGap);
            if (nextS > prev.nextStart + 0.35) {
              curr.nextStart = Number(nextS.toFixed(2));
              curr.nextEnd = Number(Math.max(curr.nextStart + 0.35, Math.min(maxDur, curr.nextEnd)).toFixed(2));
            }
          }
        } else {
          const gap = curr.nextStart - prev.nextEnd;
          if (gap > minGap && gap <= 0.14) {
            prev.nextEnd = Number((curr.nextStart - minGap).toFixed(2));
          }
        }
      }

      const timingMap = new Map(
        cleaned.map((item) => [item.id, { startTime: item.nextStart, endTime: item.nextEnd }])
      );
      return applySyncedTimingsToList(list, timingMap, project.scenes, maxDur);
    };

    pushSubtitleUndo();
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = fixList(timelineBaselineRef.current.subtitles);
    }
    setProject((prev) => (prev ? { ...prev, subtitles: fixList(prev.subtitles) } : prev));
  };

  const handleCancelAiResync = useCallback(() => {
    resyncAbortRef.current?.abort();
    resyncAbortRef.current = null;
    setIsResyncingTimings(false);
  }, []);

  const handleAiResyncSubtitles = async () => {
    if (!project || project.subtitles.length === 0 || isResyncingTimings) return;
    resyncAbortRef.current?.abort();
    const controller = new AbortController();
    resyncAbortRef.current = controller;

    setSubtitleRegenError(null);
    setIsResyncingTimings(true);

    try {
      let uploadId = project.uploadId || localMedia?.uploadId;
      const localFile = project.localFile || localMedia?.localFile;
      let clipsAudioPayload:
        | Array<{ trimLeadSec?: number; durationSec: number; audioBase64: string; mimeType?: string }>
        | undefined;

      if (!uploadId && localFile) {
        const extracted = await extractMp4AudioClips(
          localFile,
          project.scenes.map((sc) => ({ startSec: sc.startSec, endSec: sc.endSec }))
        );
        if (controller.signal.aborted) return;
        if (extracted && extracted.length === project.scenes.length) {
          clipsAudioPayload = extracted.map((c) => ({
            trimLeadSec: c.trimLeadSec,
            durationSec: c.durationSec,
            audioBase64: c.audioBase64,
            mimeType: c.mimeType,
          }));
        } else {
          uploadId = await uploadBlobInChunks(
            localFile,
            localFile.name,
            controller.signal
          );
          if (controller.signal.aborted) return;
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          setProject((prev) => (prev ? { ...prev, uploadId } : prev));
        }
      }

      const payloadBody = (activeUploadId?: string) =>
        JSON.stringify({
          uploadId: activeUploadId,
          clipsAudio: clipsAudioPayload,
          scenes: project.scenes.map((sc) => ({
            startSec: sc.startSec,
            endSec: sc.endSec,
            durationSec: sc.durationSec,
          })),
          subtitles: project.subtitles.map((s) => ({
            id: s.id,
            startTime: s.startTime,
            endTime: s.endTime,
            originalSpokenText: s.originalSpokenText,
            thaiScript: s.thaiScript,
            thaiPhonetic: s.thaiPhonetic,
            burmese: s.burmese,
          })),
        });

      let resp = await fetch("/api/resync-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadBody(uploadId),
        signal: controller.signal,
      });

      if (resp.status === 404 && localFile) {
        const extracted = await extractMp4AudioClips(
          localFile,
          project.scenes.map((sc) => ({ startSec: sc.startSec, endSec: sc.endSec }))
        );
        if (controller.signal.aborted) return;
        if (extracted && extracted.length === project.scenes.length) {
          clipsAudioPayload = extracted.map((c) => ({
            trimLeadSec: c.trimLeadSec,
            durationSec: c.durationSec,
            audioBase64: c.audioBase64,
            mimeType: c.mimeType,
          }));
          uploadId = undefined;
          setLocalMedia((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
          setProject((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
        } else {
          uploadId = await uploadBlobInChunks(
            localFile,
            localFile.name,
            controller.signal
          );
          if (controller.signal.aborted) return;
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          setProject((prev) => (prev ? { ...prev, uploadId } : prev));
        }
        resp = await fetch("/api/resync-subtitles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadBody(uploadId),
          signal: controller.signal,
        });
      }

      const data = await safeReadJson<{
        subtitles?: Array<{ id: string; startTime: number; endTime: number }>;
        error?: string;
      }>(resp);

      if (!resp.ok || !Array.isArray(data.subtitles)) {
        throw new Error(data.error || "Failed to auto-sync subtitle timings with AI.");
      }
      if (controller.signal.aborted) return;

      const maxDur = Math.max(0.5, project.targetDurationSec || 10);
      const timingById = new Map(
        data.subtitles.map((item) => [
          item.id,
          { startTime: item.startTime, endTime: item.endTime },
        ])
      );

      pushSubtitleUndo();

      if (timelineBaselineRef.current) {
        timelineBaselineRef.current.subtitles = applySyncedTimingsToList(
          timelineBaselineRef.current.subtitles,
          timingById,
          project.scenes,
          maxDur
        );
      }

      setProject((prev) =>
        prev
          ? {
              ...prev,
              subtitles: applySyncedTimingsToList(
                prev.subtitles,
                timingById,
                prev.scenes,
                maxDur
              ),
            }
          : prev
      );
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSubtitleRegenError(
        formatReadableApiError(err, "Failed to auto-sync subtitle timings with AI.")
      );
    } finally {
      if (resyncAbortRef.current === controller) {
        resyncAbortRef.current = null;
      }
      setIsResyncingTimings(false);
    }
  };

  const handleTranscribeRange = async (
    rawStartSec: number,
    rawEndSec: number
  ): Promise<{ addedCount: number; message?: string }> => {
    const curProj = projectRef.current;
    if (!curProj || transcribingRange) {
      return { addedCount: 0 };
    }

    const maxDur = Math.max(0.5, curProj.targetDurationSec || 10);
    const startSec = Number(Math.max(0, Math.min(maxDur - 0.25, rawStartSec)).toFixed(2));
    const endSec = Number(Math.max(startSec + 0.25, Math.min(maxDur, rawEndSec)).toFixed(2));
    if (endSec <= startSec + 0.2) {
      return { addedCount: 0, message: "Select at least a 0.25s range." };
    }

    transcribeRangeAbortRef.current?.abort();
    const controller = new AbortController();
    transcribeRangeAbortRef.current = controller;

    setSubtitleRegenError(null);
    setProcessError(null);
    setSaveNotice(null);
    setTranscribingRange({ startSec, endSec });

    try {
      const sortedSubs = [...curProj.subtitles].sort((a, b) => a.startTime - b.startTime);
      let prevSub: SubtitleItem | null = null;
      let nextSub: SubtitleItem | null = null;
      for (const s of sortedSubs) {
        if (s.endTime <= startSec + 0.15 && s.startTime < startSec) {
          prevSub = s;
        } else if (!nextSub && s.startTime >= endSec - 0.15 && s.endTime > endSec) {
          nextSub = s;
          break;
        }
      }

      let uploadId = curProj.uploadId || localMedia?.uploadId;
      const localFile = curProj.localFile || localMedia?.localFile;
      let clipAudioBase64: string | undefined;
      let mimeType: string | undefined;
      let trimLeadSec: number | undefined;
      let clipsAudioPayload:
        | Array<{ trimLeadSec?: number; durationSec: number; audioBase64: string; mimeType?: string }>
        | undefined;

      const extractLocalRangeAudio = async () => {
        if (!localFile) return false;
        const padStart = Math.max(0, startSec - 0.4);
        const padEnd = Math.min(maxDur, endSec + 0.4);
        const overlappingSlices: Array<{ startSec: number; endSec: number }> = [];
        let cutCursor = 0;
        for (const sc of curProj.scenes) {
          const dur = getSceneDurationSec(sc);
          const scCutStart = cutCursor;
          const scCutEnd = cutCursor + dur;
          const ovStart = Math.max(padStart, scCutStart);
          const ovEnd = Math.min(padEnd, scCutEnd);
          if (ovEnd - ovStart > 0.02) {
            overlappingSlices.push({
              startSec: Number((sc.startSec + (ovStart - scCutStart)).toFixed(3)),
              endSec: Number((sc.startSec + (ovEnd - scCutStart)).toFixed(3)),
            });
          }
          cutCursor = scCutEnd;
        }

        if (overlappingSlices.length > 0) {
          const extracted = await extractMp4AudioClips(localFile, overlappingSlices);
          if (controller.signal.aborted) return true;
          if (extracted && extracted.length === 1) {
            clipAudioBase64 = extracted[0].audioBase64;
            mimeType = extracted[0].mimeType;
            trimLeadSec = extracted[0].trimLeadSec;
            clipsAudioPayload = undefined;
            return true;
          }
          if (extracted && extracted.length === overlappingSlices.length) {
            clipsAudioPayload = extracted.map((c) => ({
              trimLeadSec: c.trimLeadSec,
              durationSec: c.durationSec,
              audioBase64: c.audioBase64,
              mimeType: c.mimeType,
            }));
            clipAudioBase64 = undefined;
            return true;
          }
        }

        uploadId = await uploadBlobInChunks(
          localFile,
          localFile.name,
          controller.signal
        );
        if (controller.signal.aborted) return true;
        setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        setProject((prev) => (prev ? { ...prev, uploadId } : prev));
        return true;
      };

      if (!uploadId && localFile) {
        await extractLocalRangeAudio();
        if (controller.signal.aborted) return { addedCount: 0 };
      }

      const buildPayload = (activeUploadId?: string) =>
        JSON.stringify({
          startSec,
          endSec,
          translationTone: videoEdit.translationTone,
          uploadId: activeUploadId,
          clipAudioBase64,
          mimeType,
          trimLeadSec,
          clipsAudio: clipsAudioPayload,
          scenes: curProj.scenes.map((sc) => ({
            startSec: sc.startSec,
            endSec: sc.endSec,
            durationSec: sc.durationSec,
          })),
          prevContext: prevSub
            ? {
                originalSpokenText: prevSub.originalSpokenText,
                thaiScript: prevSub.thaiScript,
                thaiPhonetic: prevSub.thaiPhonetic,
                burmese: prevSub.burmese,
              }
            : null,
          nextContext: nextSub
            ? {
                originalSpokenText: nextSub.originalSpokenText,
                thaiScript: nextSub.thaiScript,
                thaiPhonetic: nextSub.thaiPhonetic,
                burmese: nextSub.burmese,
              }
            : null,
        });

      let resp = await fetch("/api/transcribe-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: buildPayload(uploadId),
      });

      if (resp.status === 404 && localFile) {
        uploadId = undefined;
        setLocalMedia((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
        setProject((prev) => (prev ? { ...prev, uploadId: undefined } : prev));
        await extractLocalRangeAudio();
        if (controller.signal.aborted) return { addedCount: 0 };
        resp = await fetch("/api/transcribe-range", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: buildPayload(uploadId),
        });
      }

      const data = await safeReadJson<{
        hasSpeech?: boolean;
        message?: string;
        subtitles?: SubtitleItem[];
        error?: string;
      }>(resp);

      if (!resp.ok) {
        throw new Error(data.error || "Failed to transcribe range with AI.");
      }
      if (controller.signal.aborted) return { addedCount: 0 };

      if (data.hasSpeech === false || !Array.isArray(data.subtitles) || data.subtitles.length === 0) {
        const msg =
          data.message ||
          `No spoken dialogue detected between ${startSec.toFixed(1)}s and ${endSec.toFixed(1)}s.`;
        setSaveNotice(msg);
        return { addedCount: 0, message: msg };
      }

      const latestProj = projectRef.current ?? curProj;
      const stamp = Date.now();
      const newItems: SubtitleItem[] = data.subtitles.map((rawItem, idx) => {
        const itemStart = Number(
          Math.max(0, Math.min(maxDur - 0.25, Number(rawItem.startTime) || startSec)).toFixed(2)
        );
        const itemEnd = Number(
          Math.max(itemStart + 0.25, Math.min(maxDur, Number(rawItem.endTime) || endSec)).toFixed(2)
        );
        const dur = Math.max(0.25, itemEnd - itemStart);
        const mappedStart = mapCutTimeToSource(latestProj.scenes, itemStart);
        const mappedEnd = mapCutTimeToSource(latestProj.scenes, itemEnd);
        const thaiPhonetic = (rawItem.thaiPhonetic || "").trim() || (rawItem.thaiScript || "").trim();
        const words: SubtitleWord[] =
          Array.isArray(rawItem.words) && rawItem.words.length > 0
            ? rawItem.words.map((w) => ({
                phonetic: w.phonetic || "",
                thai: w.thai || "",
                burmeseGloss: w.burmeseGloss || "",
                startOffsetSec: Number(Math.max(0, Math.min(dur - 0.02, Number(w.startOffsetSec) || 0)).toFixed(2)),
                endOffsetSec: Number(Math.max(0.02, Math.min(dur, Number(w.endOffsetSec) || dur)).toFixed(2)),
              }))
            : buildWordsFromPhonetic(thaiPhonetic, 0, dur);

        return withSceneId(
          {
            id: `sub-range-${stamp}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
            sceneIndex: mappedStart.sceneIndex,
            startTime: itemStart,
            endTime: itemEnd,
            sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
            sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
            originalSpokenText: (rawItem.originalSpokenText || "").trim() || thaiPhonetic,
            thaiPhonetic,
            thaiScript: (rawItem.thaiScript || "").trim() || thaiPhonetic,
            burmese: (rawItem.burmese || "").trim(),
            words,
            isManuallyEdited: false,
          },
          latestProj.scenes
        );
      });

      if (newItems.length === 0) {
        const msg = `No spoken dialogue detected between ${startSec.toFixed(1)}s and ${endSec.toFixed(1)}s.`;
        setSaveNotice(msg);
        return { addedCount: 0, message: msg };
      }

      pushSubtitleUndo();

      if (timelineBaselineRef.current) {
        timelineBaselineRef.current.subtitles = [
          ...timelineBaselineRef.current.subtitles,
          ...newItems.map((it) => ({
            ...it,
            words: it.words.map((w) => ({ ...w })),
          })),
        ].sort((a, b) => a.startTime - b.startTime);
      }

      setProject((prev) =>
        prev
          ? {
              ...prev,
              subtitles: [...prev.subtitles, ...newItems].sort(
                (a, b) => a.startTime - b.startTime
              ),
            }
          : prev
      );

      const firstNew = newItems[0];
      setSelectedSubtitleId(firstNew.id);
      setStageSelectRequest({ id: firstNew.id, focusPhonetic: false, nonce: Date.now() });
      handleSeek(firstNew.startTime);
      setSaveNotice(
        `Added ${newItems.length} AI subtitle${newItems.length === 1 ? "" : "s"} (${startSec.toFixed(1)}s–${endSec.toFixed(1)}s).`
      );
      return { addedCount: newItems.length };
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return { addedCount: 0 };
      }
      const readable = formatReadableApiError(err, "Failed to transcribe range with AI.");
      setSubtitleRegenError(readable);
      setProcessError(readable);
      return { addedCount: 0, message: readable };
    } finally {
      if (transcribeRangeAbortRef.current === controller) {
        transcribeRangeAbortRef.current = null;
      }
      setTranscribingRange(null);
    }
  };

  useEffect(() => {
    const currentUrl = readyDownload?.blobUrl;
    return () => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [readyDownload]);

  const triggerSafeBlobDownload = useCallback((item: ExportedVideoResult) => {
    // Strictly uses the in-memory blob: URL (never navigates to /api/* or triggers auth proxy)
    const a = document.createElement("a");
    a.href = item.blobUrl;
    a.download = item.fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setHasSavedExport(true);
  }, []);

  const canShareMp4File = useCallback((item: ExportedVideoResult): boolean => {
    try {
      if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
        return false;
      }
      if (typeof navigator.canShare !== "function") return false;
      const testFile = new File([item.blob], item.fileName, { type: "video/mp4" });
      return navigator.canShare({ files: [testFile] });
    } catch {
      return false;
    }
  }, []);

  const handleShareMp4 = useCallback(async (item: ExportedVideoResult) => {
    try {
      const mp4File = new File([item.blob], item.fileName, { type: "video/mp4" });
      await navigator.share({
        files: [mp4File],
        title: item.fileName,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      triggerSafeBlobDownload(item);
    }
  }, [triggerSafeBlobDownload]);

  const handleMinimizeExportSheet = useCallback(() => {
    setExportSheetOpen(false);
  }, []);

  const handleCancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
    setExportSheetOpen(false);
  }, []);

  const currentExportSignature = useMemo(() => {
    if (!hasGeneratedProject(project)) return "";
    const effectiveTheme =
      videoEdit.subtitleTheme === "auto" ? (darkMode ? "dark" : "light") : videoEdit.subtitleTheme;
    return JSON.stringify({
      uploadId: project.uploadId ?? "",
      localUrl: project.localUrl ?? "",
      title: project.title,
      scenes: project.scenes,
      subtitles: project.subtitles,
      videoEdit,
      voiceSettings,
      effectiveTheme,
    });
  }, [project, videoEdit, voiceSettings, darkMode]);

  const isExportStale = Boolean(
    readyDownload && exportedSignature && currentExportSignature && exportedSignature !== currentExportSignature
  );

  useEffect(() => {
    if (!hasGeneratedProject(project) && !exportProgress) {
      setReadyDownload(null);
      setExportedSignature(null);
      setHasSavedExport(false);
    }
  }, [project, exportProgress]);

  const handleDiscardExportResult = useCallback(() => {
    setExportSheetOpen(false);
    setExportError(null);
    setHasSavedExport(false);
    setExportedSignature(null);
    setReadyDownload(null);
  }, []);

  const startBackgroundExport = async (openSheet = false) => {
    if (!hasGeneratedProject(project) || project.scenes.length === 0 || exportProgress) return;
    const exportSig = currentExportSignature;
    setProcessError(null);
    setExportError(null);
    setHasSavedExport(false);
    setExportedSignature(null);
    setReadyDownload(null);
    if (openSheet) {
      setExportSheetOpen(true);
    }
    setExportProgress({ phase: "preparing", percent: 5, detail: "Preparing export..." });

    const ctrl = new AbortController();
    exportAbortRef.current = ctrl;

    try {
      const result = await exportProjectToMp4(
        project,
        darkMode,
        voiceSettings,
        videoEdit,
        setExportProgress,
        ctrl.signal
      );
      if (ctrl.signal.aborted) {
        URL.revokeObjectURL(result.blobUrl);
        return;
      }

      // Hold verified in-memory MP4 blob + blobUrl; user explicitly taps Save MP4 once (zero duplicate downloads)
      setHasSavedExport(false);
      setExportedSignature(exportSig);
      setReadyDownload(result);
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        // User intentionally cancelled export
        setExportSheetOpen(false);
        return;
      }
      setExportError(err instanceof Error ? err.message : "Failed to export MP4.");
    } finally {
      if (exportAbortRef.current === ctrl) {
        exportAbortRef.current = null;
      }
      setExportProgress(null);
    }
  };

  const handleExportHeaderClick = () => {
    if (exportProgress || exportError) {
      setExportSheetOpen(true);
      return;
    }
    if (readyDownload && !isExportStale) {
      setExportSheetOpen(true);
      return;
    }
    void startBackgroundExport(false);
  };

  const canSaveCurrent = Boolean(
    hasGeneratedProject(project) ||
      ((hasProjectMedia(project) || localMedia) &&
        (selectedScenes.length > 0 || Boolean(transcriptResult)))
  );

  const handleSaveProject = useCallback(
    async (asNew = false) => {
      if (!canSaveCurrent || isSavingProject) return;
      setIsSavingProject(true);
      setProcessError(null);
      setSaveNotice(null);

      try {
        const mediaForSave = localMedia;
        const existingLocalProject = hasGeneratedProject(project) ? project : null;

        const snapshotProject: VideoProject | null =
          existingLocalProject ??
          (mediaForSave
            ? {
                localUrl: mediaForSave.localUrl,
                localFile: mediaForSave.localFile,
                uploadId: mediaForSave.uploadId,
                title: mediaForSave.title,
                channel: mediaForSave.channel,
                sourceDurationSec: mediaForSave.durationSec,
                targetDurationSec: selectedScenes.reduce(
                  (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
                  0
                ),
                scenes:
                  project && project.scenes.length > 0
                    ? project.scenes
                    : selectedScenes.map((sc, i) => ({
                        id: sc.id,
                        index: i,
                        startSec: sc.startSec,
                        endSec: sc.endSec,
                        durationSec: Math.max(0, sc.endSec - sc.startSec),
                        summary: `Scene ${i + 1}`,
                      })),
                subtitles: [],
                keyframeUrls: mediaForSave.thumbnail ? [mediaForSave.thumbnail] : [],
              }
            : null);

        if (!snapshotProject) return;

        const { record, blobSaved } = await saveOfflineProject({
          existingId: asNew ? null : activeSavedId,
          project: snapshotProject,
          activeMedia: mediaForSave,
          selectedScenes,
          voiceSettings,
          editSettings: videoEdit,
          transcriptResult,
        });

        setActiveSavedId(record.id);
        setSavedProjects((prev) => [
          record,
          ...prev.filter((item) => item.id !== record.id),
        ]);
        setJustSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000);

        if (!blobSaved) {
          setSaveNotice(
            "Saved subtitles and settings offline, but the local video file exceeded browser storage space."
          );
        }
      } catch (err) {
        setProcessError(
          err instanceof Error ? err.message : "Failed to save project offline."
        );
      } finally {
        setIsSavingProject(false);
      }
    },
    [
      canSaveCurrent,
      isSavingProject,
      project,
      localMedia,
      selectedScenes,
      activeSavedId,
      voiceSettings,
      videoEdit,
      transcriptResult,
    ]
  );

  const handleSeekRef = useRef(handleSeek);
  handleSeekRef.current = handleSeek;
  const handleTogglePlayRef = useRef(handleTogglePlay);
  handleTogglePlayRef.current = handleTogglePlay;
  const handleToggleLoopSubtitleRef = useRef(handleToggleLoopSubtitle);
  handleToggleLoopSubtitleRef.current = handleToggleLoopSubtitle;
  const handleSplitSubtitleRef = useRef(handleSplitSubtitle);
  handleSplitSubtitleRef.current = handleSplitSubtitle;
  const handleSaveProjectRef = useRef(handleSaveProject);
  handleSaveProjectRef.current = handleSaveProject;
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;
  const canSaveCurrentRef = useRef(canSaveCurrent);
  canSaveCurrentRef.current = canSaveCurrent;

  const handleSelectStageSubtitle = useCallback((id: string, startTime: number) => {
    handleSeekRef.current(startTime);
    setSelectedSubtitleId(id);
    setActiveTab("studio");
    setStudioSection("edit");
    setCaptionTab("script");
    setAutoFollowState("following");
    setStageSelectRequest({ id, focusPhonetic: true, source: "stage", nonce: Date.now() });
  }, []);

  const handleSelectTimelineSubtitle = useCallback(
    (id: string | null, opts?: { scrollList?: boolean }) => {
      setSelectedSubtitleId(id);
      if (id && opts?.scrollList && autoFollowStateRef.current === "following") {
        setStageSelectRequest({
          id,
          focusPhonetic: false,
          source: "timeline",
          nonce: Date.now(),
        });
      }
    },
    []
  );

  // Global keyboard shortcuts with IME guard, focus guard, and safe modifier handling
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;

      const hasPrimaryMod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Ctrl/Cmd + Alt + ArrowUp / ArrowDown: step subtitle selection (allowed inside inputs)
      if (
        hasPrimaryMod &&
        e.altKey &&
        !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        const subs = hasGeneratedProject(projectRef.current)
          ? projectRef.current.subtitles
          : undefined;
        if (activeTabRef.current !== "studio" || !subs || subs.length === 0) return;

        e.preventDefault();
        const curTime = liveCutTimeRef.current;
        const anchorId =
          selectedSubtitleIdRef.current ?? findActiveSubtitle(subs, curTime)?.id ?? null;
        let nextTarget: SubtitleItem | undefined;
        if (anchorId) {
          const idx = subs.findIndex((s) => s.id === anchorId);
          if (idx !== -1) {
            nextTarget =
              e.key === "ArrowUp"
                ? subs[Math.max(0, idx - 1)]
                : subs[Math.min(subs.length - 1, idx + 1)];
          }
        }
        if (!nextTarget) {
          if (e.key === "ArrowDown") {
            nextTarget = subs.find((s) => s.startTime >= curTime) ?? subs[0];
          } else {
            const prevMatches = subs.filter((s) => s.startTime <= curTime);
            nextTarget = prevMatches[prevMatches.length - 1] ?? subs[subs.length - 1];
          }
        }
        if (nextTarget) {
          setSelectedSubtitleId(nextTarget.id);
          handleSeekRef.current(nextTarget.startTime);
          setStudioSection("edit");
          setCaptionTab("script");
          setStageSelectRequest({
            id: nextTarget.id,
            focusPhonetic: false,
            source: "keyboard",
            nonce: Date.now(),
          });
        }
        return;
      }

      if (hasPrimaryMod && !e.altKey) {
        if (key === "s") {
          e.preventDefault();
          if (canSaveCurrentRef.current) {
            void handleSaveProjectRef.current(false);
          }
          return;
        }

        if (
          activeTabRef.current === "studio" &&
          Boolean(projectRef.current) &&
          !exportSheetOpenRef.current
        ) {
          const elements = [e.target, document.activeElement];
          const inTextField = elements.some((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const tag = el.tagName;
            return (
              tag === "INPUT" ||
              tag === "TEXTAREA" ||
              tag === "SELECT" ||
              el.isContentEditable
            );
          });
          if (inTextField) return;

          if (key === "z" && !e.shiftKey) {
            e.preventDefault();
            handleUndoRef.current();
          } else if ((key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey)) {
            e.preventDefault();
            handleRedoRef.current();
          }
        }
        return;
      }

      if (e.key === "Escape" && !hasPrimaryMod && !e.altKey) {
        if (isSubtitleSearchOpenRef.current) {
          e.preventDefault();
          setIsSubtitleSearchOpen(false);
          return;
        }
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLElement) {
          const tag = activeEl.tagName;
          if (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            tag === "SELECT" ||
            activeEl.isContentEditable
          ) {
            activeEl.blur();
          }
        }
        return;
      }

      if (hasPrimaryMod || e.altKey) return;
      const activeProj = projectRef.current;
      const canPlayActive = hasProjectMedia(activeProj);
      if (
        activeTabRef.current !== "studio" ||
        !canPlayActive ||
        exportSheetOpenRef.current
      ) {
        return;
      }

      if (isKeyboardShortcutBlockedByElement(e.target, document.activeElement)) return;

      if (e.code === "Space" || e.key === " ") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        handleTogglePlayRef.current();
        return;
      }

      if (!hasGeneratedProject(activeProj)) return;

      if (key === "l" && !e.shiftKey) {
        const subs = activeProj.subtitles;
        const targetId =
          selectedSubtitleIdRef.current ??
          findActiveSubtitle(subs, liveCutTimeRef.current)?.id ??
          null;
        if (targetId) {
          e.preventDefault();
          handleToggleLoopSubtitleRef.current(targetId);
        }
        return;
      }

      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        const curTime = liveCutTimeRef.current;
        const exactSub = findExactSubtitleAtTime(activeProj.subtitles, curTime);
        if (!exactSub) {
          showShortcutToast("Move playhead onto a subtitle to split.");
          return;
        }
        if (exactSub.endTime - exactSub.startTime < 0.45) {
          showShortcutToast("Subtitle line is too short to split.");
          return;
        }
        handleSplitSubtitleRef.current(exactSub.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showShortcutToast]);

  const handleOpenSavedProject = async (record: SavedProjectRecord) => {
    if (isLegacyYouTubeProject(record)) {
      setSaveNotice(
        "Legacy YouTube projects are read-only and cannot open in Studio. Export JSON for backup or upload a local video file to edit."
      );
      return;
    }

    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setSeekNonce((n) => n + 1);
    setProcessError(null);
    setSaveNotice(null);
    standaloneTranscriptAbortRef.current?.abort();
    standaloneTranscriptAbortRef.current = null;
    setIsTranscribingStandalone(false);
    setTranscriptProgress(null);
    setTranscriptError(null);
    const restoredTranscript = record.transcriptResult ?? null;
    setTranscriptResult(restoredTranscript);
    if (restoredTranscript) {
      setTranscriptModelId(restoredTranscript.modelId);
      setTranscriptLanguage(restoredTranscript.language);
    }

    let localFile: File | undefined;
    let localUrl: string | undefined;

    try {
      const blobEntry = await getSavedProjectBlob(record.id);
      if (blobEntry) {
        localFile = new File(
          [blobEntry.blob],
          blobEntry.fileName,
          blobEntry.fileType ? { type: blobEntry.fileType } : undefined
        );
        localUrl = registerBlobUrl(localFile);
      } else {
        setSavedProjects((prev) =>
          prev.map((item) =>
            item.id === record.id && item.hasLocalVideoBlob
              ? { ...item, hasLocalVideoBlob: false }
              : item
          )
        );
        setSaveNotice(
          "Subtitles and settings restored. Link the original local video file in the Projects tab to preview or export video."
        );
      }
    } catch {
      setSaveNotice("Could not load cached local video file from browser storage.");
    }

    setActiveSavedId(record.id);
    setVoiceSettings(sanitizeVoiceSettings(record.voiceSettings));
    setVideoEdit(sanitizeEditSettings(record.editSettings));
    const openedMedia: LocalStudioMedia = {
      sourceType: "local",
      localUrl,
      localFile,
      title: record.title,
      channel: record.channel,
      durationSec: record.sourceDurationSec,
      thumbnail: record.thumbnail,
    };
    setLocalMedia(openedMedia);

    const isDraftLocalRecord = record.subtitles.length === 0;
    const openedProj: VideoProject = isDraftLocalRecord
      ? buildDraftLocalProject(
          openedMedia,
          record.selectedScenes.length > 0
            ? record.selectedScenes.map((s) => ({ ...s }))
            : (Array.isArray(record.scenes) ? record.scenes : []).map((s, idx) => ({
                id: s.id || `sc-${idx}-${s.startSec}-${s.endSec}`,
                startSec: s.startSec,
                endSec: s.endSec,
              })),
          {
            title: record.title,
            channel: record.channel,
            sourceDurationSec: record.sourceDurationSec,
            keyframeUrls: Array.isArray(record.keyframeUrls) ? [...record.keyframeUrls] : [],
          }
        )
      : (() => {
          const openedScenes = ensureSceneIds(
            (Array.isArray(record.scenes) ? record.scenes : []).map((s) => ({ ...s }))
          );
          return {
            localUrl,
            localFile,
            title: record.title,
            channel: record.channel,
            sourceDurationSec: record.sourceDurationSec,
            targetDurationSec: record.targetDurationSec,
            scenes: openedScenes,
            subtitles: (Array.isArray(record.subtitles) ? record.subtitles : []).map((sub) =>
              withSceneId(
                {
                  ...sub,
                  words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
                },
                openedScenes
              )
            ),
            speechRegions:
              Array.isArray(record.speechRegions) && record.speechRegions.length > 0
                ? record.speechRegions.map((sr) => ({ ...sr }))
                : (Array.isArray(record.subtitles) ? record.subtitles : []).map((sub) => ({
                    sourceStartSec: sub.sourceStartSec,
                    sourceEndSec: sub.sourceEndSec,
                  })),
            keyframeUrls: Array.isArray(record.keyframeUrls) ? [...record.keyframeUrls] : [],
          };
        })();
    setProject(openedProj);
    setBaselineFromProject(openedProj);

    setActiveTab("studio");
    setStudioSection("edit");
    if (!openedProj.isDraft && record.subtitles.length > 0) {
      setCaptionTab("script");
    }
  };

  const handleRenameSavedProject = async (id: string, title: string) => {
    try {
      const updated = await renameSavedProject(id, title);
      if (!updated) return;
      setSavedProjects((prev) =>
        prev.map((item) => (item.id === id ? updated : item)).sort((a, b) => b.updatedAt - a.updatedAt)
      );
      if (activeSavedId === id) {
        setProject((prev) => (prev ? { ...prev, title: updated.title } : prev));
        if (!isLegacyYouTubeProject(updated)) {
          setLocalMedia((prev) => (prev ? { ...prev, title: updated.title } : prev));
        }
      }
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to rename project.");
    }
  };

  const handleDeleteSavedProject = async (id: string) => {
    try {
      await deleteSavedProject(id);
      setSavedProjects((prev) => prev.filter((item) => item.id !== id));
      if (activeSavedId === id) {
        setActiveSavedId(null);
      }
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to delete project.");
    }
  };

  const handleExportSavedJson = (record: SavedProjectRecord) => {
    const blob = exportProjectAsJson(record);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = record.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36);
    a.download = `${safeName || "project"}-9x16.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleImportSavedJson = async (file: File) => {
    setProcessError(null);
    setSaveNotice(null);
    try {
      const text = await file.text();
      const record = await importProjectFromJsonText(text);
      setSavedProjects((prev) => [record, ...prev]);
      if (isLegacyYouTubeProject(record)) {
        setSaveNotice(
          "Imported legacy YouTube project as read-only. Legacy YouTube records cannot open in Studio; you can export JSON or delete them."
        );
        return;
      }
      await handleOpenSavedProject(record);
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to import project file.");
    }
  };

  const handleRelinkLocalVideo = async (id: string, rawFile: File) => {
    setProcessError(null);
    setSaveNotice(null);
    try {
      const resolvedMime = inferVideoMimeType(rawFile.name, rawFile.type);
      let file: File = rawFile;
      if (rawFile.size > 0 && rawFile.size <= 64 * 1024 * 1024) {
        try {
          const byteBlob = await materializeReadableBlob(rawFile, resolvedMime);
          file = new File(
            [byteBlob],
            rawFile.name,
            resolvedMime ? { type: resolvedMime } : undefined
          );
        } catch {
          file = rawFile;
        }
      }

      const { record, blobSaved } = await attachLocalVideoToSavedProject(id, file);
      if (!record) return;
      setSavedProjects((prev) =>
        prev.map((item) => (item.id === id ? record : item)).sort((a, b) => b.updatedAt - a.updatedAt)
      );
      if (!blobSaved) {
        setSaveNotice(
          "Video attached for this session, though it was too large to cache offline."
        );
      }
      if (activeSavedId === id) {
        const localUrl = registerBlobUrl(file);
        setLocalMedia((prev) =>
          prev ? { ...prev, localUrl, localFile: file, thumbnail: record.thumbnail || prev.thumbnail } : prev
        );
        setProject((prev) => (prev ? { ...prev, localUrl, localFile: file } : prev));
      }
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to link local video.");
    }
  };

  const activeTabLabel =
    activeTab === "youtube"
      ? "Source"
      : activeTab === "studio"
        ? "Studio"
        : "Projects";

  const activeMediaTitle = project?.title || localMedia?.title;

  const clipSubtitleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!hasGeneratedProject(project)) return counts;
    const projScenes = project.scenes;
    const matchedCounts = new Map<number, number>();
    const sceneIdxById = new Map<string, number>();
    projScenes.forEach((ps, idx) => {
      if (ps.id) sceneIdxById.set(ps.id, idx);
    });
    for (const sub of project.subtitles) {
      const resolvedIdx =
        sub.sceneId && sceneIdxById.has(sub.sceneId)
          ? sceneIdxById.get(sub.sceneId)!
          : sub.sceneIndex;
      matchedCounts.set(resolvedIdx, (matchedCounts.get(resolvedIdx) ?? 0) + 1);
    }
    selectedScenes.forEach((sel, selIdx) => {
      let projIdx = projScenes.findIndex(
        (ps) =>
          ps.id === sel.id ||
          (Math.abs(ps.startSec - sel.startSec) < 0.15 &&
            Math.abs(ps.endSec - sel.endSec) < 0.15)
      );
      if (projIdx === -1 && projScenes[selIdx]) {
        const candidate = projScenes[selIdx];
        if (
          Math.abs(candidate.startSec - sel.startSec) < 0.15 &&
          Math.abs(candidate.endSec - sel.endSec) < 0.15
        ) {
          projIdx = selIdx;
        }
      }
      if (projIdx !== -1) {
        counts[sel.id] = matchedCounts.get(projIdx) ?? 0;
      }
    });
    return counts;
  }, [project, selectedScenes]);

  const navItems = [
    { id: "youtube" as const, label: "Source", icon: Compass, count: 0 },
    {
      id: "studio" as const,
      label: "Studio",
      icon: Clapperboard,
      count: !hasGeneratedProject(project) && selectedScenes.length > 0 ? selectedScenes.length : 0,
    },
    { id: "projects" as const, label: "Projects", icon: FolderOpen, count: savedProjects.length },
  ];

  return (
    <div className="h-[100dvh] w-full overflow-hidden flex flex-col lg:flex-row bg-[#f3f5fc] text-[#0c1026] dark:bg-[#070814] dark:text-[#f3f5fc] transition-colors duration-150">
      {/* Desktop Left Primary Activity Rail (72px) */}
      <aside
        aria-label="Primary navigation"
        className="hidden lg:flex w-[72px] shrink-0 flex-col justify-between border-r border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] py-3 px-1.5 z-20"
      >
        <div className="flex flex-col items-center gap-3">
          {/* Official 9:16 Studio Brand Logo */}
          <div className="w-11 h-11 rounded-xl overflow-hidden bg-[#060714] border border-[#2a3463]/80 shadow-sm select-none shrink-0 flex items-center justify-center">
            <img
              src="/assets/aistudio/file_0000000057888207b493e5c3495405b3_5fff1fc9.png"
              alt="9:16 Studio"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          </div>

          <div className="w-8 h-[2px] rounded-full bg-gradient-to-r from-[#a855f7] via-[#3b82f6] to-[#0ea5e9] opacity-80" />

          {/* Vertical Activity Rail Buttons */}
          <nav aria-label="Workspace tabs" className="w-full flex flex-col gap-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.id === "youtube") setIsPlaying(false);
                    setActiveTab(item.id);
                  }}
                  aria-current={active ? "page" : undefined}
                  className={`relative w-full py-2.5 px-1 rounded-md flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
                    active
                      ? "bg-teal-50/90 dark:bg-teal-950/50 text-teal-700 dark:text-teal-400 border border-teal-200/80 dark:border-teal-500/30 font-semibold"
                      : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#e7ecf8]/70 dark:hover:bg-[#141933] border border-transparent"
                  }`}
                >
                  {item.count > 0 && (
                    <span
                      className={`absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-sm text-[9px] font-mono-tabular font-semibold flex items-center justify-center leading-none ${
                        active
                          ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                          : "bg-[#e7ecf8] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4]"
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate max-w-full leading-tight">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Utility Stack: Save Offline & Theme Switch */}
        <div className="w-full flex flex-col items-center gap-1.5 pt-2 border-t border-[#d2dcf0] dark:border-[#21284c]">
          <button
            type="button"
            onClick={() => handleSaveProject(false)}
            disabled={!canSaveCurrent || isSavingProject}
            title="Save project offline (Ctrl+S)"
            aria-label="Save project offline"
            className={`w-full py-2 px-1 rounded-md flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400 ${
              justSaved
                ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700/50"
                : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#e7ecf8]/70 dark:hover:bg-[#141933]"
            }`}
          >
            {isSavingProject ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : justSaved ? (
              <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Bookmark className="w-4 h-4" />
            )}
            <span>
              {isSavingProject
                ? "Saving"
                : justSaved
                  ? "Saved"
                  : activeSavedId
                    ? "Update"
                    : "Save"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label={darkMode ? "Switch to Light mode" : "Switch to Dark mode"}
            title={darkMode ? "Switch to Light mode" : "Switch to Dark mode"}
            className="w-full py-2 px-1 rounded-md flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#e7ecf8]/70 dark:hover:bg-[#141933] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 dark:focus-visible:ring-teal-400"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span>{darkMode ? "Light" : "Dark"}</span>
          </button>
        </div>
      </aside>

      {/* Right Main Workstation Column */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {/* Ultra-Slim Top Command Bar */}
        <header className="h-12 shrink-0 px-3 sm:px-4 border-b border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] flex items-center justify-between gap-3">
          {/* Left: Breadcrumb & Active Project Context */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="lg:hidden w-7 h-7 rounded-md overflow-hidden bg-[#060714] border border-[#2a3463]/80 flex items-center justify-center shrink-0">
              <img
                src="/assets/aistudio/file_0000000057888207b493e5c3495405b3_5fff1fc9.png"
                alt="9:16 Studio"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>

            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-display text-sm font-bold tracking-tight text-[#0c1026] dark:text-[#f3f5fc] whitespace-nowrap">
                9:16 Studio
              </span>
              <span
                aria-hidden="true"
                className="text-xs text-[#4d597d]/60 dark:text-[#919ec4]/60 select-none"
              >
                /
              </span>
              <span className="text-xs font-semibold text-teal-700 dark:text-teal-400 whitespace-nowrap">
                {activeTabLabel}
              </span>
            </div>

            {activeMediaTitle && (
              <span className="hidden md:inline-block text-xs text-[#4d597d] dark:text-[#919ec4] truncate max-w-[200px] lg:max-w-[320px] pl-2.5 ml-1 border-l border-[#d2dcf0] dark:border-[#21284c]">
                {activeMediaTitle}
              </span>
            )}
          </div>

          {/* Right: Quick Mobile Utilities + Dominant Export MP4 CTA */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {hasGeneratedProject(project) && (
              <span className="hidden sm:inline-block text-[11px] font-mono-tabular text-[#4d597d] dark:text-[#919ec4] pr-2 border-r border-[#d2dcf0] dark:border-[#21284c] whitespace-nowrap">
                {project.scenes.length} {project.scenes.length === 1 ? "clip" : "clips"} ·{" "}
                {Math.round(project.targetDurationSec)}s
              </span>
            )}

            <PWAInstallButton />

            <button
              type="button"
              onClick={() => handleSaveProject(false)}
              disabled={!canSaveCurrent || isSavingProject}
              title="Save project offline (Ctrl+S)"
              aria-label="Save project offline"
              className="lg:hidden h-8 w-8 sm:w-auto sm:px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {isSavingProject ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : justSaved ? (
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Bookmark className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">
                {isSavingProject ? "Saving" : justSaved ? "Saved" : activeSavedId ? "Update" : "Save"}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label={darkMode ? "Switch to Light mode" : "Switch to Dark mode"}
              title={darkMode ? "Switch to Light mode" : "Switch to Dark mode"}
              className="lg:hidden w-8 h-8 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] flex items-center justify-center transition-colors cursor-pointer shrink-0"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleExportHeaderClick}
                disabled={
                  !exportProgress &&
                  !(readyDownload && !isExportStale) &&
                  !exportError &&
                  (!hasGeneratedProject(project) || project.scenes.length === 0 || isProcessing)
                }
                title={
                  exportProgress
                    ? "View export progress or cancel"
                    : readyDownload && !isExportStale
                      ? "Open exported MP4"
                      : exportError
                        ? "View export error"
                        : isExportStale
                          ? "Export updated 9:16 MP4"
                          : "Export 9:16 MP4"
                }
                aria-label={
                  exportProgress
                    ? `Exporting ${exportProgress.percent} percent, open details`
                    : readyDownload && !isExportStale
                      ? "Export ready, open to save or re-export MP4"
                      : exportError
                        ? "Export failed, open details"
                        : isExportStale
                          ? "Export updated 9:16 MP4"
                          : "Export 9:16 MP4"
                }
                className={`relative overflow-hidden h-8 px-3.5 sm:px-4 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 sm:gap-2 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/50 dark:focus-visible:ring-teal-400/50 ${
                  readyDownload && !isExportStale && !exportProgress
                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                    : exportError && !exportProgress
                      ? "border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60"
                      : "bg-teal-700 hover:bg-teal-800 text-white dark:bg-teal-400 dark:hover:bg-teal-300 dark:text-[#060918]"
                }`}
              >
                {exportProgress ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span className="font-mono-tabular">{exportProgress.percent}%</span>
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-0 h-[2px] bg-white/80 dark:bg-[#060918]/70 transition-[width] duration-300"
                      style={{ width: `${Math.max(6, exportProgress.percent)}%` }}
                    />
                  </>
                ) : readyDownload && !isExportStale ? (
                  <>
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    <span>{hasSavedExport ? "Saved" : "MP4 Ready"}</span>
                  </>
                ) : exportError ? (
                  <>
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>Export Failed</span>
                  </>
                ) : (
                  <>
                    <ArrowUpFromLine className="w-3.5 h-3.5 shrink-0" />
                    <span>Export MP4</span>
                  </>
                )}
              </button>

              {readyDownload && !isExportStale && !exportProgress && hasGeneratedProject(project) && project.scenes.length > 0 && (
                <button
                  type="button"
                  onClick={() => void startBackgroundExport(true)}
                  disabled={isProcessing}
                  title="Re-export 9:16 MP4"
                  aria-label="Re-export 9:16 MP4"
                  className="h-8 px-2 sm:px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">Re-export</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Main Workspace Body */}
        {(() => {
          const isEmptyStudio = activeTab === "studio" && !hasProjectMedia(project);
          const showStage = activeTab === "studio" && !isEmptyStudio;
          const useDesktopStudio = showStage && isDesktop;
          const renderInlineStageInSidebar = showStage && !isDesktop;
          const stageWidthPct = Math.min(58, Math.max(24, 30 + stagePreviewScale * 14));

          const stageNode = showStage ? (
            <Stage9x16
              ref={stageRef}
              project={project}
              cutTime={cutTime}
              subscribeCutTime={subscribeCutTime}
              getLiveCutTime={getLiveCutTime}
              seekNonce={seekNonce}
              isPlaying={isPlaying}
              muted={muted}
              voiceSettings={voiceSettings}
              editSettings={videoEdit}
              onTogglePlay={handleTogglePlay}
              onPlayingChange={handlePlayingChange}
              onSeek={handleSeek}
              onTimeUpdate={handlePlayerTimeUpdate}
              onEnded={handlePlaybackEnded}
              onToggleMute={() => setMuted((m) => !m)}
              compactMobile={!isDesktop}
              fitContainerHeight={isDesktop}
              previewScale={stagePreviewScale}
              onChangePreviewScale={setStagePreviewScale}
              onChangeVideoHeightPct={(pct) =>
                setVideoEdit((prev) => ({
                  ...prev,
                  videoHeightPct: Math.max(26, Math.min(52, Math.round(pct))),
                }))
              }
              onChangeAspectRatio={(aspectRatio) =>
                setVideoEdit((prev) => ({ ...prev, aspectRatio }))
              }
              selectedSubtitleId={selectedSubtitleId}
              onSelectSubtitle={handleSelectStageSubtitle}
              onUploadVideo={handleUploadLocalVideo}
              onDetectedDuration={handleDetectedLocalDuration}
              hideCaptions={false}
            />
          ) : null;

          const sidebarNode = (
            <WorkspaceSidebar
              activeTab={activeTab}
              videos={videos}
              selectedVideoId={sourcePreview?.videoId}
              activeQuery={activeQuery}
              licenseFilter={licenseFilter}
              thaiOnly={thaiOnly}
              hasMoreVideos={Boolean(nextContinuation)}
              isLoadingMore={isLoadingMore}
              localMedia={localMedia}
              sourcePreview={sourcePreview}
              selectedScenes={selectedScenes}
              voiceSettings={voiceSettings}
              editSettings={videoEdit}
              isSearching={isSearching}
              isProcessing={isProcessing}
              generationProgress={generationProgress}
              clipSubtitleCounts={clipSubtitleCounts}
              regeneratingClipId={regeneratingClipId}
              regeneratingClipPercent={regeneratingClipPercent}
              isPlaying={isPlaying}
              timelineDirty={timelineDirty}
              searchError={searchError}
              project={project}
              cutTime={cutTime}
              subscribeCutTime={subscribeCutTime}
              savedProjects={savedProjects}
              activeSavedId={activeSavedId}
              canSaveCurrent={canSaveCurrent}
              isLoadingSaved={isLoadingSaved}
              isSavingProject={isSavingProject}
              onSelectVideo={handleSelectVideo}
              onChangeLicenseFilter={handleChangeLicenseFilter}
              onToggleThaiOnly={handleToggleThaiOnly}
              onLoadMoreVideos={handleLoadMoreVideos}
              onResetToRecommended={handleResetToRecommended}
              onRefreshRecommended={handleRefreshRecommended}
              onDetectedYouTubeDuration={(dur) =>
                setSourcePreview((prev) => (prev ? { ...prev, durationSec: dur } : prev))
              }
              onExportAudio={localMedia ? () => void handleExportAudioOnly() : undefined}
              isExportingAudio={isExportingAudio}
              processError={processError}
              onGenerateSingleClip={handleGenerateSingleClip}
              onCancelGenerateSubtitles={handleCancelGenerateSubtitles}
              onChangeVoiceSettings={setVoiceSettings}
              onChangeEditSettings={setVideoEdit}
              onUploadLocalVideo={handleUploadLocalVideo}
              onClearLocalVideo={handleClearLocalVideo}
              onSeek={handleSeek}
              onScrubbingChange={handleScrubbingChange}
              onTogglePlay={handleTogglePlay}
              onPause={handlePause}
              onPlayFromTime={handlePlayFromTime}
              onUpdateProjectScenes={handleUpdateProjectScenes}
              onResetTimeline={handleResetTimeline}
              onAddMediaClip={handleAddMediaClip}
              onUpdateSubtitle={handleUpdateSubtitle}
              onUpdateWordGloss={handleUpdateWordGloss}
              onFindReplaceSubtitles={handleFindReplaceSubtitles}
              onAddSubtitle={handleAddSubtitle}
              onOpenPasteTranscript={() => setShowPasteTranscriptDialog(true)}
              onClearAllSubtitles={handleClearAllSubtitles}
              onDeleteSubtitle={handleDeleteSubtitle}
              onUpdateSubtitleTiming={handleUpdateSubtitleTiming}
              onSplitSubtitle={handleSplitSubtitle}
              onMergeSubtitleWithNext={handleMergeSubtitleWithNext}
              onShiftAllSubtitles={handleShiftAllSubtitles}
              loopingSubId={loopingSubId}
              onToggleLoopSubtitle={handleToggleLoopSubtitle}
              canUndo={undoStack.length > 0}
              canRedo={redoStack.length > 0}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndoSubtitles={undoStack.length > 0}
              canRedoSubtitles={redoStack.length > 0}
              onUndoSubtitles={handleUndo}
              onRedoSubtitles={handleRedo}
              onAutoFixSubtitleTimings={handleAutoFixSubtitleTimings}
              onAiResyncSubtitles={handleAiResyncSubtitles}
              onCancelAiResync={handleCancelAiResync}
              isResyncingTimings={isResyncingTimings}
              onRegenerateSubtitle={handleRegenerateSubtitle}
              onCancelRegenerateSubtitle={handleCancelRegenerateSubtitle}
              onRetranslateAll={handleRetranslateAll}
              onCancelRetranslateAll={handleCancelRetranslateAll}
              regeneratingSubIds={regeneratingSubIds}
              retranslatingSubIds={retranslatingSubIds}
              isRetranslatingAll={isRetranslatingAll}
              subtitleRegenError={subtitleRegenError}
              onClearSubtitleRegenError={() => setSubtitleRegenError(null)}
              onSaveProject={handleSaveProject}
              onOpenSavedProject={handleOpenSavedProject}
              onRenameSavedProject={handleRenameSavedProject}
              onDeleteSavedProject={handleDeleteSavedProject}
              onExportSavedJson={handleExportSavedJson}
              onImportSavedJson={handleImportSavedJson}
              onRelinkLocalVideo={handleRelinkLocalVideo}
              ytPreviewSec={ytPreviewSec}
              ytSeekRequest={ytSeekRequest}
              onYtCurrentSecChange={setYtPreviewSec}
              inlineStage={renderInlineStageInSidebar ? stageNode : undefined}
              isMobileStudio={!isDesktop}
              stagePreviewScale={stagePreviewScale}
              onChangeStagePreviewScale={setStagePreviewScale}
              searchInput={searchInput}
              onChangeSearchInput={setSearchInput}
              onSubmitSearch={() => {
                setActiveTab("youtube");
                runSearch(searchInput, licenseFilter, thaiOnly);
              }}
              onClearSearch={() => {
                setSearchInput("");
                setActiveTab("youtube");
                runSearch("", licenseFilter, thaiOnly);
              }}
              studioSection={studioSection}
              onChangeStudioSection={setStudioSection}
              selectedSubtitleId={selectedSubtitleId}
              onSelectSubtitle={setSelectedSubtitleId}
              onSelectTimelineSubtitle={handleSelectTimelineSubtitle}
              editingSubtitleId={editingSubtitleId}
              onEditSubtitle={(id) => {
                setSelectedSubtitleId(id);
                setEditingSubtitleId(id);
                setStudioSection("edit");
                const target = project?.subtitles.find((s) => s.id === id);
                if (target) {
                  handleSeek(target.startTime);
                }
              }}
              onCloseEditSubtitle={() => setEditingSubtitleId(null)}
              captionTab={captionTab}
              onChangeCaptionTab={setCaptionTab}
              isSubtitleSearchOpen={isSubtitleSearchOpen}
              onChangeSubtitleSearchOpen={setIsSubtitleSearchOpen}
              autoFollowState={autoFollowState}
              onChangeAutoFollowState={setAutoFollowState}
              stageSelectRequest={stageSelectRequest}
              cutSpeechRegions={cutSpeechRegions}
              onUpdateWordChip={handleUpdateWordChip}
              onMergeWordChips={handleMergeWordChips}
              onSplitWordChip={handleSplitWordChip}
              onFillMissingGlosses={handleFillMissingGlosses}
              onTranscribeRange={handleTranscribeRange}
              transcribingRange={transcribingRange}
              onApplyPasteTranscriptSync={handleApplyPasteTranscriptSync}
              onPreviewSourceSeek={handlePreviewSourceSeek}
              hideCaptions={!SHOW_CAPTIONS_UI}
              transcriptModelId={transcriptModelId}
              transcriptLanguage={transcriptLanguage}
              transcriptWordTimestamps={transcriptWordTimestamps}
              isTranscribingStandalone={isTranscribingStandalone}
              transcriptProgress={transcriptProgress}
              transcriptError={transcriptError}
              transcriptResult={transcriptResult}
              onChangeTranscriptModel={setTranscriptModelId}
              onChangeTranscriptLanguage={setTranscriptLanguage}
              onChangeTranscriptWordTimestamps={setTranscriptWordTimestamps}
              onStartStandaloneTranscript={handleStartStandaloneTranscript}
              onCancelStandaloneTranscript={handleCancelStandaloneTranscript}
              onClearTranscriptError={() => setTranscriptError(null)}
              onUpdateTranscriptSegmentText={handleUpdateTranscriptSegmentText}
            />
          );

          const hasAlerts = Boolean(processError || saveNotice);
          const alertsNode = hasAlerts ? (
            <div className="px-3.5 py-2 border-b border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#070814] space-y-2 shrink-0">
              {processError && (
                <div className="px-3 py-2 rounded-md border border-red-200 dark:border-red-900/70 bg-red-50/80 dark:bg-red-950/35 flex items-start justify-between gap-3 text-xs text-red-700 dark:text-red-300">
                  <span className="min-w-0 break-words leading-relaxed">{processError}</span>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    {lastGenActionRef.current &&
                      selectedScenes.length > 0 &&
                      Boolean(localMedia) &&
                      !isProcessing && (
                        <button
                          type="button"
                          onClick={() => {
                            const act = lastGenActionRef.current;
                            if (act?.type === "clip") {
                              void handleGenerateSingleClip(act.sceneId);
                            } else {
                              void handleGenerateSubtitles();
                            }
                          }}
                          className="text-[11px] font-semibold text-red-700 dark:text-red-200 hover:underline cursor-pointer"
                        >
                          Retry
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() => setProcessError(null)}
                      className="text-[11px] font-medium text-red-600/80 dark:text-red-300/80 hover:underline cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {saveNotice && (
                <div className="px-3 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] flex items-center justify-between gap-2 text-xs text-[#4d597d] dark:text-[#919ec4]">
                  <span>{saveNotice}</span>
                  <button
                    type="button"
                    onClick={() => setSaveNotice(null)}
                    className="text-[11px] font-medium text-teal-700 dark:text-teal-400 hover:underline shrink-0 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ) : null;

          if (isEmptyStudio) {
            return (
              <main className="flex-1 min-h-0 w-full flex flex-col overflow-hidden">
                {alertsNode}
                <EmptyStudioUpload onUploadVideo={handleUploadLocalVideo} />
              </main>
            );
          }

          if (useDesktopStudio) {
            return (
              <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Upper Split: Left Cinema Matte 9:16 Stage + Right NLE Inspector */}
                <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
                  <section
                    style={{ width: `${stageWidthPct.toFixed(2)}%` }}
                    className="shrink-0 min-w-[260px] max-w-[720px] flex items-center justify-center min-h-0 bg-[#dfe5f4] dark:bg-[#04050e] p-3 lg:p-4 overflow-hidden"
                  >
                    {stageNode}
                  </section>

                  <section className="flex-1 min-w-0 min-h-0 flex flex-col border-l border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] overflow-hidden">
                    {alertsNode}
                    {sidebarNode}
                  </section>
                </div>

                {/* Lower Studio Area: Edge-to-Edge Bottom Timeline Dock (visible only in Edit tab when not editing a single subtitle clip) */}
                {studioSection === "edit" && !editingSubtitleId && (
                  <div className="shrink-0">
                    <ProjectTimelineEditor
                      dockMode
                      isCollapsed={false}
                      project={project}
                      cutTime={cutTime}
                      subscribeCutTime={subscribeCutTime}
                      isPlaying={isPlaying}
                      isActive={activeTab === "studio" && studioSection === "edit"}
                      hideTransport
                      hideCaptions={!SHOW_CAPTIONS_UI}
                      showSubtitleTrack
                      onTogglePlay={handleTogglePlay}
                      onPause={handlePause}
                      onSeek={handleSeek}
                      onScrubbingChange={handleScrubbingChange}
                      onPlayFromTime={handlePlayFromTime}
                      onUpdateScenes={handleUpdateProjectScenes}
                      onUpdateSubtitleTiming={handleUpdateSubtitleTiming}
                      onAddSubtitle={handleAddSubtitle}
                      onOpenPasteTranscript={() => setShowPasteTranscriptDialog(true)}
                      onClearAllSubtitles={handleClearAllSubtitles}
                      onEditSubtitle={(id) => {
                        setSelectedSubtitleId(id);
                        setEditingSubtitleId(id);
                        setStudioSection("edit");
                        const target = project?.subtitles.find((s) => s.id === id);
                        if (target) {
                          handleSeek(target.startTime);
                        }
                      }}
                      onDeleteSubtitle={handleDeleteSubtitle}
                      onSplitSubtitle={handleSplitSubtitle}
                      onMergeSubtitleWithNext={handleMergeSubtitleWithNext}
                      onShiftAllSubtitles={handleShiftAllSubtitles}
                      onUndo={handleUndo}
                      onRedo={handleRedo}
                      canUndo={undoStack.length > 0}
                      canRedo={redoStack.length > 0}
                      onResetTimeline={handleResetTimeline}
                      onGoToScenes={() => setStudioSection("edit")}
                      onAddMediaClip={handleAddMediaClip}
                      cutSpeechRegions={cutSpeechRegions}
                      onTranscribeRange={handleTranscribeRange}
                      transcribingRange={transcribingRange}
                      clipSubtitleCounts={clipSubtitleCounts}
                      regeneratingClipId={regeneratingClipId}
                      regeneratingClipPercent={regeneratingClipPercent}
                      onGenerateSingleClip={handleGenerateSingleClip}
                      onPreviewSourceSeek={handlePreviewSourceSeek}
                      selectedSubtitleId={selectedSubtitleId}
                      onSelectSubtitle={handleSelectTimelineSubtitle}
                      hideUndoRedo
                    />
                  </div>
                )}
              </main>
            );
          }

          return (
            <main className="flex-1 min-h-0 w-full flex flex-col overflow-hidden">
              {alertsNode}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {sidebarNode}
              </div>
            </main>
          );
        })()}

        {/* Mobile / Tablet Thumb-First Bottom Navigation Bar */}
        <nav
          aria-label="Mobile navigation"
          className="lg:hidden shrink-0 border-t border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] px-2 py-1 grid grid-cols-3 gap-1"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id === "youtube") setIsPlaying(false);
                  setActiveTab(item.id);
                }}
                aria-current={active ? "page" : undefined}
                className={`h-11 rounded-md flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  active
                    ? "bg-teal-50/90 dark:bg-teal-950/50 text-teal-700 dark:text-teal-400 font-semibold"
                    : "text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc]"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-full px-1">
                  {item.count > 0 ? `${item.label} (${item.count})` : item.label}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <ExportSheet
        open={exportSheetOpen}
        progress={exportProgress}
        result={readyDownload}
        hasSaved={hasSavedExport}
        isStale={isExportStale}
        error={exportError}
        canShare={readyDownload ? canShareMp4File(readyDownload) : false}
        onMinimize={handleMinimizeExportSheet}
        onCancel={handleCancelExport}
        onSave={triggerSafeBlobDownload}
        onShare={handleShareMp4}
        onRetry={() => void startBackgroundExport(true)}
        onDiscardResult={handleDiscardExportResult}
      />

      <PasteStructuredTranscriptDialog
        isOpen={Boolean(showPasteTranscriptDialog && project)}
        onClose={() => setShowPasteTranscriptDialog(false)}
        selectedScenes={selectedScenes}
        totalDurationSec={project?.targetDurationSec || localMedia?.durationSec || 0}
        existingSubtitleCount={project?.subtitles.length ?? 0}
        onApply={handleApplyPastedTranscript}
      />

      {shortcutToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-16 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#0c1026]/95 dark:bg-[#141933]/95 text-white text-xs font-medium shadow-lg pointer-events-none"
        >
          {shortcutToast}
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}
