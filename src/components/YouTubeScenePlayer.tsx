import { useEffect, useRef } from "react";
import type { SpeakingScene, VideoEditSettings, VoiceSettings } from "../types";
import { applyVoiceEffectsToVideoElement, resumeAllVoiceContexts } from "../utils/webAudioVoice";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { buildCssFilterString, buildCssTransformString } from "../utils/videoFilters";

interface YTPlayerInstance {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  mute: () => void;
  unMute: () => void;
  setPlaybackRate?: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (e: { target: YTPlayerInstance }) => void;
            onStateChange?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayerInstance;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<void> | null = null;
function loadYouTubeIframeAPI(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<void>((resolve) => {
    const existing = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (existing) existing();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

export function mapCutTimeToSource(
  scenes: SpeakingScene[],
  cutTime: number
): { sceneIndex: number; sourceSec: number } {
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (cutTime <= acc + s.durationSec || i === scenes.length - 1) {
      const offset = Math.max(0, cutTime - acc);
      return {
        sceneIndex: i,
        sourceSec: Math.min(s.endSec, s.startSec + offset),
      };
    }
    acc += s.durationSec;
  }
  return { sceneIndex: 0, sourceSec: 0 };
}

interface YouTubeScenePlayerProps {
  sourceType: "youtube" | "local";
  videoId?: string;
  localUrl?: string;
  scenes: SpeakingScene[];
  cutTime: number;
  isPlaying: boolean;
  muted: boolean;
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  fallbackThumbnail?: string;
}

export function YouTubeScenePlayer({
  sourceType,
  videoId,
  localUrl,
  scenes,
  cutTime,
  isPlaying,
  muted,
  voiceSettings,
  editSettings,
  fallbackThumbnail,
}: YouTubeScenePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSceneRef = useRef<number>(-1);
  const readyRef = useRef<boolean>(false);
  const youtubeSpeedRef = useRef<number>(
    getEffectivePlaybackSpeed("youtube", voiceSettings.speed)
  );
  youtubeSpeedRef.current = getEffectivePlaybackSpeed("youtube", voiceSettings.speed);

  // Mount YouTube IFrame player when videoId changes
  useEffect(() => {
    if (sourceType !== "youtube" || !videoId || !containerRef.current) return;

    let cancelled = false;
    readyRef.current = false;
    lastSceneRef.current = -1;

    const mountHost = document.createElement("div");
    mountHost.className = "w-full h-full";
    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(mountHost);

    loadYouTubeIframeAPI().then(() => {
      if (cancelled || !window.YT?.Player) return;
      const initial = mapCutTimeToSource(scenes, cutTime);
      const player = new window.YT.Player(mountHost, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          start: Math.floor(initial.sourceSec),
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            readyRef.current = true;
            if (muted) e.target.mute();
            else e.target.unMute();
            e.target.setPlaybackRate?.(youtubeSpeedRef.current);
            if (isPlaying) e.target.playVideo();
          },
          onStateChange: (e) => {
            if (cancelled || !playerRef.current) return;
            if (e.data === 1) {
              playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);
            }
          },
        },
      });
      playerRef.current = player;
    });

    return () => {
      cancelled = true;
      readyRef.current = false;
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [sourceType, videoId]);

  // Sync play/pause, mute & speed for YouTube
  useEffect(() => {
    if (sourceType !== "youtube" || !readyRef.current || !playerRef.current) return;
    try {
      if (muted) playerRef.current.mute();
      else playerRef.current.unMute();

      playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);

      if (isPlaying) playerRef.current.playVideo();
      else playerRef.current.pauseVideo();
    } catch {
      // ignore
    }
  }, [sourceType, isPlaying, muted, voiceSettings.speed]);

  // Sync cut timeline jumps onto YouTube player
  useEffect(() => {
    if (sourceType !== "youtube" || !readyRef.current || !playerRef.current) return;
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenes, cutTime);
    try {
      const ytTime = playerRef.current.getCurrentTime?.() ?? sourceSec;
      const sceneChanged = lastSceneRef.current !== sceneIndex;
      const drifted = Math.abs(ytTime - sourceSec) > 1.4;
      if (sceneChanged || drifted) {
        lastSceneRef.current = sceneIndex;
        playerRef.current.seekTo(sourceSec, true);
      }
    } catch {
      // ignore
    }
  }, [sourceType, cutTime, scenes]);

  // Sync local HTML5 video playback, speed & real-time Web Audio Voice Changer
  useEffect(() => {
    const vid = localVideoRef.current;
    if (sourceType !== "local" || !vid) return;
    vid.muted = muted;
    vid.preservesPitch = true;
    (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    vid.playbackRate = voiceSettings.speed;
    applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);

    if (isPlaying && vid.paused) {
      vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [sourceType, isPlaying, muted, voiceSettings]);

  useEffect(() => {
    const vid = localVideoRef.current;
    if (sourceType !== "local" || !vid) return;
    const { sourceSec } = mapCutTimeToSource(scenes, cutTime);
    if (Math.abs(vid.currentTime - sourceSec) > 0.45) {
      vid.currentTime = sourceSec;
    }
  }, [sourceType, cutTime, scenes]);

  const transformCss = buildCssTransformString(editSettings);
  const filterCss = buildCssFilterString(editSettings);
  const vignetteOpacity = Math.max(0, Math.min(1, editSettings.vignette / 100));

  if (sourceType === "local" && localUrl) {
    return (
      <div className="relative w-full h-full overflow-hidden bg-neutral-950">
        <video
          ref={localVideoRef}
          src={localUrl}
          playsInline
          muted={muted}
          onPlay={(e) => {
            resumeAllVoiceContexts();
            applyVoiceEffectsToVideoElement(e.currentTarget, voiceSettings, true);
          }}
          style={{
            transform: transformCss,
            filter: filterCss,
          }}
          className={`w-full h-full bg-neutral-950 origin-center transition-transform duration-75 ${
            editSettings.fitMode === "contain" ? "object-contain" : "object-cover"
          }`}
        />
        {vignetteOpacity > 0 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(circle, transparent 42%, rgba(0,0,0,${(
                vignetteOpacity * 0.85
              ).toFixed(2)}) 100%)`,
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-hidden bg-neutral-950">
      <div
        className="w-full h-full origin-center transition-transform duration-75"
        style={{
          transform: transformCss,
          filter: filterCss,
        }}
      >
        {fallbackThumbnail && (
          <img
            src={fallbackThumbnail}
            alt=""
            referrerPolicy="no-referrer"
            className={`absolute inset-0 w-full h-full opacity-50 pointer-events-none ${
              editSettings.fitMode === "contain" ? "object-contain" : "object-cover"
            }`}
          />
        )}
        <div
          ref={containerRef}
          className={`relative w-full h-full pointer-events-none ${
            editSettings.fitMode === "cover" ? "scale-[1.06]" : "scale-100"
          }`}
        />
      </div>
      {vignetteOpacity > 0 && (
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(circle, transparent 42%, rgba(0,0,0,${(
              vignetteOpacity * 0.85
            ).toFixed(2)}) 100%)`,
          }}
        />
      )}
    </div>
  );
}
