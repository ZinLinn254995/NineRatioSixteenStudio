import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Check, Download, Loader2, Moon, Search, Sun, Upload, X } from "lucide-react";
import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
  SpeakingScene,
  SubtitleItem,
  SubtitleWord,
  TranslationTone,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "./types";
import { Stage9x16, type StagePreviewSize } from "./components/Stage9x16";
import { mapCutTimeToSource } from "./components/YouTubeScenePlayer";
import { WorkspaceSidebar, type WorkspaceTab } from "./components/WorkspaceSidebar";
import { exportProjectToMp4, type ExportProgress } from "./utils/exportVideo";
import { DEFAULT_VOICE_SETTINGS } from "./utils/voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./utils/videoFilters";
import { resumeAllVoiceContexts } from "./utils/webAudioVoice";
import { safeReadJson, uploadBlobInChunks } from "./utils/uploadFile";
import {
  ensureSceneIds,
  getSceneDurationSec,
  remapSubtitlesToScenes,
} from "./utils/projectTimeline";
import {
  attachLocalVideoToSavedProject,
  deleteSavedProject,
  exportProjectAsJson,
  getSavedProjectBlob,
  importProjectFromJsonText,
  inferVideoMimeType,
  listSavedProjects,
  materializeReadableBlob,
  renameSavedProject,
  saveOfflineProject,
} from "./utils/offlineProjects";

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

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("videos");
  const [localMedia, setLocalMedia] = useState<ActiveMediaSource | null>(null);
  const [youtubeMedia, setYoutubeMedia] = useState<ActiveMediaSource | null>(null);
  const [selectedScenes, setSelectedScenes] = useState<SceneSelection[]>([]);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    ...DEFAULT_VOICE_SETTINGS,
  });
  const [videoEdit, setVideoEdit] = useState<VideoEditSettings>({
    ...DEFAULT_VIDEO_EDIT,
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [regeneratingSubIds, setRegeneratingSubIds] = useState<string[]>([]);
  const [isRetranslatingAll, setIsRetranslatingAll] = useState(false);
  const [isResyncingTimings, setIsResyncingTimings] = useState(false);
  const [subtitleRegenError, setSubtitleRegenError] = useState<string | null>(null);
  const [loopingSubId, setLoopingSubId] = useState<string | null>(null);

  const [project, setProject] = useState<VideoProject | null>(null);
  const [cutTime, setCutTime] = useState(0);
  const [seekNonce, setSeekNonce] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);

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
  const [stagePreviewSize, setStagePreviewSize] = useState<StagePreviewSize>("normal");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRunIdRef = useRef(0);
  const generateAbortRef = useRef<AbortController | null>(null);
  const resyncAbortRef = useRef<AbortController | null>(null);
  const retranslateAbortRef = useRef<AbortController | null>(null);
  const regenAbortMapRef = useRef<Map<string, AbortController>>(new Map());
  const searchSeqRef = useRef(0);
  const createdUrlsRef = useRef<string[]>([]);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef<VideoProject | null>(null);
  projectRef.current = project;
  const loopingSubIdRef = useRef<string | null>(null);
  loopingSubIdRef.current = loopingSubId;
  const cutTimeRef = useRef(0);
  cutTimeRef.current = cutTime;
  const lastLoopSeekAtRef = useRef(0);
  const timelineBaselineRef = useRef<{
    scenes: SpeakingScene[];
    subtitles: SubtitleItem[];
  } | null>(null);
  const [timelineDirty, setTimelineDirty] = useState(false);

  interface SubtitleSnapshot {
    subtitles: SubtitleItem[];
    baselineSubtitles: SubtitleItem[] | null;
  }
  const [subUndoStack, setSubUndoStack] = useState<SubtitleSnapshot[]>([]);
  const [subRedoStack, setSubRedoStack] = useState<SubtitleSnapshot[]>([]);
  const subUndoStackRef = useRef<SubtitleSnapshot[]>([]);
  subUndoStackRef.current = subUndoStack;
  const subRedoStackRef = useRef<SubtitleSnapshot[]>([]);
  subRedoStackRef.current = subRedoStack;
  const lastSubTypingCoalesceRef = useRef<{ key: string; at: number } | null>(null);

  const cloneSubtitleList = useCallback(
    (subs: SubtitleItem[]): SubtitleItem[] =>
      subs.map((sub) => ({
        ...sub,
        words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
      })),
    []
  );

  const pushSubtitleUndo = useCallback(
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

      const snap: SubtitleSnapshot = {
        subtitles: cloneSubtitleList(curProj.subtitles),
        baselineSubtitles: timelineBaselineRef.current
          ? cloneSubtitleList(timelineBaselineRef.current.subtitles)
          : null,
      };
      setSubUndoStack((prev) => [...prev.slice(-39), snap]);
      setSubRedoStack([]);
    },
    [cloneSubtitleList]
  );

  const handleUndoSubtitles = useCallback(() => {
    const curProj = projectRef.current;
    const undoList = subUndoStackRef.current;
    if (!curProj || undoList.length === 0) return;

    const prevSnap = undoList[undoList.length - 1];
    const currentSnap: SubtitleSnapshot = {
      subtitles: cloneSubtitleList(curProj.subtitles),
      baselineSubtitles: timelineBaselineRef.current
        ? cloneSubtitleList(timelineBaselineRef.current.subtitles)
        : null,
    };

    lastSubTypingCoalesceRef.current = null;
    setSubUndoStack((prev) => prev.slice(0, -1));
    setSubRedoStack((prev) => [...prev.slice(-39), currentSnap]);

    if (timelineBaselineRef.current && prevSnap.baselineSubtitles) {
      timelineBaselineRef.current.subtitles = cloneSubtitleList(prevSnap.baselineSubtitles);
    }
    setProject((prev) =>
      prev ? { ...prev, subtitles: cloneSubtitleList(prevSnap.subtitles) } : prev
    );
  }, [cloneSubtitleList]);

  const handleRedoSubtitles = useCallback(() => {
    const curProj = projectRef.current;
    const redoList = subRedoStackRef.current;
    if (!curProj || redoList.length === 0) return;

    const nextSnap = redoList[redoList.length - 1];
    const currentSnap: SubtitleSnapshot = {
      subtitles: cloneSubtitleList(curProj.subtitles),
      baselineSubtitles: timelineBaselineRef.current
        ? cloneSubtitleList(timelineBaselineRef.current.subtitles)
        : null,
    };

    lastSubTypingCoalesceRef.current = null;
    setSubRedoStack((prev) => prev.slice(0, -1));
    setSubUndoStack((prev) => [...prev.slice(-39), currentSnap]);

    if (timelineBaselineRef.current && nextSnap.baselineSubtitles) {
      timelineBaselineRef.current.subtitles = cloneSubtitleList(nextSnap.baselineSubtitles);
    }
    setProject((prev) =>
      prev ? { ...prev, subtitles: cloneSubtitleList(nextSnap.subtitles) } : prev
    );
  }, [cloneSubtitleList]);

  const setBaselineFromProject = useCallback((proj: VideoProject | null) => {
    resyncAbortRef.current?.abort();
    resyncAbortRef.current = null;
    retranslateAbortRef.current?.abort();
    retranslateAbortRef.current = null;
    regenAbortMapRef.current.forEach((ctrl) => ctrl.abort());
    regenAbortMapRef.current.clear();
    setIsResyncingTimings(false);
    setIsRetranslatingAll(false);
    setRegeneratingSubIds([]);

    lastSubTypingCoalesceRef.current = null;
    setSubUndoStack([]);
    setSubRedoStack([]);
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

  // Pre-load the first recommended YouTube video into YouTube Preview by default
  useEffect(() => {
    if (!youtubeMedia && videos.length > 0) {
      const first = videos[0];
      setYoutubeMedia({
        sourceType: "youtube",
        videoId: first.videoId,
        title: first.title,
        channel: first.channel,
        durationSec: first.durationSec,
        thumbnail: first.thumbnail,
      });
    }
  }, [youtubeMedia, videos]);

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

  // Clicking a YouTube video opens it in its dedicated YouTube Preview tab without disturbing Watch & Scenes local edits
  const handleSelectVideo = (video: YouTubeVideo) => {
    setYtPreviewSec(0);
    setYtSeekRequest(null);
    setProcessError(null);
    setSaveNotice(null);
    setProject((prev) => {
      if (prev?.sourceType === "local") return prev;
      setBaselineFromProject(null);
      return null;
    });
    setYoutubeMedia({
      sourceType: "youtube",
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      durationSec: video.durationSec,
      thumbnail: video.thumbnail,
    });
    setActiveTab("ytPreview");
  };

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
    setSelectedScenes([]);

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
        v.removeAttribute("src");
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

    setLocalMedia({
      sourceType: "local",
      localUrl,
      localFile: file,
      title: file.name.replace(/\.[^.]+$/, ""),
      channel: "Local Video",
      durationSec,
    });
    setSelectedScenes([
      {
        id: `sc-${Date.now()}`,
        startSec: 0,
        endSec: durationSec,
      },
    ]);
    setActiveTab("scenes");
  };

  const handleClearLocalVideo = () => {
    activeRunIdRef.current++;
    if (localMedia?.localUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(localMedia.localUrl);
      createdUrlsRef.current = createdUrlsRef.current.filter((u) => u !== localMedia.localUrl);
    }
    setIsProcessing(false);
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);
    setSelectedScenes([]);
    setLocalMedia(null);
    setProject((prev) => {
      if (prev?.sourceType === "local") {
        setBaselineFromProject(null);
        return null;
      }
      return prev;
    });
    setActiveTab("scenes");
  };

  const handleUpdateScene = (id: string, startSec: number, endSec: number) => {
    setSelectedScenes((prev) =>
      prev.map((sc) => (sc.id === id ? { ...sc, startSec, endSec } : sc))
    );
  };

  const handleRemoveScene = (id: string) => {
    setSelectedScenes((prev) => prev.filter((sc) => sc.id !== id));
  };

  const handleCancelGenerateSubtitles = useCallback(() => {
    activeRunIdRef.current++;
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    setIsProcessing(false);
    setProcessError(null);
  }, []);

  // Triggered explicitly by the user after watching and selecting their scenes
  const handleGenerateSubtitles = async () => {
    const targetMedia = localMedia ?? youtubeMedia;
    if (!targetMedia || selectedScenes.length === 0) return;

    const runId = ++activeRunIdRef.current;
    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setIsPlaying(false);
    setCutTime(0);
    setIsProcessing(true);
    setProcessError(null);

    try {
      const scenePayload = selectedScenes.map(({ startSec, endSec }) => ({
        startSec,
        endSec,
      }));

      if (targetMedia.sourceType === "local" && targetMedia.localFile) {
        let uploadId = targetMedia.uploadId;
        if (!uploadId) {
          uploadId = await uploadBlobInChunks(
            targetMedia.localFile,
            targetMedia.localFile.name,
            controller.signal
          );
          if (activeRunIdRef.current !== runId) return;
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        }

        let resp = await fetch("/api/process-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId,
            title: targetMedia.title,
            durationSec: targetMedia.durationSec,
            selectedScenes: scenePayload,
            translationTone: videoEdit.translationTone,
          }),
          signal: controller.signal,
        });

        // If server restarted and tmp upload expired, re-upload once transparently
        if (resp.status === 404) {
          uploadId = await uploadBlobInChunks(
            targetMedia.localFile,
            targetMedia.localFile.name,
            controller.signal
          );
          if (activeRunIdRef.current !== runId) return;
          setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          resp = await fetch("/api/process-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadId,
              title: targetMedia.title,
              durationSec: targetMedia.durationSec,
              selectedScenes: scenePayload,
              translationTone: videoEdit.translationTone,
            }),
            signal: controller.signal,
          });
        }

        const data = await safeReadJson<VideoProject & { error?: string }>(resp);
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        const nextProj: VideoProject = {
          ...data,
          scenes: ensureSceneIds(data.scenes),
          sourceType: "local",
          localUrl: targetMedia.localUrl,
          localFile: targetMedia.localFile,
        };
        setProject(nextProj);
        setBaselineFromProject(nextProj);
        setActiveTab("script");
      } else if (targetMedia.sourceType === "youtube" && targetMedia.videoId) {
        const resp = await fetch("/api/process-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: targetMedia.videoId,
            title: targetMedia.title,
            channel: targetMedia.channel,
            durationSec: targetMedia.durationSec,
            selectedScenes: scenePayload,
            translationTone: videoEdit.translationTone,
          }),
          signal: controller.signal,
        });
        const data = await safeReadJson<VideoProject & { error?: string }>(resp);
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        const nextProj: VideoProject = {
          ...data,
          scenes: ensureSceneIds(data.scenes),
        };
        setProject(nextProj);
        setBaselineFromProject(nextProj);
        setActiveTab("script");
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      if (activeRunIdRef.current === runId) {
        setProcessError(err instanceof Error ? err.message : "Failed to transcribe scenes.");
      }
    } finally {
      if (generateAbortRef.current === controller) {
        generateAbortRef.current = null;
      }
      if (activeRunIdRef.current === runId) {
        setIsProcessing(false);
      }
    }
  };

  const handleSeek = (sec: number) => {
    const activeLoopId = loopingSubIdRef.current;
    if (activeLoopId) {
      const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
      if (!loopSub || sec < loopSub.startTime - 0.1 || sec > loopSub.endTime + 0.1) {
        setLoopingSubId(null);
      }
    }
    setCutTime(sec);
    setSeekNonce((n) => n + 1);
  };

  const handlePlayerTimeUpdate = useCallback((newCutTime: number) => {
    const activeLoopId = loopingSubIdRef.current;
    if (activeLoopId) {
      const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
      if (loopSub && newCutTime >= loopSub.endTime - 0.04) {
        const now = performance.now();
        if (now - lastLoopSeekAtRef.current > 180) {
          lastLoopSeekAtRef.current = now;
          setCutTime(loopSub.startTime);
          setSeekNonce((n) => n + 1);
          return;
        }
      }
    }
    setCutTime(newCutTime);
  }, []);

  const handlePlaybackEnded = useCallback(() => {
    const activeLoopId = loopingSubIdRef.current;
    if (activeLoopId) {
      const loopSub = projectRef.current?.subtitles.find((s) => s.id === activeLoopId);
      if (loopSub) {
        lastLoopSeekAtRef.current = performance.now();
        setCutTime(loopSub.startTime);
        setSeekNonce((n) => n + 1);
        setIsPlaying(true);
        return;
      }
    }
    setLoopingSubId(null);
    setIsPlaying(false);
    setCutTime(0);
    setSeekNonce((n) => n + 1);
  }, []);

  const handleTogglePlay = () => {
    if (!project || project.scenes.length === 0) return;
    resumeAllVoiceContexts();
    setIsPlaying((p) => {
      if (p) setLoopingSubId(null);
      return !p;
    });
  };

  const handlePause = useCallback(() => {
    setLoopingSubId(null);
    setIsPlaying(false);
  }, []);

  const handlePlayFromTime = useCallback(
    (sec: number) => {
      if (!project || project.scenes.length === 0) return;
      resumeAllVoiceContexts();
      setLoopingSubId(null);
      setCutTime(sec);
      setSeekNonce((n) => n + 1);
      setIsPlaying(true);
    },
    [project]
  );

  const handleToggleLoopSubtitle = useCallback(
    (id: string) => {
      if (!project || project.scenes.length === 0) return;
      const targetSub = project.subtitles.find((s) => s.id === id);
      if (!targetSub) return;

      if (loopingSubIdRef.current === id && isPlaying) {
        setLoopingSubId(null);
        setIsPlaying(false);
        return;
      }

      resumeAllVoiceContexts();
      lastLoopSeekAtRef.current = performance.now();
      setLoopingSubId(id);
      setCutTime(targetSub.startTime);
      setSeekNonce((n) => n + 1);
      setIsPlaying(true);
    },
    [project, isPlaying]
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
          Math.abs(b.endSec - nextScenes[idx].endSec) > 0.05
      );
    setTimelineDirty(dirty);
  }, []);

  const handleUpdateProjectScenes = useCallback(
    (nextScenesRaw: SpeakingScene[]) => {
      const nextScenes = ensureSceneIds(nextScenesRaw);
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
    [checkTimelineDirty]
  );

  const handleRestoreProjectSnapshot = useCallback(
    (scenesRaw: SpeakingScene[], subtitlesOverride?: SubtitleItem[]) => {
      const nextScenes = ensureSceneIds(scenesRaw);
      const nextDuration = Number(
        nextScenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0).toFixed(2)
      );
      checkTimelineDirty(nextScenes);

      setProject((prev) => {
        if (!prev) return prev;
        const nextSubtitles = subtitlesOverride
          ? subtitlesOverride.map((sub) => ({
              ...sub,
              words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
            }))
          : remapSubtitlesToScenes(
              timelineBaselineRef.current?.subtitles ?? prev.subtitles,
              nextScenes
            );
        return {
          ...prev,
          scenes: nextScenes,
          targetDurationSec: nextDuration,
          subtitles: nextSubtitles,
        };
      });
    },
    [checkTimelineDirty]
  );

  const handleResetTimeline = useCallback(() => {
    const base = timelineBaselineRef.current;
    if (!base) return;
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
  }, []);

  const buildWordsFromPhonetic = (
    phonetic: string,
    spanStart: number,
    spanEnd: number,
    existingWords: SubtitleWord[] = []
  ): SubtitleWord[] => {
    const tokens = phonetic.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const spanDur = Math.max(0.2, spanEnd - spanStart);
    const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0) || 1;
    let cursor = spanStart;
    return tokens.map((tok, wi) => {
      const existing = existingWords[wi];
      const wDur = (Math.max(2, tok.length) / totalWeight) * spanDur;
      const startOffsetSec = Number(cursor.toFixed(2));
      const endOffsetSec = Number(
        (wi === tokens.length - 1 ? spanEnd : cursor + wDur).toFixed(2)
      );
      cursor = endOffsetSec;
      return {
        phonetic: tok,
        thai: existing?.thai || tok,
        burmeseGloss: existing?.burmeseGloss || "",
        startOffsetSec,
        endOffsetSec,
      };
    });
  };

  const handleUpdateSubtitle = (
    id: string,
    field: "thaiPhonetic" | "burmese" | "thaiScript",
    value: string
  ) => {
    pushSubtitleUndo(`sub:${id}:${field}`);
    const applyEdit = (list: SubtitleItem[]): SubtitleItem[] =>
      list.map((sub: SubtitleItem) => {
        if (sub.id !== id) return sub;
        if (field === "burmese") return { ...sub, burmese: value };
        if (field === "thaiScript") return { ...sub, thaiScript: value };

        const tokens = value.split(/\s+/).filter(Boolean);
        if (tokens.length === sub.words.length && sub.words.length > 0) {
          const words = tokens.map((tok, wi) => ({
            ...sub.words[wi],
            phonetic: tok,
          }));
          return { ...sub, thaiPhonetic: value, words };
        }

        const spanStart = sub.words[0]?.startOffsetSec ?? 0;
        const spanEnd = sub.words[sub.words.length - 1]?.endOffsetSec ?? (sub.endTime - sub.startTime);
        const words = buildWordsFromPhonetic(value, spanStart, spanEnd, sub.words);
        return { ...sub, thaiPhonetic: value, words };
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
        return { ...sub, words };
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

  const handleAddSubtitle = (input: {
    startTime: number;
    endTime: number;
    thaiPhonetic: string;
    burmese: string;
    originalSpokenText?: string;
  }) => {
    if (!project) return;
    pushSubtitleUndo();
    const maxDur = Math.max(0.5, project.targetDurationSec || 10);
    const startTime = Number(Math.max(0, Math.min(maxDur - 0.2, input.startTime)).toFixed(2));
    const endTime = Number(Math.max(startTime + 0.2, Math.min(maxDur, input.endTime)).toFixed(2));
    const duration = Math.max(0.2, endTime - startTime);
    const thaiPhonetic = input.thaiPhonetic.trim();
    const burmese = input.burmese.trim();
    const mappedStart = mapCutTimeToSource(project.scenes, startTime);
    const mappedEnd = mapCutTimeToSource(project.scenes, endTime);

    const newItem: SubtitleItem = {
      id: `sub-custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sceneIndex: mappedStart.sceneIndex,
      startTime,
      endTime,
      sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
      sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
      originalSpokenText: input.originalSpokenText?.trim() || "Custom subtitle",
      thaiPhonetic,
      thaiScript: thaiPhonetic,
      burmese,
      words: buildWordsFromPhonetic(thaiPhonetic, 0, duration),
    };

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
        subtitles: [...prev.subtitles, newItem].sort((a, b) => a.startTime - b.startTime),
      };
    });
    handleSeek(startTime);
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

  const handleFindReplaceSubtitles = (opts: {
    findText: string;
    replaceText: string;
    field: "all" | "burmese" | "thaiPhonetic" | "thaiScript";
    caseSensitive?: boolean;
  }): number => {
    if (!project || !opts.findText) return 0;
    const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = opts.caseSensitive ? "g" : "gi";
    const regex = new RegExp(escapeRegExp(opts.findText), flags);
    let totalMatches = 0;

    const replaceInText = (src: string): string => {
      if (!src) return src;
      const matches = src.match(regex);
      if (matches && matches.length > 0) {
        totalMatches += matches.length;
        return src.replace(regex, opts.replaceText);
      }
      return src;
    };

    const replaceSilent = (src: string): string => (src ? src.replace(regex, opts.replaceText) : src);

    const transformList = (list: SubtitleItem[], countMatches: boolean): SubtitleItem[] =>
      list.map((sub) => {
        const fn = countMatches ? replaceInText : replaceSilent;
        const nextPhonetic =
          opts.field === "all" || opts.field === "thaiPhonetic" ? fn(sub.thaiPhonetic) : sub.thaiPhonetic;
        const nextThai =
          opts.field === "all" || opts.field === "thaiScript" ? fn(sub.thaiScript) : sub.thaiScript;
        const nextBurmese =
          opts.field === "all" || opts.field === "burmese" ? fn(sub.burmese) : sub.burmese;
        const nextWords = sub.words.map((w) => ({
          ...w,
          phonetic:
            opts.field === "all" || opts.field === "thaiPhonetic"
              ? replaceSilent(w.phonetic)
              : w.phonetic,
          burmeseGloss:
            opts.field === "all" || opts.field === "burmese"
              ? w.burmeseGloss
                ? replaceSilent(w.burmeseGloss)
                : w.burmeseGloss
              : w.burmeseGloss,
        }));
        return {
          ...sub,
          thaiPhonetic: nextPhonetic,
          thaiScript: nextThai,
          burmese: nextBurmese,
          words: nextWords,
        };
      });

    const nextSubs = transformList(project.subtitles, true);
    if (totalMatches === 0) return 0;

    pushSubtitleUndo();
    if (timelineBaselineRef.current) {
      timelineBaselineRef.current.subtitles = transformList(
        timelineBaselineRef.current.subtitles,
        false
      );
    }
    setProject((prev) => (prev ? { ...prev, subtitles: nextSubs } : prev));
    return totalMatches;
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
          return {
            ...sub,
            sceneIndex: mappedStart.sceneIndex,
            startTime,
            endTime,
            sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
            sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
            words,
          };
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
          return {
            ...sub,
            sceneIndex: mappedStart.sceneIndex,
            startTime: nextStart,
            endTime: nextEnd,
            sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
            sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
          };
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

      const curCut = cutTimeRef.current;
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

      const firstItem: SubtitleItem = {
        ...target,
        endTime: splitTime,
        sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
        sourceEndSec: Number(mappedSplit.sourceSec.toFixed(2)),
        originalSpokenText: spoken1,
        thaiScript: thaiScript1,
        thaiPhonetic: phonetic1,
        burmese: burmese1,
        words: words1,
      };
      const secondItem: SubtitleItem = {
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
      };

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
      const offsetShift = Math.max(0, nxt.startTime - mergedStart);

      const mergedWords: SubtitleWord[] = [
        ...cur.words.map((w) => ({ ...w })),
        ...nxt.words.map((w) => ({
          ...w,
          startOffsetSec: Number((w.startOffsetSec + offsetShift).toFixed(2)),
          endOffsetSec: Number((w.endOffsetSec + offsetShift).toFixed(2)),
        })),
      ];

      const mappedStart = mapCutTimeToSource(project.scenes, mergedStart);
      const mappedEnd = mapCutTimeToSource(project.scenes, mergedEnd);

      const mergedItem: SubtitleItem = {
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
      };

      const next = [...list];
      next.splice(idx, 2, mergedItem);
      return next;
    };

    if (loopingSubIdRef.current) setLoopingSubId(null);

    const mergeIdx = project.subtitles.findIndex((s) => s.id === id);
    if (mergeIdx !== -1 && mergeIdx + 1 < project.subtitles.length) {
      pushSubtitleUndo();
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
      const resp = await fetch("/api/regenerate-subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sourceType: project.sourceType,
          videoId: project.videoId,
          uploadId: resolvedUploadId,
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
        err instanceof Error ? err.message : "Failed to regenerate subtitle with AI."
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
  }, []);

  const handleRetranslateAll = async (tone: TranslationTone) => {
    if (!project || project.subtitles.length === 0 || isRetranslatingAll) return;
    retranslateAbortRef.current?.abort();
    const controller = new AbortController();
    retranslateAbortRef.current = controller;

    setSubtitleRegenError(null);
    setIsRetranslatingAll(true);

    try {
      const resp = await fetch("/api/retranslate-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          translationTone: tone,
          subtitles: project.subtitles.map((s) => ({
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

      const byId = new Map(data.subtitles.map((item) => [item.id, item]));
      const applyBatch = (list: SubtitleItem[]): SubtitleItem[] =>
        list.map((sub) => {
          const patch = byId.get(sub.id);
          if (!patch) return sub;
          return {
            ...sub,
            thaiScript: patch.thaiScript || sub.thaiScript,
            thaiPhonetic: patch.thaiPhonetic || sub.thaiPhonetic,
            burmese: patch.burmese || sub.burmese,
            words: Array.isArray(patch.words) && patch.words.length > 0 ? patch.words : sub.words,
          };
        });

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
        err instanceof Error ? err.message : "Failed to re-translate subtitles."
      );
    } finally {
      if (retranslateAbortRef.current === controller) {
        retranslateAbortRef.current = null;
      }
      setIsRetranslatingAll(false);
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

        return {
          ...sub,
          sceneIndex: mappedStart.sceneIndex,
          startTime,
          endTime,
          sourceStartSec: Number(mappedStart.sourceSec.toFixed(2)),
          sourceEndSec: Number(mappedEnd.sourceSec.toFixed(2)),
          words,
        };
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

      if (project.sourceType === "local" && !uploadId && localFile) {
        uploadId = await uploadBlobInChunks(
          localFile,
          localFile.name,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        setProject((prev) => (prev ? { ...prev, uploadId } : prev));
      }

      const payloadBody = (activeUploadId?: string) =>
        JSON.stringify({
          sourceType: project.sourceType,
          videoId: project.videoId,
          uploadId: activeUploadId,
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

      if (resp.status === 404 && project.sourceType === "local" && localFile) {
        uploadId = await uploadBlobInChunks(
          localFile,
          localFile.name,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setLocalMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        setProject((prev) => (prev ? { ...prev, uploadId } : prev));
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
        err instanceof Error ? err.message : "Failed to auto-sync subtitle timings with AI."
      );
    } finally {
      if (resyncAbortRef.current === controller) {
        resyncAbortRef.current = null;
      }
      setIsResyncingTimings(false);
    }
  };

  const handleDownloadMp4 = async () => {
    if (!project || project.scenes.length === 0 || exportProgress) return;
    setIsPlaying(false);
    setProcessError(null);

    try {
      const blob = await exportProjectToMp4(
        project,
        darkMode,
        voiceSettings,
        videoEdit,
        setExportProgress
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = project.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 36);
      a.download = `${safeName || "thai-burmese"}-9x16.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to export MP4.");
    } finally {
      setExportProgress(null);
    }
  };

  const canSaveCurrent = Boolean(project || (localMedia && selectedScenes.length > 0));

  const handleSaveProject = useCallback(
    async (asNew = false) => {
      if (!canSaveCurrent || isSavingProject) return;
      setIsSavingProject(true);
      setProcessError(null);
      setSaveNotice(null);

      try {
        const mediaForSave =
          project?.sourceType === "youtube" ? youtubeMedia : (localMedia ?? youtubeMedia);

        const snapshotProject: VideoProject | null =
          project ??
          (mediaForSave
            ? {
                sourceType: mediaForSave.sourceType,
                videoId: mediaForSave.videoId,
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
                scenes: selectedScenes.map((sc, i) => ({
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
        });

        setActiveSavedId(record.id);
        setSavedProjects((prev) => [
          record,
          ...prev.filter((item) => item.id !== record.id),
        ]);
        setJustSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000);

        if (!blobSaved && snapshotProject.sourceType === "local") {
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
      youtubeMedia,
      selectedScenes,
      activeSavedId,
      voiceSettings,
      videoEdit,
    ]
  );

  // Support Ctrl+S / Cmd+S to save offline and Ctrl+Z / Ctrl+Shift+Z for subtitle Undo/Redo
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (canSaveCurrent) {
          handleSaveProject(false);
        }
        return;
      }

      if (activeTab === "script" && projectRef.current) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const inTextField =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
        if (inTextField) return;

        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          handleUndoSubtitles();
        } else if ((key === "z" && e.shiftKey) || key === "y") {
          e.preventDefault();
          handleRedoSubtitles();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, canSaveCurrent, handleSaveProject, handleUndoSubtitles, handleRedoSubtitles]);

  const handleOpenSavedProject = async (record: SavedProjectRecord) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setSeekNonce((n) => n + 1);
    setProcessError(null);
    setSaveNotice(null);

    let localFile: File | undefined;
    let localUrl: string | undefined;

    if (record.sourceType === "local") {
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
            "Subtitles and settings restored. Link the original local video file in the Saved tab to preview or export video."
          );
        }
      } catch {
        setSaveNotice("Could not load cached local video file from browser storage.");
      }
    }

    setActiveSavedId(record.id);
    setSelectedScenes(record.selectedScenes.map((s) => ({ ...s })));
    setVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, ...record.voiceSettings });
    setVideoEdit({ ...DEFAULT_VIDEO_EDIT, ...record.editSettings });
    const openedMedia: ActiveMediaSource = {
      sourceType: record.sourceType,
      videoId: record.videoId,
      localUrl,
      localFile,
      title: record.title,
      channel: record.channel,
      durationSec: record.sourceDurationSec,
      thumbnail: record.thumbnail,
    };
    if (record.sourceType === "local") {
      setLocalMedia(openedMedia);
    } else {
      setLocalMedia(null);
      setYoutubeMedia(openedMedia);
    }
    const openedProj: VideoProject = {
      sourceType: record.sourceType,
      videoId: record.videoId,
      localUrl,
      localFile,
      title: record.title,
      channel: record.channel,
      sourceDurationSec: record.sourceDurationSec,
      targetDurationSec: record.targetDurationSec,
      scenes: ensureSceneIds(
        (Array.isArray(record.scenes) ? record.scenes : []).map((s) => ({ ...s }))
      ),
      subtitles: (Array.isArray(record.subtitles) ? record.subtitles : []).map((sub) => ({
        ...sub,
        words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
      })),
      keyframeUrls: Array.isArray(record.keyframeUrls) ? [...record.keyframeUrls] : [],
    };
    setProject(openedProj);
    setBaselineFromProject(openedProj);

    if (record.subtitles.length > 0) {
      setActiveTab("script");
    } else if (record.sourceType === "local" && localUrl) {
      setActiveTab("scenes");
    } else if (record.sourceType === "youtube") {
      setYtPreviewSec(0);
      setYtSeekRequest(null);
      setActiveTab("ytPreview");
    } else {
      setActiveTab("scenes");
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
        if (updated.sourceType === "local") {
          setLocalMedia((prev) => (prev ? { ...prev, title: updated.title } : prev));
        } else {
          setYoutubeMedia((prev) => (prev ? { ...prev, title: updated.title } : prev));
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

  return (
    <div
      className={`${
        activeTab === "edit" || activeTab === "script"
          ? "h-[100dvh] overflow-hidden"
          : "min-h-screen lg:h-screen"
      } flex flex-col bg-white text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50 transition-colors duration-150`}
    >
      {/* Minimal 3-Zone Top Bar */}
      <header className="h-14 px-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-4 sm:gap-8 shrink-0">
        {/* Zone 1: Brand Wordmark */}
        <span className="text-base font-bold tracking-tight whitespace-nowrap shrink-0">
          9:16 Studio
        </span>

        {/* Zone 2: Direct Search & Local Video Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setActiveTab("videos");
            runSearch(searchInput, licenseFilter, thaiOnly);
          }}
          className="flex-1 max-w-xl flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search any YouTube video or paste URL..."
              aria-label="Search YouTube videos"
              className="w-full h-9 pl-9 pr-8 text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white transition-colors"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  setActiveTab("videos");
                  runSearch("", licenseFilter, thaiOnly);
                }}
                aria-label="Clear search and show recommended"
                className="w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-950 dark:hover:text-white absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUploadLocalVideo(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload local video"
            aria-label="Upload local video"
            className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Upload</span>
          </button>
        </form>

        {/* Zone 3: Theme Switch, Save Offline & Primary Download Action */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label={darkMode ? "Switch to Light mode" : "Switch to Dark mode"}
            className="w-9 h-9 rounded-lg border border-neutral-200 dark:border-neutral-800 flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors cursor-pointer shrink-0"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => handleSaveProject(false)}
            disabled={!canSaveCurrent || isSavingProject}
            title="Save project offline (Ctrl+S)"
            aria-label="Save project offline"
            className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {isSavingProject ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : justSaved ? (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>Saved</span>
              </>
            ) : (
              <>
                <Bookmark className="w-3.5 h-3.5" />
                <span>{activeSavedId ? "Update" : "Save"}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadMp4}
            disabled={!project || project.scenes.length === 0 || isProcessing || Boolean(exportProgress)}
            className="h-9 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity cursor-pointer"
          >
            {exportProgress ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="font-mono-tabular">
                  {exportProgress.phase === "muxing"
                    ? "Muxing..."
                    : `${exportProgress.percent}%`}
                </span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Download MP4</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      {(() => {
        const showStage =
          activeTab !== "videos" && activeTab !== "ytPreview" && activeTab !== "scenes";
        const isStageFocus = activeTab === "edit" || activeTab === "script";
        const renderInlineStageInSidebar = showStage && isStageFocus && !isDesktop;
        const desktopSidebarCols = !showStage
          ? "lg:col-span-12"
          : isStageFocus && stagePreviewSize === "big"
            ? "lg:col-span-6"
            : isStageFocus && stagePreviewSize === "compact"
              ? "lg:col-span-8"
              : "lg:col-span-7";
        const desktopStageCols =
          isStageFocus && stagePreviewSize === "big"
            ? "lg:col-span-6"
            : isStageFocus && stagePreviewSize === "compact"
              ? "lg:col-span-4"
              : "lg:col-span-5";

        const stageNode = showStage ? (
          <Stage9x16
            project={project}
            cutTime={cutTime}
            seekNonce={seekNonce}
            isPlaying={isPlaying}
            muted={muted}
            voiceSettings={voiceSettings}
            editSettings={videoEdit}
            onTogglePlay={handleTogglePlay}
            onPlayingChange={setIsPlaying}
            onSeek={handleSeek}
            onTimeUpdate={handlePlayerTimeUpdate}
            onEnded={handlePlaybackEnded}
            onToggleMute={() => setMuted((m) => !m)}
            compactMobile={isStageFocus}
            previewSize={isStageFocus ? stagePreviewSize : "normal"}
            onChangePreviewSize={isStageFocus ? setStagePreviewSize : undefined}
          />
        ) : null;

        return (
          <main
            className={`flex-1 min-h-0 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-4 ${
              isStageFocus
                ? "flex flex-col lg:grid lg:grid-cols-12 gap-3 lg:gap-6 overflow-hidden"
                : "grid grid-cols-1 lg:grid-cols-12 gap-6"
            }`}
          >
            {/* Left / Full: Video Picker, YouTube Preview, Watch & Custom Scene Selection, Subtitles, Voice, and Saved Projects */}
            <section
              className={`${desktopSidebarCols} ${
                isStageFocus ? "flex-1 min-h-0" : "min-h-0"
              } flex flex-col`}
            >
          {processError && (
            <div className="mb-3 px-3.5 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 text-xs text-neutral-900 dark:text-neutral-100 shrink-0">
              {processError}
            </div>
          )}

          {saveNotice && (
            <div className="mb-3 px-3.5 py-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-2 text-xs text-neutral-700 dark:text-neutral-300 shrink-0">
              <span>{saveNotice}</span>
              <button
                type="button"
                onClick={() => setSaveNotice(null)}
                className="text-[11px] font-medium underline shrink-0 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          <WorkspaceSidebar
            activeTab={activeTab}
            onTabChange={(tab) => {
              if (tab === "videos" || tab === "ytPreview") setIsPlaying(false);
              setActiveTab(tab);
            }}
            videos={videos}
            selectedVideoId={youtubeMedia?.videoId}
            activeQuery={activeQuery}
            licenseFilter={licenseFilter}
            thaiOnly={thaiOnly}
            hasMoreVideos={Boolean(nextContinuation)}
            isLoadingMore={isLoadingMore}
            localMedia={localMedia}
            youtubeMedia={youtubeMedia}
            selectedScenes={selectedScenes}
            voiceSettings={voiceSettings}
            editSettings={videoEdit}
            isSearching={isSearching}
            isProcessing={isProcessing}
            isPlaying={isPlaying}
            timelineDirty={timelineDirty}
            searchError={searchError}
            project={project}
            cutTime={cutTime}
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
            onUpdateScene={handleUpdateScene}
            onRemoveScene={handleRemoveScene}
            onReplaceScenes={setSelectedScenes}
            onDetectedLocalDuration={(dur) =>
              setLocalMedia((prev) => (prev ? { ...prev, durationSec: dur } : prev))
            }
            onDetectedYouTubeDuration={(dur) =>
              setYoutubeMedia((prev) => (prev ? { ...prev, durationSec: dur } : prev))
            }
            onGenerateSubtitles={handleGenerateSubtitles}
            onCancelGenerateSubtitles={handleCancelGenerateSubtitles}
            onChangeVoiceSettings={setVoiceSettings}
            onChangeEditSettings={setVideoEdit}
            onUploadLocalVideo={handleUploadLocalVideo}
            onClearLocalVideo={handleClearLocalVideo}
            onSeek={handleSeek}
            onTogglePlay={handleTogglePlay}
            onPause={handlePause}
            onPlayFromTime={handlePlayFromTime}
            onUpdateProjectScenes={handleUpdateProjectScenes}
            onRestoreProjectSnapshot={handleRestoreProjectSnapshot}
            onResetTimeline={handleResetTimeline}
            onUpdateSubtitle={handleUpdateSubtitle}
            onUpdateWordGloss={handleUpdateWordGloss}
            onFindReplaceSubtitles={handleFindReplaceSubtitles}
            onAddSubtitle={handleAddSubtitle}
            onDeleteSubtitle={handleDeleteSubtitle}
            onUpdateSubtitleTiming={handleUpdateSubtitleTiming}
            onSplitSubtitle={handleSplitSubtitle}
            onMergeSubtitleWithNext={handleMergeSubtitleWithNext}
            onShiftAllSubtitles={handleShiftAllSubtitles}
            loopingSubId={loopingSubId}
            onToggleLoopSubtitle={handleToggleLoopSubtitle}
            canUndoSubtitles={subUndoStack.length > 0}
            canRedoSubtitles={subRedoStack.length > 0}
            onUndoSubtitles={handleUndoSubtitles}
            onRedoSubtitles={handleRedoSubtitles}
            onAutoFixSubtitleTimings={handleAutoFixSubtitleTimings}
            onAiResyncSubtitles={handleAiResyncSubtitles}
            onCancelAiResync={handleCancelAiResync}
            isResyncingTimings={isResyncingTimings}
            onRegenerateSubtitle={handleRegenerateSubtitle}
            onCancelRegenerateSubtitle={handleCancelRegenerateSubtitle}
            onRetranslateAll={handleRetranslateAll}
            onCancelRetranslateAll={handleCancelRetranslateAll}
            regeneratingSubIds={regeneratingSubIds}
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
          />
        </section>

        {/* Right: Focused 9:16 Stage */}
        {showStage && !renderInlineStageInSidebar && (
          <section className={`${desktopStageCols} flex items-center justify-center min-h-0`}>
            {stageNode}
          </section>
        )}
      </main>
        );
      })()}
    </div>
  );
}
