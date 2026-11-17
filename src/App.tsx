import { useEffect, useRef, useState } from "react";
import { Download, FileText, Moon, Sun, Upload, Video } from "lucide-react";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "./types";
import { Stage9x16 } from "./components/Stage9x16";
import { VideoEditPanel } from "./components/VideoEditPanel";
import { VoiceChangerPanel } from "./components/VoiceChangerPanel";
import { exportProjectToMp4, type ExportProgress } from "./utils/exportVideo";
import { DEFAULT_VOICE_SETTINGS } from "./utils/voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./utils/videoFilters";
import { resumeAllVoiceContexts } from "./utils/webAudioVoice";

interface EmbeddedSubtitleTrack {
  index: number;
  language: string;
  title: string;
}

function parseTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  const seconds = Number(parts.pop() || 0);
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseSubtitleFile(source: string): SubtitleItem[] {
  const content = source.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocks = content.split(/\n\s*\n/);
  const items: SubtitleItem[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex < 0) continue;

    const times = lines[timeLineIndex].split("-->");
    if (times.length !== 2) continue;
    const startMatch = times[0].match(/(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3}/);
    const endMatch = times[1].match(/(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3}/);
    if (!startMatch || !endMatch) continue;

    const startTime = parseTimestamp(startMatch[0]);
    const endTime = parseTimestamp(endMatch[0]);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) continue;

    const text = lines.slice(timeLineIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .trim();
    if (!text) continue;

    const tokens = text.match(/\S+/gu) || [text];
    const totalWeight = tokens.reduce((sum, token) => sum + Math.max(1, token.length), 0);
    let cursor = 0;
    const duration = endTime - startTime;
    const words = tokens.map((token, index) => {
      const weight = Math.max(1, token.length);
      const from = cursor;
      const to = index === tokens.length - 1 ? duration : cursor + (duration * weight) / totalWeight;
      cursor = to;
      return {
        phonetic: token,
        thai: token,
        burmeseGloss: "",
        startOffsetSec: Number(from.toFixed(3)),
        endOffsetSec: Number(to.toFixed(3)),
      };
    });

    items.push({
      id: "subtitle-" + (items.length + 1),
      sceneIndex: 0,
      startTime,
      endTime,
      sourceStartSec: startTime,
      sourceEndSec: endTime,
      originalSpokenText: text,
      thaiPhonetic: text,
      thaiScript: text,
      burmese: "",
      words,
    });
  }

  return items.sort((a, b) => a.startTime - b.startTime);
}

async function readJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error("Server returned a non-JSON response. Make sure the Studio backend is running.");
  }
}

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => localStorage.getItem("theme") === "dark");
  const [project, setProject] = useState<VideoProject | null>(null);
  const [activeTab, setActiveTab] = useState<"subtitles" | "edit" | "voice">("subtitles");
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({ ...DEFAULT_VOICE_SETTINGS });
  const [videoEdit, setVideoEdit] = useState<VideoEditSettings>({ ...DEFAULT_VIDEO_EDIT });
  const [embeddedTracks, setEmbeddedTracks] = useState<EmbeddedSubtitleTrack[]>([]);
  const [selectedTrack, setSelectedTrack] = useState("");
  const [subtitleFileName, setSubtitleFileName] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [cutTime, setCutTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const applySubtitles = (subtitles: SubtitleItem[], fileName: string) => {
    setSubtitleFileName(fileName);
    setProject((current) => current ? { ...current, subtitles } : current);
    setCutTime(0);
    setProcessError(subtitles.length ? null : "No valid subtitle cues were found in this file.");
  };

  const uploadVideo = async (file: File) => {
    setIsProcessing(true);
    setProcessError(null);
    setEmbeddedTracks([]);
    setSelectedTrack("");
    setSubtitleFileName("");
    setIsPlaying(false);
    setCutTime(0);

    const localUrl = URL.createObjectURL(file);
    const durationSec = await new Promise<number>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => resolve(Math.max(1, Math.round(video.duration) || 1));
      video.onerror = () => resolve(30);
      video.src = localUrl;
    });

    const baseProject: VideoProject = {
      sourceType: "local",
      localUrl,
      localFile: file,
      title: file.name.replace(/\.[^.]+$/, ""),
      channel: "Uploaded Video",
      sourceDurationSec: durationSec,
      targetDurationSec: durationSec,
      scenes: [{ index: 0, startSec: 0, endSec: durationSec, durationSec, summary: "Full video" }],
      subtitles: [],
      keyframeUrls: [],
    };

    try {
      const uploadResponse = await fetch("/api/upload-raw", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const uploadData = await readJson(uploadResponse);
      if (!uploadResponse.ok) throw new Error(uploadData.error || "Video upload failed.");
      baseProject.uploadId = uploadData.uploadId;

      const tracksResponse = await fetch("/api/subtitle-tracks/" + encodeURIComponent(String(uploadData.uploadId)));
      const tracksData = await readJson(tracksResponse);
      if (tracksResponse.ok) setEmbeddedTracks(Array.isArray(tracksData.tracks) ? tracksData.tracks : []);
    } catch (error) {
      setProcessError(error instanceof Error ? error.message : "Could not inspect embedded subtitles.");
    }

    setProject(baseProject);
    setActiveTab("subtitles");
    setIsProcessing(false);
  };

  const handleSubtitleFile = async (file: File) => {
    try {
      const parsed = parseSubtitleFile(await file.text());
      applySubtitles(parsed, file.name);
    } catch (error) {
      setProcessError(error instanceof Error ? error.message : "Could not read subtitle file.");
    }
  };

  const extractEmbeddedTrack = async () => {
    if (!project?.uploadId || !selectedTrack) return;
    setIsProcessing(true);
    setProcessError(null);
    try {
      const response = await fetch("/api/extract-subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: project.uploadId, streamIndex: Number(selectedTrack) }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "Could not extract the selected subtitle track.");
      const parsed = parseSubtitleFile(String(data.subtitleText || ""));
      if (!parsed.length) throw new Error("The selected embedded track did not contain readable subtitle cues.");
      applySubtitles(parsed, data.trackTitle || "Embedded subtitle");
    } catch (error) {
      setProcessError(error instanceof Error ? error.message : "Embedded subtitle extraction failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (!isPlaying || !project) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setCutTime((current) => {
        const next = current + delta * voiceSettings.speed;
        if (next >= project.targetDurationSec) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, project, voiceSettings.speed]);

  const downloadMp4 = async () => {
    if (!project || exportProgress) return;
    setIsPlaying(false);
    setProcessError(null);
    try {
      const blob = await exportProjectToMp4(project, darkMode, voiceSettings, videoEdit, setExportProgress);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = (project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "studio-video") + "-9x16.mp4";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProcessError(error instanceof Error ? error.message : "Video export failed.");
    } finally {
      setExportProgress(null);
    }
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-white text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <header className="min-h-14 px-4 sm:px-6 py-2 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-bold whitespace-nowrap">
          <Video className="w-4 h-4" />
          <span>9:16 Studio</span>
        </div>
        <div className="flex items-center gap-2">
          <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadVideo(file);
            event.currentTarget.value = "";
          }} />
          <button type="button" onClick={() => videoInputRef.current?.click()} className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-semibold flex items-center gap-2">
            <Upload className="w-3.5 h-3.5" /> Upload Video
          </button>
          <button type="button" onClick={() => setDarkMode((value) => !value)} aria-label="Toggle theme" className="w-9 h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 flex items-center justify-center">
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button type="button" onClick={downloadMp4} disabled={!project || Boolean(exportProgress)} className="h-9 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 disabled:opacity-40">
            <Download className="w-3.5 h-3.5" />
            {exportProgress ? exportProgress.percent + "%" : "Export MP4"}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-4 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 min-h-0 flex flex-col gap-4">
          {processError && <div role="alert" className="p-3 rounded-lg border border-red-300 text-sm text-red-700 dark:text-red-300">{processError}</div>}
          {isProcessing && <div className="p-3 rounded-lg bg-neutral-100 dark:bg-neutral-900 text-sm">Processing upload or subtitle track…</div>}

          <div className="flex gap-2 border-b border-neutral-200 dark:border-neutral-800 pb-3">
            {(["subtitles", "edit", "voice"] as const).map((tab) => (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={"px-3 py-2 rounded-lg text-xs font-semibold capitalize " + (activeTab === tab ? "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950" : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900")}>
                {tab === "subtitles" ? "Subtitle" : tab === "edit" ? "Video Edit" : "Voice"}
              </button>
            ))}
          </div>

          {activeTab === "subtitles" && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 space-y-3">
                <div className="flex items-center gap-2 font-semibold text-sm"><FileText className="w-4 h-4" /> Subtitle Source</div>
                <p className="text-xs text-neutral-500">Use a subtitle track embedded in your video, or upload a separate .SRT / .VTT file. No AI transcription is used.</p>
                {project && embeddedTracks.length > 0 ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <select value={selectedTrack} onChange={(event) => setSelectedTrack(event.target.value)} className="h-10 flex-1 min-w-0 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 text-sm">
                      <option value="">Choose embedded subtitle track</option>
                      {embeddedTracks.map((track) => <option key={track.index} value={String(track.index)}>{track.language.toUpperCase()} — {track.title || ("Track " + track.index)}</option>)}
                    </select>
                    <button type="button" onClick={extractEmbeddedTrack} disabled={!selectedTrack || isProcessing} className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold disabled:opacity-40">Extract Track</button>
                  </div>
                ) : project ? (
                  <p className="text-xs text-neutral-500">No embedded subtitle tracks were detected in this video.</p>
                ) : (
                  <p className="text-xs text-neutral-500">Upload a video first to inspect embedded subtitle tracks.</p>
                )}
                <input ref={subtitleInputRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" className="hidden" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleSubtitleFile(file);
                  event.currentTarget.value = "";
                }} />
                <button type="button" onClick={() => subtitleInputRef.current?.click()} className="h-10 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 text-sm font-semibold flex items-center justify-center gap-2">
                  <Upload className="w-4 h-4" /> Upload Separate Subtitle File
                </button>
                {subtitleFileName && <p className="text-xs text-neutral-500">Loaded: {subtitleFileName} · {project?.subtitles.length || 0} cues</p>}
              </div>
              {project && (
                <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 space-y-2">
                  <p className="text-sm font-semibold">{project.title}</p>
                  <p className="text-xs text-neutral-500">{Math.floor(project.sourceDurationSec / 60)}:{String(project.sourceDurationSec % 60).padStart(2, "0")} · {project.subtitles.length} subtitle cues</p>
                  <button type="button" onClick={() => applySubtitles([], "")} className="text-xs text-neutral-500 underline">Clear subtitles</button>
                </div>
              )}
            </div>
          )}

          {activeTab === "edit" && <VideoEditPanel settings={videoEdit} onChange={setVideoEdit} />}
          {activeTab === "voice" && (
            <VoiceChangerPanel
              sourceType="local"
              localVideoTitle={project?.title}
              settings={voiceSettings}
              canDownload={Boolean(project)}
              isExporting={Boolean(exportProgress)}
              onChange={setVoiceSettings}
              onUploadVoiceVideo={(file) => void uploadVideo(file)}
              onDownloadMp4={downloadMp4}
            />
          )}
        </section>

        <section className="lg:col-span-5 flex items-center justify-center min-h-0">
          <Stage9x16
            project={project}
            cutTime={cutTime}
            isPlaying={isPlaying}
            muted={muted}
            voiceSettings={voiceSettings}
            editSettings={videoEdit}
            onTogglePlay={() => { if (project) { resumeAllVoiceContexts(); setIsPlaying((value) => !value); } }}
            onSeek={setCutTime}
            onToggleMute={() => setMuted((value) => !value)}
          />
        </section>
      </main>
    </div>
  );
}
