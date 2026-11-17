import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import type { ActiveMediaSource, SceneSelection, VideoEditSettings, VoiceSettings } from "../types";
import { applyVoiceEffectsToVideoElement, resumeAllVoiceContexts } from "../utils/webAudioVoice";
import { buildCssFilterString, buildCssTransformString } from "../utils/videoFilters";

interface YTPreviewPlayer {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setPlaybackRate?: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
}

let ytPreviewApiPromise: Promise<void> | null = null;
function ensureYouTubeAPI(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytPreviewApiPromise) return ytPreviewApiPromise;

  ytPreviewApiPromise = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) prev();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    document.head.appendChild(tag);
  });
  return ytPreviewApiPromise;
}

function parseTimeInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  const parts = s.split(":").map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

interface ScenePickerProps {
  media: ActiveMediaSource;
  scenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  isProcessing: boolean;
  onAddScene: (startSec: number, endSec: number) => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onGenerate: () => void;
  onDetectedDuration?: (dur: number) => void;
}

export function ScenePicker({
  media,
  scenes,
  voiceSettings,
  editSettings,
  isProcessing,
  onAddScene,
  onUpdateScene,
  onRemoveScene,
  onGenerate,
  onDetectedDuration,
}: ScenePickerProps) {
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YTPreviewPlayer | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  const [currentSec, setCurrentSec] = useState(0);
  const [startInput, setStartInput] = useState("0");
  const [endInput, setEndInput] = useState("15");
  const [copiedLink, setCopiedLink] = useState(false);

  const youtubeUrl =
    media.sourceType === "youtube" && media.videoId
      ? `https://www.youtube.com/watch?v=${media.videoId}`
      : "";

  const handleCopyLink = async () => {
    if (!youtubeUrl) return;
    try {
      await navigator.clipboard.writeText(youtubeUrl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = youtubeUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Mount interactive YouTube player with full native controls so user can watch freely
  useEffect(() => {
    if (media.sourceType !== "youtube" || !media.videoId || !ytHostRef.current) return;

    let cancelled = false;
    const mountEl = document.createElement("div");
    mountEl.className = "w-full h-full";
    ytHostRef.current.innerHTML = "";
    ytHostRef.current.appendChild(mountEl);

    ensureYouTubeAPI().then(() => {
      if (cancelled || !window.YT?.Player) return;
      const p = new window.YT.Player(mountEl, {
        videoId: media.videoId!,
        playerVars: {
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            const d = e.target.getDuration?.();
            if (d && Number.isFinite(d) && d > 0) {
              onDetectedDuration?.(Math.round(d));
            }
          },
        },
      }) as unknown as YTPreviewPlayer;
      ytPlayerRef.current = p;
    });

    const interval = setInterval(() => {
      try {
        const t = ytPlayerRef.current?.getCurrentTime?.();
        if (typeof t === "number" && Number.isFinite(t)) {
          setCurrentSec(Math.floor(t));
        }
      } catch {
        // ignore
      }
    }, 300);

    return () => {
      cancelled = true;
      clearInterval(interval);
      try {
        ytPlayerRef.current?.destroy();
      } catch {
        // ignore
      }
      ytPlayerRef.current = null;
    };
  }, [media.sourceType, media.videoId]);

  useEffect(() => {
    const vid = localVideoRef.current;
    if (media.sourceType === "local" && vid) {
      vid.preservesPitch = true;
      (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
      vid.playbackRate = voiceSettings.speed;
      applyVoiceEffectsToVideoElement(vid, voiceSettings, !vid.paused);
    } else if (media.sourceType === "youtube" && ytPlayerRef.current) {
      try {
        const clamped = Math.max(0.75, Math.min(1.4, voiceSettings.speed || 1));
        const rates = [0.75, 1, 1.25, 1.5];
        const nearest = rates.reduce((a, b) =>
          Math.abs(b - clamped) < Math.abs(a - clamped) ? b : a
        );
        ytPlayerRef.current.setPlaybackRate?.(nearest);
      } catch {
        // ignore
      }
    }
  }, [media.sourceType, voiceSettings]);

  const seekSourceTo = (sec: number) => {
    if (media.sourceType === "local" && localVideoRef.current) {
      localVideoRef.current.currentTime = sec;
      localVideoRef.current.play().catch(() => {});
    } else if (ytPlayerRef.current) {
      try {
        ytPlayerRef.current.seekTo(sec, true);
      } catch {
        // ignore
      }
    }
  };

  const handleSetIn = () => {
    const s = Math.max(0, currentSec);
    setStartInput(String(s));
    const parsedEnd = parseTimeInput(endInput);
    if (parsedEnd === null || parsedEnd <= s) {
      setEndInput(String(Math.min(media.durationSec || s + 15, s + 15)));
    }
  };

  const handleSetOut = () => {
    const e = Math.max(1, currentSec);
    setEndInput(String(e));
    const parsedStart = parseTimeInput(startInput);
    if (parsedStart === null || parsedStart >= e) {
      setStartInput(String(Math.max(0, e - 15)));
    }
  };

  const handleAddClick = () => {
    const s = parseTimeInput(startInput);
    const e = parseTimeInput(endInput);
    if (s === null || e === null || e <= s) return;
    onAddScene(s, e);
    const nextStart = Math.round(e);
    setStartInput(String(nextStart));
    setEndInput(String(Math.min(media.durationSec || nextStart + 15, nextStart + 15)));
  };

  const totalSelectedSec = scenes.reduce(
    (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
    0
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Interactive Video Preview Player */}
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-neutral-950 border border-neutral-200 dark:border-neutral-800">
        {media.sourceType === "local" && media.localUrl ? (
          <video
            ref={localVideoRef}
            src={media.localUrl}
            controls
            playsInline
            onPlay={(e) => {
              resumeAllVoiceContexts();
              e.currentTarget.preservesPitch = true;
              e.currentTarget.playbackRate = voiceSettings.speed;
              applyVoiceEffectsToVideoElement(e.currentTarget, voiceSettings, true);
            }}
            onTimeUpdate={(e) => setCurrentSec(Math.floor(e.currentTarget.currentTime))}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (d && Number.isFinite(d)) onDetectedDuration?.(Math.round(d));
            }}
            style={{
              transform: buildCssTransformString(editSettings),
              filter: buildCssFilterString(editSettings),
            }}
            className="w-full h-full object-contain bg-black origin-center transition-transform duration-75"
          />
        ) : (
          <div
            ref={ytHostRef}
            className="w-full h-full origin-center transition-transform duration-75"
            style={{
              transform: buildCssTransformString(editSettings),
              filter: buildCssFilterString(editSettings),
            }}
          />
        )}
        {editSettings.vignette > 0 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(circle, transparent 42%, rgba(0,0,0,${(
                (editSettings.vignette / 100) * 0.85
              ).toFixed(2)}) 100%)`,
            }}
          />
        )}
      </div>

      {/* YouTube Title & Copy Link Bar */}
      {youtubeUrl && (
        <div className="px-3.5 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-neutral-900 dark:text-neutral-100 truncate">
              {media.title}
            </p>
            <p className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400 truncate">
              {youtubeUrl}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCopyLink}
            className={`h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors border ${
              copiedLink
                ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
            }`}
          >
            {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedLink ? "Copied" : "Copy Link"}</span>
          </button>
        </div>
      )}

      {/* Mark / Add Custom Scene Controls */}
      <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400 whitespace-nowrap mr-1">
          {formatClock(currentSec)} ({currentSec}s)
        </span>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleSetIn}
            className="h-8 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium whitespace-nowrap cursor-pointer transition-colors"
          >
            Set In
          </button>
          <input
            type="text"
            value={startInput}
            onChange={(e) => setStartInput(e.target.value)}
            aria-label="Start seconds"
            placeholder="0"
            className="w-16 h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-xs font-mono-tabular text-center focus:outline-none focus:border-neutral-950 dark:focus:border-white"
          />
        </div>

        <span className="text-xs text-neutral-400">–</span>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleSetOut}
            className="h-8 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium whitespace-nowrap cursor-pointer transition-colors"
          >
            Set Out
          </button>
          <input
            type="text"
            value={endInput}
            onChange={(e) => setEndInput(e.target.value)}
            aria-label="End seconds"
            placeholder="15"
            className="w-16 h-8 px-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-xs font-mono-tabular text-center focus:outline-none focus:border-neutral-950 dark:focus:border-white"
          />
        </div>

        <button
          type="button"
          onClick={handleAddClick}
          className="h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1 whitespace-nowrap hover:opacity-90 transition-opacity cursor-pointer ml-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Scene</span>
        </button>
      </div>

      {/* Selected Multiple Scenes List */}
      <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
        {scenes.length === 0 ? (
          <div className="p-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            Watch the video above and add one or more scenes by seconds
          </div>
        ) : (
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {scenes.map((sc, idx) => {
              const dur = Math.max(0, Math.round((sc.endSec - sc.startSec) * 10) / 10);
              return (
                <div
                  key={sc.id}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-3 bg-white dark:bg-neutral-950"
                >
                  <button
                    type="button"
                    onClick={() => seekSourceTo(sc.startSec)}
                    className="text-xs font-mono-tabular font-medium text-neutral-900 dark:text-neutral-100 hover:underline cursor-pointer shrink-0"
                  >
                    Scene {idx + 1}
                  </button>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={sc.startSec}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val) && val >= 0) {
                          onUpdateScene(sc.id, val, Math.max(val + 1, sc.endSec));
                        }
                      }}
                      aria-label={`Scene ${idx + 1} start seconds`}
                      className="w-16 h-7 px-2 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-xs font-mono-tabular text-center"
                    />
                    <span className="text-xs text-neutral-400">s –</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={sc.endSec}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val) && val > sc.startSec) {
                          onUpdateScene(sc.id, sc.startSec, val);
                        }
                      }}
                      aria-label={`Scene ${idx + 1} end seconds`}
                      className="w-16 h-7 px-2 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-xs font-mono-tabular text-center"
                    />
                    <span className="text-xs text-neutral-400">s</span>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400">
                      {dur}s
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveScene(sc.id)}
                      aria-label={`Remove scene ${idx + 1}`}
                      className="p-1 text-neutral-400 hover:text-neutral-950 dark:hover:text-white transition-colors cursor-pointer"
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

      {/* Generate Subtitles Action Bar */}
      <div className="flex items-center justify-between gap-4 pt-1">
        <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400">
          {scenes.length} {scenes.length === 1 ? "scene" : "scenes"} · {Math.round(totalSelectedSec)}s
        </span>

        <button
          type="button"
          onClick={onGenerate}
          disabled={scenes.length === 0 || isProcessing}
          className="h-9 px-5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-2 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity cursor-pointer"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Generating...</span>
            </>
          ) : (
            <span>Generate Subtitles</span>
          )}
        </button>
      </div>
    </div>
  );
}
