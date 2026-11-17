import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Moon, Search, Sun, Upload } from "lucide-react";
import type {
  ActiveMediaSource,
  SceneSelection,
  SubtitleItem,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeVideo,
} from "./types";
import { Stage9x16 } from "./components/Stage9x16";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { exportProjectToMp4, type ExportProgress } from "./utils/exportVideo";
import { DEFAULT_VOICE_SETTINGS, getEffectivePlaybackSpeed } from "./utils/voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./utils/videoFilters";
import { resumeAllVoiceContexts } from "./utils/webAudioVoice";

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("theme") === "dark";
  });

  const [searchInput, setSearchInput] = useState("thai 3d animation cartoon");
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"videos" | "scenes" | "edit" | "script" | "voice">(
    "videos"
  );
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRunIdRef = useRef(0);

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

  const runSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    setSearchError(null);
    try {
      const resp = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Search failed");
      setVideos(data.videos || []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Failed to load videos.");
    } finally {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    runSearch("thai 3d animation cartoon");
  }, [runSearch]);

  // Clicking a YouTube video opens it in Watch & Scenes first without auto-generating
  const handleSelectVideo = (video: YouTubeVideo) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);
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
    setProject(null);
    setSelectedScenes([]);

    const localUrl = URL.createObjectURL(file);
    const durationSec = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(Math.round(v.duration) || 120);
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
    setActiveTab("scenes");
  };

  // Uploading inside Voice Changer skips Watch & Scenes and puts video straight onto the 9:16 Stage Preview
  const handleUploadVoiceVideo = async (file: File) => {
    activeRunIdRef.current++;
    setIsPlaying(false);
    setCutTime(0);
    setProcessError(null);

    const localUrl = URL.createObjectURL(file);
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
        const resp = await fetch("/api/upload-video", {
          method: "POST",
          headers: {
            "Content-Type": activeMedia.localFile.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(activeMedia.title),
            "x-video-duration": String(activeMedia.durationSec),
            "x-selected-scenes": JSON.stringify(scenePayload),
          },
          body: activeMedia.localFile,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        setProject({
          ...(data as VideoProject),
          sourceType: "local",
          localUrl: activeMedia.localUrl,
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
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Processing failed");
        if (activeRunIdRef.current !== runId) return;

        setProject(data as VideoProject);
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

  // Master 60fps clock for 9:16 Stage playback, scaled by voiceSettings.speed
  useEffect(() => {
    if (!isPlaying || !project) return;
    let rafId = 0;
    let lastTs = performance.now();
    const maxDur = project.targetDurationSec || 10;
    const speed = getEffectivePlaybackSpeed(project.sourceType, voiceSettings.speed);

    const tick = (now: number) => {
      const dt = ((now - lastTs) / 1000) * speed;
      lastTs = now;
      setCutTime((prev) => {
        const next = prev + dt;
        if (next >= maxDur) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, project, voiceSettings.speed]);

  const handleSeek = (sec: number) => {
    setCutTime(sec);
  };

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
          const dur = sub.endTime - sub.startTime;
          const totalWeight = tokens.reduce((acc, t) => acc + Math.max(2, t.length), 0) || 1;
          let cursor = 0;
          const words = tokens.map((tok, wi) => {
            const existing = sub.words[wi];
            const wDur = (Math.max(2, tok.length) / totalWeight) * dur;
            const startOffsetSec = Number(cursor.toFixed(2));
            const endOffsetSec = Number(
              (wi === tokens.length - 1 ? dur : cursor + wDur).toFixed(2)
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
            runSearch(searchInput);
          }}
          className="flex-1 max-w-xl flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search YouTube video or paste URL..."
              aria-label="Search YouTube videos"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white transition-colors"
            />
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

        {/* Zone 3: Theme Switch & Primary Download Action */}
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

      {/* Main 2-Column Workspace */}
      <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Video Picker, Watch & Custom Scene Selection, Subtitles, and Voice Changer */}
        <section className="lg:col-span-7 min-h-0 flex flex-col">
          {processError && (
            <div className="mb-3 px-3.5 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 text-xs text-neutral-900 dark:text-neutral-100 shrink-0">
              {processError}
            </div>
          )}

          <WorkspaceSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            videos={videos}
            selectedVideoId={activeMedia?.videoId}
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
            onSelectVideo={handleSelectVideo}
            onAddScene={handleAddScene}
            onUpdateScene={handleUpdateScene}
            onRemoveScene={handleRemoveScene}
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
          />
        </section>

        {/* Right: Focused 9:16 Stage */}
        <section className="lg:col-span-5 flex items-center justify-center min-h-0">
          <Stage9x16
            project={project}
            cutTime={cutTime}
            isPlaying={isPlaying}
            muted={muted}
            voiceSettings={voiceSettings}
            editSettings={videoEdit}
            onTogglePlay={handleTogglePlay}
            onSeek={handleSeek}
            onToggleMute={() => setMuted((m) => !m)}
          />
        </section>
      </main>
    </div>
  );
}
