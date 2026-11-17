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
  getPlayerState?: () => number;
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

export function getSceneCutStart(scenes: SpeakingScene[], sceneIndex: number): number {
  let acc = 0;
  for (let i = 0; i < sceneIndex && i < scenes.length; i++) {
    acc += scenes[i].durationSec;
  }
  return acc;
}

export function mapCutTimeToSource(
  scenes: SpeakingScene[],
  cutTime: number
): { sceneIndex: number; sourceSec: number } {
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (cutTime < acc + s.durationSec - 0.001 || i === scenes.length - 1) {
      const offset = Math.max(0, Math.min(s.durationSec, cutTime - acc));
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
  seekNonce: number;
  isPlaying: boolean;
  muted: boolean;
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  fallbackThumbnail?: string;
  onTimeUpdate: (newCutTime: number) => void;
  onEnded: () => void;
}

export function YouTubeScenePlayer({
  sourceType,
  videoId,
  localUrl,
  scenes,
  cutTime,
  seekNonce,
  isPlaying,
  muted,
  voiceSettings,
  editSettings,
  fallbackThumbnail,
  onTimeUpdate,
  onEnded,
}: YouTubeScenePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const readyRef = useRef<boolean>(false);

  const activeSceneIdxRef = useRef<number>(0);
  const pendingLocalSeekRef = useRef<number | null>(null);
  const ytStateRef = useRef<number>(-1);
  const ytAnchorRef = useRef({
    rawYtTime: -1,
    sourceSec: 0,
    perfMs: 0,
    suppressUntilMs: 0,
  });

  // Always keep latest callbacks and settings accessible inside RAF loops
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const cutTimeRef = useRef(cutTime);
  cutTimeRef.current = cutTime;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const youtubeSpeedRef = useRef<number>(
    getEffectivePlaybackSpeed("youtube", editSettings.playbackSpeed, voiceSettings.speed)
  );
  youtubeSpeedRef.current = getEffectivePlaybackSpeed(
    "youtube",
    editSettings.playbackSpeed,
    voiceSettings.speed
  );

  // Mount YouTube IFrame player when videoId changes
  useEffect(() => {
    if (sourceType !== "youtube" || !videoId || !containerRef.current) return;

    let cancelled = false;
    readyRef.current = false;
    ytStateRef.current = -1;

    const mountHost = document.createElement("div");
    mountHost.className = "w-full h-full";
    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(mountHost);

    loadYouTubeIframeAPI().then(() => {
      if (cancelled || !window.YT?.Player) return;
      const initial = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
      activeSceneIdxRef.current = initial.sceneIndex;
      ytAnchorRef.current = {
        rawYtTime: -1,
        sourceSec: initial.sourceSec,
        perfMs: performance.now(),
        suppressUntilMs: performance.now() + 450,
      };

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
            if (mutedRef.current) e.target.mute();
            else e.target.unMute();
            e.target.setPlaybackRate?.(youtubeSpeedRef.current);
            const target = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
            activeSceneIdxRef.current = target.sceneIndex;
            e.target.seekTo(target.sourceSec, true);
            ytAnchorRef.current = {
              rawYtTime: -1,
              sourceSec: target.sourceSec,
              perfMs: performance.now(),
              suppressUntilMs: performance.now() + 450,
            };
            if (isPlayingRef.current) e.target.playVideo();
          },
          onStateChange: (e) => {
            if (cancelled || !playerRef.current) return;
            ytStateRef.current = e.data;
            if (e.data === 1) {
              playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);
              const ytT = playerRef.current.getCurrentTime?.();
              if (typeof ytT === "number" && Number.isFinite(ytT)) {
                ytAnchorRef.current.perfMs = performance.now();
                if (performance.now() >= ytAnchorRef.current.suppressUntilMs) {
                  ytAnchorRef.current.rawYtTime = ytT;
                  ytAnchorRef.current.sourceSec = ytT;
                }
              }
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

  // Reset initial position when source or scenes change
  useEffect(() => {
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenes, cutTimeRef.current);
    activeSceneIdxRef.current = sceneIndex;

    if (sourceType === "local") {
      const vid = localVideoRef.current;
      if (vid) {
        if (vid.readyState >= 1) {
          vid.currentTime = sourceSec;
          pendingLocalSeekRef.current = null;
        } else {
          pendingLocalSeekRef.current = sourceSec;
        }
      }
    } else if (sourceType === "youtube" && readyRef.current && playerRef.current) {
      try {
        playerRef.current.seekTo(sourceSec, true);
        ytAnchorRef.current = {
          rawYtTime: -1,
          sourceSec,
          perfMs: performance.now(),
          suppressUntilMs: performance.now() + 450,
        };
      } catch {
        // ignore
      }
    }
  }, [sourceType, localUrl, scenes]);

  // Explicit user seek (scrubber drag, clicking subtitle card, or clicking scene chip)
  useEffect(() => {
    if (seekNonce === 0) return;
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
    activeSceneIdxRef.current = sceneIndex;

    if (sourceType === "local") {
      const vid = localVideoRef.current;
      if (vid) {
        if (vid.readyState >= 1) {
          vid.currentTime = sourceSec;
          pendingLocalSeekRef.current = null;
        } else {
          pendingLocalSeekRef.current = sourceSec;
        }
      }
    } else if (sourceType === "youtube" && readyRef.current && playerRef.current) {
      try {
        playerRef.current.seekTo(sourceSec, true);
        ytAnchorRef.current = {
          rawYtTime: -1,
          sourceSec,
          perfMs: performance.now(),
          suppressUntilMs: performance.now() + 450,
        };
      } catch {
        // ignore
      }
    }
  }, [seekNonce, sourceType]);

  // Sync play/pause, mute & speed for YouTube
  useEffect(() => {
    if (sourceType !== "youtube" || !readyRef.current || !playerRef.current) return;
    try {
      if (muted) playerRef.current.mute();
      else playerRef.current.unMute();

      playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);

      if (isPlaying) {
        const { sceneIndex, sourceSec } = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
        activeSceneIdxRef.current = sceneIndex;
        const ytT = playerRef.current.getCurrentTime?.();
        if (typeof ytT !== "number" || Math.abs(ytT - sourceSec) > 0.35) {
          playerRef.current.seekTo(sourceSec, true);
          ytAnchorRef.current = {
            rawYtTime: -1,
            sourceSec,
            perfMs: performance.now(),
            suppressUntilMs: performance.now() + 450,
          };
        } else {
          ytAnchorRef.current.perfMs = performance.now();
        }
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
    } catch {
      // ignore
    }
  }, [sourceType, isPlaying, muted, voiceSettings.speed, editSettings.playbackSpeed]);

  // Master player-driven 60fps clock for YouTube (only advances when player state is PLAYING)
  useEffect(() => {
    if (sourceType !== "youtube" || !isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const player = playerRef.current;
      const curScenes = scenesRef.current;
      if (readyRef.current && player && curScenes.length > 0) {
        try {
          const state = player.getPlayerState?.() ?? ytStateRef.current;
          const now = performance.now();
          if (state === 1) {
            const ytTime = player.getCurrentTime?.();
            const anchor = ytAnchorRef.current;

            if (now < anchor.suppressUntilMs) {
              if (
                typeof ytTime === "number" &&
                Number.isFinite(ytTime) &&
                Math.abs(ytTime - anchor.sourceSec) < 0.65
              ) {
                anchor.suppressUntilMs = 0;
                anchor.rawYtTime = ytTime;
                anchor.sourceSec = ytTime;
                anchor.perfMs = now;
              } else {
                anchor.perfMs = now;
              }
            } else if (typeof ytTime === "number" && Number.isFinite(ytTime)) {
              if (ytTime !== anchor.rawYtTime) {
                anchor.rawYtTime = ytTime;
                anchor.sourceSec = ytTime;
                anchor.perfMs = now;
              }
            }

            const elapsed = Math.min(0.35, Math.max(0, (now - anchor.perfMs) / 1000));
            const estSourceSec = anchor.sourceSec + elapsed * youtubeSpeedRef.current;

            const idx = Math.min(activeSceneIdxRef.current, curScenes.length - 1);
            const sc = curScenes[idx];

            if (anchor.rawYtTime >= 0 && now >= anchor.suppressUntilMs && estSourceSec < sc.startSec - 0.8) {
              player.seekTo(sc.startSec, true);
              anchor.rawYtTime = -1;
              anchor.sourceSec = sc.startSec;
              anchor.perfMs = now;
              anchor.suppressUntilMs = now + 450;
            } else if (estSourceSec >= sc.endSec - 0.04) {
              if (idx + 1 < curScenes.length) {
                const nextIdx = idx + 1;
                const nextSc = curScenes[nextIdx];
                activeSceneIdxRef.current = nextIdx;
                player.seekTo(nextSc.startSec, true);
                ytAnchorRef.current = {
                  rawYtTime: -1,
                  sourceSec: nextSc.startSec,
                  perfMs: now,
                  suppressUntilMs: now + 500,
                };
                onTimeUpdateRef.current(getSceneCutStart(curScenes, nextIdx));
              } else {
                player.pauseVideo();
                onEndedRef.current();
                return;
              }
            } else {
              const localOffset = Math.max(0, Math.min(sc.durationSec, estSourceSec - sc.startSec));
              onTimeUpdateRef.current(getSceneCutStart(curScenes, idx) + localOffset);
            }
          } else {
            ytAnchorRef.current.perfMs = now;
          }
        } catch {
          // ignore transient iframe errors
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceType, isPlaying]);

  // Sync local HTML5 video playback, speed & real-time Web Audio Voice Changer
  useEffect(() => {
    const vid = localVideoRef.current;
    if (sourceType !== "local" || !vid) return;
    vid.muted = muted;
    vid.preservesPitch = true;
    (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    vid.playbackRate = getEffectivePlaybackSpeed(
      "local",
      editSettings.playbackSpeed,
      voiceSettings.speed
    );
    applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);

    if (isPlaying && vid.paused) {
      vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [sourceType, isPlaying, muted, voiceSettings, editSettings.playbackSpeed]);

  // Master player-driven 60fps clock for Local <video> (directly tracks vid.currentTime)
  useEffect(() => {
    if (sourceType !== "local" || !isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const vid = localVideoRef.current;
      const curScenes = scenesRef.current;
      if (vid && curScenes.length > 0 && !vid.paused && !vid.seeking && vid.readyState >= 2) {
        const idx = Math.min(activeSceneIdxRef.current, curScenes.length - 1);
        const sc = curScenes[idx];
        const srcT = vid.currentTime;

        if (srcT < sc.startSec - 0.25) {
          vid.currentTime = sc.startSec;
        } else if (srcT >= sc.endSec - 0.02) {
          if (idx + 1 < curScenes.length) {
            const nextIdx = idx + 1;
            const nextSc = curScenes[nextIdx];
            activeSceneIdxRef.current = nextIdx;
            vid.currentTime = nextSc.startSec;
            onTimeUpdateRef.current(getSceneCutStart(curScenes, nextIdx));
          } else {
            vid.pause();
            onEndedRef.current();
            return;
          }
        } else {
          const localOffset = Math.max(0, Math.min(sc.durationSec, srcT - sc.startSec));
          onTimeUpdateRef.current(getSceneCutStart(curScenes, idx) + localOffset);
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceType, isPlaying]);

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
          onLoadedMetadata={(e) => {
            if (pendingLocalSeekRef.current !== null) {
              e.currentTarget.currentTime = pendingLocalSeekRef.current;
              pendingLocalSeekRef.current = null;
            }
          }}
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
