import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Check, Download, Loader2, Moon, Search, Sun, Upload, X } from "lucide-react";
import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
  SubtitleItem,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "./types";
import { Stage9x16 } from "./components/Stage9x16";
import { WorkspaceSidebar, type WorkspaceTab } from "./components/WorkspaceSidebar";
import { exportProjectToMp4, type ExportProgress } from "./utils/exportVideo";
import { DEFAULT_VOICE_SETTINGS } from "./utils/voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./utils/videoFilters";
import { resumeAllVoiceContexts } from "./utils/webAudioVoice";
import { safeReadJson, uploadBlobInChunks } from "./utils/uploadFile";
import {
  attachLocalVideoToSavedProject,
  deleteSavedProject,
  exportProjectAsJson,
  getSavedProjectBlob,
  importProjectFromJsonText,
  listSavedProjects,
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
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [nextContinuation, setNextContinuation] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("videos");
  const [activeMedia, setActiveMedia] = useState<ActiveMediaSource | null>(null);
  const [selectedScenes, setSelectedScenes] = useState<SceneSelection[]>([]);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    ...DEFAULT_VOICE_SETTINGS,
  });
  const [videoEdit, setVideoEdit] = useState<VideoEditSettings>({
    ...DEFAULT_VIDEO_EDIT,
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRunIdRef = useRef(0);
  const searchSeqRef = useRef(0);
  const createdUrlsRef = useRef<string[]>([]);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      continuation?: string | null
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
        });
        if (continuation) {
          params.set("continuation", continuation);
        }

        const resp = await fetch(`/api/youtube/search?${params.toString()}`);
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
    runSearch("", "all");
  }, [runSearch]);

  const handleChangeLicenseFilter = useCallback(
    (nextLicense: YouTubeLicenseFilter) => {
      setLicenseFilter(nextLicense);
      runSearch(activeQuery, nextLicense);
    },
    [activeQuery, runSearch]
  );

  const handleLoadMoreVideos = useCallback(() => {
    if (!nextContinuation || isSearching || isLoadingMore) return;
    runSearch(activeQuery, licenseFilter, nextContinuation);
  }, [activeQuery, licenseFilter, nextContinuation, isSearching, isLoadingMore, runSearch]);

  const handleResetToRecommended = useCallback(() => {
    setSearchInput("");
    runSearch("", licenseFilter);
  }, [licenseFilter, runSearch]);

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

  // Clicking a YouTube video opens it in Watch & Scenes first without auto-generating
  const handleSelectVideo = (video: YouTubeVideo) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);
    setProject(null);
    setSelectedScenes([]);
    setActiveMedia({
      sourceType: "youtube",
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      durationSec: video.durationSec,
      thumbnail: video.thumbnail,
    });
    setActiveTab("scenes");
  };

  // Uploading a local video opens it in Watch & Scenes first without auto-generating
  const handleUploadLocalVideo = async (file: File) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);
    setProject(null);
    setSelectedScenes([]);

    const localUrl = registerBlobUrl(file);
    const durationSec = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () =>
        resolve(Math.max(0.5, Math.round((v.duration || 120) * 10) / 10));
      v.onerror = () => resolve(120);
      v.src = localUrl;
    });

    setActiveMedia({
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

  // Uploading inside Voice Changer skips Watch & Scenes and puts video straight onto the 9:16 Stage Preview
  const handleUploadVoiceVideo = async (file: File) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
    setSaveNotice(null);
    setActiveSavedId(null);

    const localUrl = registerBlobUrl(file);
    const durationSec = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(Math.max(1, Math.round(v.duration) || 30));
      v.onerror = () => resolve(30);
      v.src = localUrl;
    });

    const cleanTitle = file.name.replace(/\.[^.]+$/, "");
    setActiveMedia({
      sourceType: "local",
      localUrl,
      localFile: file,
      title: cleanTitle,
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
    setProject({
      sourceType: "local",
      localUrl,
      localFile: file,
      title: cleanTitle,
      channel: "Local Video",
      sourceDurationSec: durationSec,
      targetDurationSec: durationSec,
      scenes: [
        {
          index: 0,
          startSec: 0,
          endSec: durationSec,
          durationSec,
          summary: "Full video",
        },
      ],
      subtitles: [],
      keyframeUrls: [],
    });
    setActiveTab("voice");
  };

  const handleAddScene = (startSec: number, endSec: number) => {
    setSelectedScenes((prev) => [
      ...prev,
      {
        id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        startSec,
        endSec,
      },
    ]);
  };

  const handleUpdateScene = (id: string, startSec: number, endSec: number) => {
    setSelectedScenes((prev) =>
      prev.map((sc) => (sc.id === id ? { ...sc, startSec, endSec } : sc))
    );
  };

  const handleRemoveScene = (id: string) => {
    setSelectedScenes((prev) => prev.filter((sc) => sc.id !== id));
  };

  // Triggered explicitly by the user after watching and selecting their scenes
  const handleGenerateSubtitles = async () => {
    if (!activeMedia || selectedScenes.length === 0) return;

    const runId = ++activeRunIdRef.current;
    setIsPlaying(false);
    setCutTime(0);
    setIsProcessing(true);
    setProcessError(null);

    try {
      const scenePayload = selectedScenes.map(({ startSec, endSec }) => ({
        startSec,
        endSec,
      }));

      if (activeMedia.sourceType === "local" && activeMedia.localFile) {
        let uploadId = activeMedia.uploadId;
        if (!uploadId) {
          uploadId = await uploadBlobInChunks(
            activeMedia.localFile,
            activeMedia.localFile.name
          );
          if (activeRunIdRef.current !== runId) return;
          setActiveMedia((prev) => (prev ? { ...prev, uploadId } : prev));
        }

        let resp = await fetch("/api/process-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId,
            title: activeMedia.title,
            durationSec: activeMedia.durationSec,
            selectedScenes: scenePayload,
          }),
        });

        // If server restarted and tmp upload expired, re-upload once transparently
        if (resp.status === 404) {
          uploadId = await uploadBlobInChunks(
            activeMedia.localFile,
            activeMedia.localFile.name
          );
          if (activeRunIdRef.current !== runId) return;
          setActiveMedia((prev) => (prev ? { ...prev, uploadId } : prev));
          resp = await fetch("/api/process-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadId,
              title: activeMedia.title,
              durationSec: activeMedia.durationSec,
              selectedScenes: scenePayload,
            }),
          });
        }

        const data = await safeReadJson<VideoProject & { error?: string }>(resp);
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        setProject({
          ...data,
          sourceType: "local",
          localUrl: activeMedia.localUrl,
          localFile: activeMedia.localFile,
        });
        setActiveTab("script");
      } else if (activeMedia.sourceType === "youtube" && activeMedia.videoId) {
        const resp = await fetch("/api/process-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: activeMedia.videoId,
            title: activeMedia.title,
            channel: activeMedia.channel,
            durationSec: activeMedia.durationSec,
            selectedScenes: scenePayload,
          }),
        });
        const data = await safeReadJson<VideoProject & { error?: string }>(resp);
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        setProject(data);
        setActiveTab("script");
      }
    } catch (err) {
      if (activeRunIdRef.current === runId) {
        setProcessError(err instanceof Error ? err.message : "Failed to transcribe scenes.");
      }
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsProcessing(false);
      }
    }
  };

  const handleSeek = (sec: number) => {
    setCutTime(sec);
    setSeekNonce((n) => n + 1);
  };

  const handlePlayerTimeUpdate = useCallback((newCutTime: number) => {
    setCutTime(newCutTime);
  }, []);

  const handlePlaybackEnded = useCallback(() => {
    setIsPlaying(false);
    setCutTime(0);
    setSeekNonce((n) => n + 1);
  }, []);

  const handleTogglePlay = () => {
    if (!project) return;
    resumeAllVoiceContexts();
    setIsPlaying((p) => !p);
  };

  const handleUpdateSubtitle = (
    id: string,
    field: "thaiPhonetic" | "burmese",
    value: string
  ) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        subtitles: prev.subtitles.map((sub: SubtitleItem) => {
          if (sub.id !== id) return sub;
          if (field === "burmese") return { ...sub, burmese: value };

          const tokens = value.split(/\s+/).filter(Boolean);
          // Preserve exact aligned word timings when the word count matches
          if (tokens.length === sub.words.length && sub.words.length > 0) {
            const words = tokens.map((tok, wi) => ({
              ...sub.words[wi],
              phonetic: tok,
            }));
            return { ...sub, thaiPhonetic: value, words };
          }

          const spanStart = sub.words[0]?.startOffsetSec ?? 0;
          const spanEnd = sub.words[sub.words.length - 1]?.endOffsetSec ?? (sub.endTime - sub.startTime);
          const spanDur = Math.max(0.2, spanEnd - spanStart);
          const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0) || 1;
          let cursor = spanStart;
          const words = tokens.map((tok, wi) => {
            const existing = sub.words[wi];
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
          return { ...sub, thaiPhonetic: value, words };
        }),
      };
    });
  };

  const handleDownloadMp4 = async () => {
    if (!project || exportProgress) return;
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

  const canSaveCurrent = Boolean(project || (activeMedia && selectedScenes.length > 0));

  const handleSaveProject = useCallback(
    async (asNew = false) => {
      if (!canSaveCurrent || isSavingProject) return;
      setIsSavingProject(true);
      setProcessError(null);
      setSaveNotice(null);

      try {
        const snapshotProject: VideoProject | null =
          project ??
          (activeMedia
            ? {
                sourceType: activeMedia.sourceType,
                videoId: activeMedia.videoId,
                localUrl: activeMedia.localUrl,
                localFile: activeMedia.localFile,
                uploadId: activeMedia.uploadId,
                title: activeMedia.title,
                channel: activeMedia.channel,
                sourceDurationSec: activeMedia.durationSec,
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
                keyframeUrls: activeMedia.thumbnail ? [activeMedia.thumbnail] : [],
              }
            : null);

        if (!snapshotProject) return;

        const { record, blobSaved } = await saveOfflineProject({
          existingId: asNew ? null : activeSavedId,
          project: snapshotProject,
          activeMedia,
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
      activeMedia,
      selectedScenes,
      activeSavedId,
      voiceSettings,
      videoEdit,
    ]
  );

  // Support Ctrl+S / Cmd+S shortcut to save offline
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canSaveCurrent) {
          handleSaveProject(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSaveCurrent, handleSaveProject]);

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
          localFile = new File([blobEntry.blob], blobEntry.fileName, {
            type: blobEntry.fileType,
          });
          localUrl = registerBlobUrl(localFile);
        } else {
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
    setActiveMedia({
      sourceType: record.sourceType,
      videoId: record.videoId,
      localUrl,
      localFile,
      title: record.title,
      channel: record.channel,
      durationSec: record.sourceDurationSec,
      thumbnail: record.thumbnail,
    });
    setProject({
      sourceType: record.sourceType,
      videoId: record.videoId,
      localUrl,
      localFile,
      title: record.title,
      channel: record.channel,
      sourceDurationSec: record.sourceDurationSec,
      targetDurationSec: record.targetDurationSec,
      scenes: record.scenes.map((s) => ({ ...s })),
      subtitles: record.subtitles.map((sub) => ({
        ...sub,
        words: sub.words.map((w) => ({ ...w })),
      })),
      keyframeUrls: [...record.keyframeUrls],
    });

    if (record.subtitles.length > 0) {
      setActiveTab("script");
    } else if (record.sourceType === "local" && localUrl) {
      setActiveTab("voice");
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
        setActiveMedia((prev) => (prev ? { ...prev, title: updated.title } : prev));
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

  const handleRelinkLocalVideo = async (id: string, file: File) => {
    setProcessError(null);
    setSaveNotice(null);
    try {
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
        setActiveMedia((prev) =>
          prev ? { ...prev, localUrl, localFile: file, thumbnail: record.thumbnail || prev.thumbnail } : prev
        );
        setProject((prev) => (prev ? { ...prev, localUrl, localFile: file } : prev));
      }
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : "Failed to link local video.");
    }
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-white text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50 transition-colors duration-150">
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
            runSearch(searchInput, licenseFilter);
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
                  runSearch("", licenseFilter);
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
            disabled={!project || isProcessing || Boolean(exportProgress)}
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
        const showStage = activeTab !== "videos";
        return (
          <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left / Full: Video Picker, Watch & Custom Scene Selection, Subtitles, Voice, and Saved Projects */}
            <section
              className={`${
                showStage ? "lg:col-span-7" : "lg:col-span-12"
              } min-h-0 flex flex-col`}
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
              if (tab === "videos") setIsPlaying(false);
              setActiveTab(tab);
            }}
            videos={videos}
            selectedVideoId={activeMedia?.videoId}
            activeQuery={activeQuery}
            licenseFilter={licenseFilter}
            hasMoreVideos={Boolean(nextContinuation)}
            isLoadingMore={isLoadingMore}
            activeMedia={activeMedia}
            selectedScenes={selectedScenes}
            voiceSettings={voiceSettings}
            editSettings={videoEdit}
            isSearching={isSearching}
            isProcessing={isProcessing}
            isExporting={Boolean(exportProgress)}
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
            onLoadMoreVideos={handleLoadMoreVideos}
            onResetToRecommended={handleResetToRecommended}
            onAddScene={handleAddScene}
            onUpdateScene={handleUpdateScene}
            onRemoveScene={handleRemoveScene}
            onReplaceScenes={setSelectedScenes}
            onDetectedDuration={(dur) =>
              setActiveMedia((prev) => (prev ? { ...prev, durationSec: dur } : prev))
            }
            onGenerateSubtitles={handleGenerateSubtitles}
            onChangeVoiceSettings={setVoiceSettings}
            onChangeEditSettings={setVideoEdit}
            onUploadVoiceVideo={handleUploadVoiceVideo}
            onDownloadMp4={handleDownloadMp4}
            onSeek={handleSeek}
            onUpdateSubtitle={handleUpdateSubtitle}
            onSaveProject={handleSaveProject}
            onOpenSavedProject={handleOpenSavedProject}
            onRenameSavedProject={handleRenameSavedProject}
            onDeleteSavedProject={handleDeleteSavedProject}
            onExportSavedJson={handleExportSavedJson}
            onImportSavedJson={handleImportSavedJson}
            onRelinkLocalVideo={handleRelinkLocalVideo}
          />
        </section>

        {/* Right: Focused 9:16 Stage (hidden while browsing Videos tab) */}
        {showStage && (
          <section className="lg:col-span-5 flex items-center justify-center min-h-0">
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
            />
          </section>
        )}
      </main>
        );
      })()}
    </div>
  );
}
