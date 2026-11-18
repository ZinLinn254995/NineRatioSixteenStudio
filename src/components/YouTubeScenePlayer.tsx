import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Play } from "lucide-react";
import type { SpeakingScene, VideoEditSettings, VoiceSettings } from "../types";
import { applyVoiceEffectsToVideoElement, resumeAllVoiceContexts } from "../utils/webAudioVoice";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";
import { buildCssFilterString, buildCssTransformString } from "../utils/videoFilters";
import { loadYouTubeIframeAPI } from "../utils/youtubeApi";
import { AdversarialNoiseOverlay } from "./AdversarialNoiseOverlay";

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
  getIframe?: () => HTMLIFrameElement;
  destroy: () => void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          width?: string | number;
          height?: string | number;
          videoId: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (e: { target: YTPlayerInstance }) => void;
            onStateChange?: (e: { data: number }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayerInstance;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
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

export interface YouTubeScenePlayerHandle {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
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
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
}

export const YouTubeScenePlayer = forwardRef<
  YouTubeScenePlayerHandle,
  YouTubeScenePlayerProps
>(function YouTubeScenePlayer(
  {
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
    onPlayingChange,
    onEnded,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const readyRef = useRef<boolean>(false);

  const activeSceneIdxRef = useRef<number>(0);
  const pendingLocalSeekRef = useRef<number | null>(null);
  const voiceAttachedRef = useRef<boolean>(false);
  const autoMutedFallbackRef = useRef<boolean>(false);
  const lastSeekFixAtRef = useRef<number>(0);
  const ytStateRef = useRef<number>(-1);
  const ytHasPlayedRef = useRef<boolean>(false);
  const ytPlayKickAtRef = useRef<number>(0);
  const ytAnchorRef = useRef({
    rawYtTime: -1,
    sourceSec: 0,
    perfMs: 0,
    suppressUntilMs: 0,
  });

  const [autoMutedFallback, setAutoMutedFallback] = useState(false);
  const [ytActualPlaying, setYtActualPlaying] = useState(false);
  const [needsDirectYtTap, setNeedsDirectYtTap] = useState(false);
  const [ytEmbedError, setYtEmbedError] = useState<string | null>(null);
  const [localPlayError, setLocalPlayError] = useState<string | null>(null);

  const hasVoiceEffects =
    Math.abs(voiceSettings.pitchSemitones) >= 0.08 ||
    Math.abs(voiceSettings.tone) > 0 ||
    voiceSettings.echo > 0 ||
    voiceSettings.robot > 0;

  // Always keep latest callbacks and settings accessible inside RAF loops & imperative handlers
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const cutTimeRef = useRef(cutTime);
  cutTimeRef.current = cutTime;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const voiceSettingsRef = useRef(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  const hasVoiceEffectsRef = useRef(hasVoiceEffects);
  hasVoiceEffectsRef.current = hasVoiceEffects;
  const editSettingsRef = useRef(editSettings);
  editSettingsRef.current = editSettings;
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
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

  // Reset playback guards when source changes
  useEffect(() => {
    voiceAttachedRef.current = false;
    autoMutedFallbackRef.current = false;
    setAutoMutedFallback(false);
    setLocalPlayError(null);
  }, [localUrl]);

  useEffect(() => {
    autoMutedFallbackRef.current = false;
    setAutoMutedFallback(false);
  }, [muted]);

  // Mount YouTube IFrame player when videoId changes
  useEffect(() => {
    if (sourceType !== "youtube" || !videoId || !containerRef.current) return;

    let cancelled = false;
    readyRef.current = false;
    ytStateRef.current = -1;
    ytHasPlayedRef.current = false;
    ytPlayKickAtRef.current = 0;
    setYtActualPlaying(false);
    setNeedsDirectYtTap(false);
    setYtEmbedError(null);

    const mountHost = document.createElement("div");
    mountHost.className = "w-full h-full";
    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(mountHost);

    loadYouTubeIframeAPI()
      .then(() => {
        if (cancelled || !window.YT?.Player) return;
        const initial = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
        activeSceneIdxRef.current = initial.sceneIndex;
        ytAnchorRef.current = {
          rawYtTime: -1,
          sourceSec: initial.sourceSec,
          perfMs: performance.now(),
          suppressUntilMs: performance.now() + 1000,
        };

        const playerVars: Record<string, string | number> = {
          autoplay: 0,
          controls: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          start: Math.floor(initial.sourceSec),
        };
        if (window.location.origin.startsWith("http")) {
          playerVars.origin = window.location.origin;
        }

        const player = new window.YT.Player(mountHost, {
          width: "100%",
          height: "100%",
          videoId,
          playerVars,
          events: {
            onReady: (e) => {
              if (cancelled) return;
              readyRef.current = true;
              try {
                const iframe = e.target.getIframe?.();
                if (iframe) {
                  iframe.style.width = "100%";
                  iframe.style.height = "100%";
                }
              } catch {
                // ignore
              }
              if (mutedRef.current) e.target.mute();
              else e.target.unMute();
              e.target.setPlaybackRate?.(youtubeSpeedRef.current);
              const target = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
              activeSceneIdxRef.current = target.sceneIndex;
              const startFloor = Math.floor(initial.sourceSec);
              if (
                isPlayingRef.current ||
                Math.abs(target.sourceSec - startFloor) >= 1.5
              ) {
                if (target.sourceSec > 0.5) {
                  e.target.seekTo(target.sourceSec, true);
                }
              }
              ytAnchorRef.current = {
                rawYtTime: -1,
                sourceSec: target.sourceSec,
                perfMs: performance.now(),
                suppressUntilMs: performance.now() + 500,
              };
              if (isPlayingRef.current) {
                ytPlayKickAtRef.current = performance.now();
                e.target.playVideo();
              }
            },
            onStateChange: (e) => {
              if (cancelled || !playerRef.current) return;
              ytStateRef.current = e.data;
              if (e.data === 1) {
                ytHasPlayedRef.current = true;
                setYtActualPlaying(true);
                setNeedsDirectYtTap(false);
                setYtEmbedError(null);
                playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);
                const ytT = playerRef.current.getCurrentTime?.();
                if (typeof ytT === "number" && Number.isFinite(ytT)) {
                  ytAnchorRef.current.perfMs = performance.now();
                  if (performance.now() >= ytAnchorRef.current.suppressUntilMs) {
                    ytAnchorRef.current.rawYtTime = ytT;
                    ytAnchorRef.current.sourceSec = ytT;
                  }
                }
                if (!isPlayingRef.current) {
                  onPlayingChangeRef.current(true);
                }
              } else if (e.data === 2) {
                setYtActualPlaying(false);
                const now = performance.now();
                if (
                  isPlayingRef.current &&
                  ytHasPlayedRef.current &&
                  now >= ytAnchorRef.current.suppressUntilMs + 600 &&
                  now - ytPlayKickAtRef.current >= 900
                ) {
                  ytHasPlayedRef.current = false;
                  onPlayingChangeRef.current(false);
                }
              } else if (e.data === 0) {
                setYtActualPlaying(false);
                ytHasPlayedRef.current = false;
                if (isPlayingRef.current) {
                  onEndedRef.current();
                }
              } else if (e.data === 3) {
                setYtActualPlaying(false);
              }
            },
            onError: (e) => {
              if (cancelled) return;
              setYtActualPlaying(false);
              if (e.data === 101 || e.data === 150) {
                setYtEmbedError("Video owner disabled embedded playback on other sites.");
              } else {
                setYtEmbedError("YouTube player could not load this video.");
              }
              onPlayingChangeRef.current(false);
            },
          },
        });
        playerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) {
          setYtEmbedError("Could not initialize YouTube player.");
          onPlayingChangeRef.current(false);
        }
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      setYtActualPlaying(false);
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [sourceType, videoId]);

  // Synchronous Play/Pause helpers so Android/iOS mobile browsers honor user tap gestures
  const startLocalPlayback = useCallback(() => {
    const vid = localVideoRef.current;
    if (!vid) return;

    const fallbackDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 30;
    const curScenes =
      scenesRef.current.length > 0
        ? scenesRef.current
        : [{ index: 0, startSec: 0, endSec: fallbackDur, durationSec: fallbackDur, summary: "Full video" }];

    setLocalPlayError(null);
    autoMutedFallbackRef.current = false;
    setAutoMutedFallback(false);

    if (hasVoiceEffectsRef.current || voiceAttachedRef.current) {
      resumeAllVoiceContexts();
      voiceAttachedRef.current = true;
      applyVoiceEffectsToVideoElement(vid, voiceSettingsRef.current, true);
    }

    const totalDur = curScenes.reduce((acc, s) => acc + s.durationSec, 0);
    let startCut = cutTimeRef.current;
    if (vid.ended || startCut >= Math.max(0, totalDur - 0.08)) {
      startCut = 0;
      onTimeUpdateRef.current(0);
    }

    const { sceneIndex, sourceSec } = mapCutTimeToSource(curScenes, startCut);
    activeSceneIdxRef.current = sceneIndex;

    if (vid.readyState >= 1) {
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceSec + 10;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
      if (Math.abs(vid.currentTime - clamped) > 0.08) {
        vid.currentTime = clamped;
      }
      pendingLocalSeekRef.current = null;
    } else {
      pendingLocalSeekRef.current = sourceSec;
    }

    vid.muted = mutedRef.current;
    vid.preservesPitch = true;
    (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    vid.playbackRate = getEffectivePlaybackSpeed(
      "local",
      editSettingsRef.current.playbackSpeed,
      voiceSettingsRef.current.speed
    );

    const playPromise = vid.play();
    if (playPromise && typeof playPromise.then === "function") {
      onPlayingChangeRef.current(true);
      playPromise
        .then(() => {
          onPlayingChangeRef.current(!vid.paused);
        })
        .catch(() => {
          // If unmuted autoplay blocked in an edge-case webview, retry muted cleanly
          if (!vid.muted) {
            autoMutedFallbackRef.current = true;
            setAutoMutedFallback(true);
            vid.muted = true;
            vid
              .play()
              .then(() => {
                onPlayingChangeRef.current(!vid.paused);
              })
              .catch(() => {
                autoMutedFallbackRef.current = false;
                setAutoMutedFallback(false);
                onPlayingChangeRef.current(false);
                setLocalPlayError("Tap the video to start playback.");
              });
          } else {
            onPlayingChangeRef.current(false);
            setLocalPlayError("Tap the video to start playback.");
          }
        });
    } else {
      onPlayingChangeRef.current(!vid.paused);
    }
  }, []);

  const pauseLocalPlayback = useCallback(() => {
    autoMutedFallbackRef.current = false;
    setAutoMutedFallback(false);
    const vid = localVideoRef.current;
    if (vid && !vid.paused) {
      vid.pause();
    }
    onPlayingChangeRef.current(false);
  }, []);

  const startYouTubePlayback = useCallback(() => {
    ytPlayKickAtRef.current = performance.now();
    ytHasPlayedRef.current = false;
    setNeedsDirectYtTap(false);
    onPlayingChangeRef.current(true);
    if (!readyRef.current || !playerRef.current) return;
    try {
      const curScenes = scenesRef.current;
      const totalDur = curScenes.reduce((acc, s) => acc + s.durationSec, 0);
      let startCut = cutTimeRef.current;
      if (totalDur > 0 && startCut >= Math.max(0, totalDur - 0.08)) {
        startCut = 0;
        onTimeUpdateRef.current(0);
      }
      const { sceneIndex, sourceSec } = mapCutTimeToSource(curScenes, startCut);
      activeSceneIdxRef.current = sceneIndex;

      if (mutedRef.current) playerRef.current.mute();
      else playerRef.current.unMute();
      playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);

      const isUnstartedSameAnchor =
        ytStateRef.current === -1 &&
        Math.abs(sourceSec - ytAnchorRef.current.sourceSec) < 0.8;
      if (!isUnstartedSameAnchor) {
        const ytT = playerRef.current.getCurrentTime?.();
        if (typeof ytT !== "number" || Math.abs(ytT - sourceSec) > 0.35) {
          playerRef.current.seekTo(sourceSec, true);
          ytAnchorRef.current = {
            rawYtTime: -1,
            sourceSec,
            perfMs: performance.now(),
            suppressUntilMs: performance.now() + 500,
          };
        } else {
          ytAnchorRef.current.perfMs = performance.now();
        }
      } else {
        ytAnchorRef.current.perfMs = performance.now();
      }
      playerRef.current.playVideo();
    } catch {
      // ignore
    }
  }, []);

  const pauseYouTubePlayback = useCallback(() => {
    ytHasPlayedRef.current = false;
    setYtActualPlaying(false);
    setNeedsDirectYtTap(false);
    onPlayingChangeRef.current(false);
    if (readyRef.current && playerRef.current) {
      try {
        playerRef.current.pauseVideo();
      } catch {
        // ignore
      }
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        if (sourceType === "local") startLocalPlayback();
        else startYouTubePlayback();
      },
      pause: () => {
        if (sourceType === "local") pauseLocalPlayback();
        else pauseYouTubePlayback();
      },
      togglePlay: () => {
        if (sourceType === "local") {
          const vid = localVideoRef.current;
          if (!vid || vid.paused || vid.ended) {
            startLocalPlayback();
          } else {
            pauseLocalPlayback();
          }
        } else {
          const st = playerRef.current?.getPlayerState?.() ?? ytStateRef.current;
          const actuallyPlaying = ytActualPlaying || st === 1 || st === 3;
          if (isPlayingRef.current && actuallyPlaying) {
            pauseYouTubePlayback();
          } else {
            startYouTubePlayback();
          }
        }
      },
    }),
    [sourceType, ytActualPlaying, startLocalPlayback, pauseLocalPlayback, startYouTubePlayback, pauseYouTubePlayback]
  );

  // If Android mobile browser blocks external YT.Player.playVideo(), surface a direct tap hint onto the iframe
  useEffect(() => {
    if (sourceType !== "youtube" || !isPlaying) {
      return;
    }
    const timer = window.setTimeout(() => {
      const st = playerRef.current?.getPlayerState?.() ?? ytStateRef.current;
      if (isPlayingRef.current && st !== 1 && st !== 3) {
        setNeedsDirectYtTap(true);
        onPlayingChangeRef.current(false);
      }
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [sourceType, isPlaying]);

  // Reset initial position when source or scenes change (without interrupting active playback)
  useEffect(() => {
    if (isPlayingRef.current) return;
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenes, cutTimeRef.current);
    activeSceneIdxRef.current = sceneIndex;

    if (sourceType === "local") {
      const vid = localVideoRef.current;
      if (vid) {
        if (vid.readyState >= 1) {
          if (Math.abs(vid.currentTime - sourceSec) > 0.08) {
            vid.currentTime = sourceSec;
          }
          pendingLocalSeekRef.current = null;
        } else {
          pendingLocalSeekRef.current = sourceSec;
        }
      }
    } else if (sourceType === "youtube" && readyRef.current && playerRef.current) {
      if (
        ytStateRef.current !== -1 ||
        Math.abs(sourceSec - ytAnchorRef.current.sourceSec) >= 1.5
      ) {
        try {
          playerRef.current.seekTo(sourceSec, true);
          ytAnchorRef.current = {
            rawYtTime: -1,
            sourceSec,
            perfMs: performance.now(),
            suppressUntilMs: performance.now() + 500,
          };
        } catch {
          // ignore
        }
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
          suppressUntilMs: performance.now() + 1200,
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
        // Skip duplicate seek/play if startYouTubePlayback() just kicked off playback synchronously
        if (performance.now() - ytPlayKickAtRef.current < 600) {
          return;
        }
        const st = playerRef.current.getPlayerState?.() ?? ytStateRef.current;
        if (st !== 1 && st !== 3) {
          const { sceneIndex, sourceSec } = mapCutTimeToSource(scenesRef.current, cutTimeRef.current);
          activeSceneIdxRef.current = sceneIndex;
          const ytT = playerRef.current.getCurrentTime?.();
          if (typeof ytT !== "number" || Math.abs(ytT - sourceSec) > 0.35) {
            playerRef.current.seekTo(sourceSec, true);
            ytAnchorRef.current = {
              rawYtTime: -1,
              sourceSec,
              perfMs: performance.now(),
              suppressUntilMs: performance.now() + 500,
            };
          } else {
            ytAnchorRef.current.perfMs = performance.now();
          }
          ytPlayKickAtRef.current = performance.now();
          playerRef.current.playVideo();
        }
      } else {
        const st = playerRef.current.getPlayerState?.() ?? ytStateRef.current;
        if (st === 1 || st === 3) {
          playerRef.current.pauseVideo();
        }
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
                Math.abs(ytTime - anchor.sourceSec) < 0.85
              ) {
                anchor.suppressUntilMs = 0;
                anchor.rawYtTime = ytTime;
                anchor.sourceSec = ytTime;
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
              anchor.suppressUntilMs = now + 500;
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

  // Sync local HTML5 video settings & attach WebAudio ONLY when voice effects are active
  useEffect(() => {
    const vid = localVideoRef.current;
    if (sourceType !== "local" || !vid) return;
    if (!autoMutedFallbackRef.current || muted) {
      vid.muted = muted;
    }
    vid.preservesPitch = true;
    (vid as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    vid.playbackRate = getEffectivePlaybackSpeed(
      "local",
      editSettings.playbackSpeed,
      voiceSettings.speed
    );
    if (hasVoiceEffects || voiceAttachedRef.current) {
      voiceAttachedRef.current = true;
      applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);
    }

    if (!isPlaying) {
      autoMutedFallbackRef.current = false;
      setAutoMutedFallback(false);
      if (!vid.paused) {
        vid.pause();
      }
    }
  }, [sourceType, isPlaying, muted, voiceSettings, editSettings.playbackSpeed, hasVoiceEffects]);

  // Master player-driven 60fps clock for Local <video> (directly tracks vid.currentTime)
  useEffect(() => {
    if (sourceType !== "local" || !isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const vid = localVideoRef.current;
      const fallbackDur = vid && Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 30;
      const curScenes =
        scenesRef.current.length > 0
          ? scenesRef.current
          : [{ index: 0, startSec: 0, endSec: fallbackDur, durationSec: fallbackDur, summary: "Full video" }];
      if (vid && curScenes.length > 0 && !vid.paused && !vid.seeking && vid.readyState >= 1) {
        const idx = Math.min(activeSceneIdxRef.current, curScenes.length - 1);
        const sc = curScenes[idx];
        const srcT = vid.currentTime;
        const now = performance.now();

        if (srcT < sc.startSec - 0.25) {
          if (now - lastSeekFixAtRef.current > 500) {
            lastSeekFixAtRef.current = now;
            vid.currentTime = sc.startSec;
          }
        } else if (srcT >= sc.endSec - 0.03) {
          if (idx + 1 < curScenes.length) {
            const nextIdx = idx + 1;
            const nextSc = curScenes[nextIdx];
            activeSceneIdxRef.current = nextIdx;
            if (Math.abs(nextSc.startSec - srcT) > 0.18) {
              lastSeekFixAtRef.current = now;
              vid.currentTime = nextSc.startSec;
            }
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

  const applyPendingLocalSeek = useCallback((vid: HTMLVideoElement) => {
    const target = pendingLocalSeekRef.current;
    if (target === null) return;
    const actualDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : target + 1;
    const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), target));
    pendingLocalSeekRef.current = null;
    if (Math.abs(vid.currentTime - clamped) > 0.04) {
      vid.currentTime = clamped;
    }
  }, []);

  const transformCss = buildCssTransformString(editSettings);
  const filterCss = buildCssFilterString(editSettings);
  const vignetteOpacity = Math.max(0, Math.min(1, editSettings.vignette / 100));

  if (sourceType === "local") {
    if (!localUrl) {
      return (
        <div className="relative w-full h-full flex items-center justify-center p-4 bg-neutral-950 text-center">
          <p className="text-xs text-neutral-300 leading-relaxed max-w-[240px]">
            Local video file is not linked. Link or re-upload the video in the Saved tab to preview.
          </p>
        </div>
      );
    }

    return (
      <div
        onClick={() => {
          const vid = localVideoRef.current;
          if (!vid || vid.paused || vid.ended) startLocalPlayback();
          else pauseLocalPlayback();
        }}
        className="relative w-full h-full overflow-hidden bg-neutral-950 cursor-pointer group"
      >
        <video
          ref={localVideoRef}
          src={localUrl}
          preload="auto"
          playsInline
          muted={muted || autoMutedFallback}
          onLoadedMetadata={(e) => {
            applyPendingLocalSeek(e.currentTarget);
          }}
          onCanPlay={(e) => {
            applyPendingLocalSeek(e.currentTarget);
          }}
          onPlay={(e) => {
            setLocalPlayError(null);
            if (hasVoiceEffectsRef.current || voiceAttachedRef.current) {
              resumeAllVoiceContexts();
              voiceAttachedRef.current = true;
              applyVoiceEffectsToVideoElement(e.currentTarget, voiceSettingsRef.current, true);
            }
            e.currentTarget.preservesPitch = true;
            e.currentTarget.playbackRate = getEffectivePlaybackSpeed(
              "local",
              editSettingsRef.current.playbackSpeed,
              voiceSettingsRef.current.speed
            );
            onPlayingChangeRef.current(true);
          }}
          onPause={() => {
            if (isPlayingRef.current) {
              onPlayingChangeRef.current(false);
            }
          }}
          onEnded={() => {
            const curScenes = scenesRef.current;
            const idx = activeSceneIdxRef.current;
            const vid = localVideoRef.current;
            if (vid && idx + 1 < curScenes.length) {
              const nextIdx = idx + 1;
              const nextSc = curScenes[nextIdx];
              activeSceneIdxRef.current = nextIdx;
              vid.currentTime = nextSc.startSec;
              onTimeUpdateRef.current(getSceneCutStart(curScenes, nextIdx));
              vid.play().catch(() => {
                onEndedRef.current();
              });
            } else {
              onEndedRef.current();
            }
          }}
          onError={() => {
            onPlayingChangeRef.current(false);
            setLocalPlayError("Could not play this video file.");
          }}
          style={{
            ...(transformCss !== "none" ? { transform: transformCss } : {}),
            ...(filterCss !== "none" ? { filter: filterCss } : {}),
          }}
          className={`w-full h-full bg-neutral-950 origin-center transition-transform duration-75 ${
            editSettings.fitMode === "contain" ? "object-contain" : "object-cover"
          }`}
        />
        <AdversarialNoiseOverlay
          enabled={editSettings.adversarialNoise}
          strength={editSettings.adversarialStrength}
          animate={isPlaying}
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
        {!isPlaying && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/15 group-hover:bg-black/25 transition-colors">
            <div className="w-11 h-11 rounded-full bg-black/70 text-white flex items-center justify-center backdrop-blur-xs shadow-sm">
              <Play className="w-4 h-4 ml-0.5" />
            </div>
            {localPlayError && (
              <span className="px-2.5 py-1 rounded-md bg-black/75 text-white text-[11px]">
                {localPlayError}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={() => {
        if (ytActualPlaying && !needsDirectYtTap) {
          pauseYouTubePlayback();
        }
      }}
      className="relative w-full h-full overflow-hidden bg-neutral-950"
    >
      <div
        className="w-full h-full origin-center transition-transform duration-75"
        style={{
          ...(transformCss !== "none" ? { transform: transformCss } : {}),
          ...(filterCss !== "none" ? { filter: filterCss } : {}),
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
          className={`relative w-full h-full ${
            ytActualPlaying && !needsDirectYtTap ? "pointer-events-none" : "pointer-events-auto"
          } ${editSettings.fitMode === "cover" ? "scale-[1.06]" : "scale-100"}`}
        />
      </div>
      <AdversarialNoiseOverlay
        enabled={editSettings.adversarialNoise}
        strength={editSettings.adversarialStrength}
        animate={isPlaying && ytActualPlaying}
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
      {needsDirectYtTap && !ytEmbedError && (
        <div className="pointer-events-none absolute bottom-2.5 inset-x-0 flex justify-center px-3">
          <span className="px-2.5 py-1 rounded-full bg-black/80 text-white text-[11px] font-medium backdrop-blur-xs shadow-sm">
            Tap video directly to play
          </span>
        </div>
      )}
      {ytEmbedError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 bg-black/70 text-center">
          <p className="text-xs text-white leading-relaxed">{ytEmbedError}</p>
        </div>
      )}
    </div>
  );
});
