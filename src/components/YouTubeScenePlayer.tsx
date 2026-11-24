import {
  forwardRef,
  memo,
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

function applySafePlaybackRate(vid: HTMLVideoElement, targetRate: number): void {
  const safeRate =
    typeof targetRate === "number" && Number.isFinite(targetRate)
      ? Math.max(0.25, Math.min(2.5, targetRate))
      : 1;
  try {
    if (!vid.preservesPitch) {
      vid.preservesPitch = true;
    }
    const vidWebkit = vid as unknown as { webkitPreservesPitch?: boolean };
    if (vidWebkit.webkitPreservesPitch === false) {
      vidWebkit.webkitPreservesPitch = true;
    }
  } catch {
    // ignore unsupported preservesPitch implementations
  }
  try {
    if (Math.abs(vid.playbackRate - safeRate) > 0.001) {
      vid.playbackRate = safeRate;
    }
  } catch {
    // Some mobile browsers / WebViews reject playbackRate < 0.5 or > 2.0 or before metadata loads
    try {
      const fallbackRate = Math.max(0.5, Math.min(2.0, safeRate));
      if (Math.abs(vid.playbackRate - fallbackRate) > 0.001) {
        vid.playbackRate = fallbackRate;
      }
    } catch {
      // ignore unsupported media state
    }
  }
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
  getLiveCutTime?: () => number;
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

export const YouTubeScenePlayer = memo(
  forwardRef<YouTubeScenePlayerHandle, YouTubeScenePlayerProps>(function YouTubeScenePlayer(
    {
      sourceType,
      videoId,
      localUrl,
      scenes,
      cutTime,
      getLiveCutTime,
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
    const pendingLocalPlayRef = useRef<boolean>(false);
    const reloadAttemptedRef = useRef<boolean>(false);
    const voiceAttachedRef = useRef<boolean>(false);
    const autoMutedFallbackRef = useRef<boolean>(false);
    const lastSeekFixAtRef = useRef<number>(0);
    const seekSettleUntilRef = useRef<number>(0);
    const playAttemptPendingRef = useRef<boolean>(false);
    const ytStateRef = useRef<number>(-1);
    const ytHasPlayedRef = useRef<boolean>(false);
    const ytPlayKickAtRef = useRef<number>(0);
    const ytAnchorRef = useRef({
      rawYtTime: -1,
      sourceSec: 0,
      lastEstSec: 0,
      perfMs: 0,
      suppressUntilMs: 0,
    });

  const [autoMutedFallback, setAutoMutedFallback] = useState(false);
  const [ytReady, setYtReady] = useState(false);
  const [ytActualPlaying, setYtActualPlaying] = useState(false);
  const [needsDirectYtTap, setNeedsDirectYtTap] = useState(false);
  const [ytEmbedError, setYtEmbedError] = useState<string | null>(null);
  const [localPlayError, setLocalPlayError] = useState<string | null>(null);

  const hasVoiceEffects =
    Math.abs(voiceSettings.pitchSemitones) >= 0.08 ||
    Math.abs(voiceSettings.tone) > 0 ||
    voiceSettings.echo > 0 ||
    voiceSettings.robot > 0 ||
    Boolean(voiceSettings.adversarialNoise) ||
    Boolean(voiceSettings.spectralPhaseShift) ||
    Boolean(voiceSettings.vocalIsolation);

  // Always keep latest callbacks and settings accessible inside RAF loops & imperative handlers
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const cutTimeRef = useRef(cutTime);
  cutTimeRef.current = getLiveCutTime ? getLiveCutTime() : cutTime;
  const getLiveCutTimeRef = useRef(getLiveCutTime);
  getLiveCutTimeRef.current = getLiveCutTime;
  const readCurrentCutTime = useCallback(() => {
    return getLiveCutTimeRef.current ? getLiveCutTimeRef.current() : cutTimeRef.current;
  }, []);
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
    pendingLocalPlayRef.current = false;
    playAttemptPendingRef.current = false;
    reloadAttemptedRef.current = false;
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
    setYtReady(false);
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
        const initial = mapCutTimeToSource(scenesRef.current, readCurrentCutTime());
        activeSceneIdxRef.current = initial.sceneIndex;
        ytAnchorRef.current = {
          rawYtTime: -1,
          sourceSec: initial.sourceSec,
          lastEstSec: initial.sourceSec,
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
              setYtReady(true);
              try {
                const iframe = e.target.getIframe?.();
                if (iframe) {
                  iframe.style.width = "100%";
                  iframe.style.height = "100%";
                }
              } catch {
                // ignore
              }
              try {
                if (mutedRef.current) e.target.mute();
                else e.target.unMute();
                e.target.setPlaybackRate?.(youtubeSpeedRef.current);
              } catch {
                // ignore transient YouTube player error
              }
              const target = mapCutTimeToSource(scenesRef.current, readCurrentCutTime());
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
                lastEstSec: target.sourceSec,
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
                try {
                  playerRef.current.setPlaybackRate?.(youtubeSpeedRef.current);
                } catch {
                  // ignore transient YouTube rate error
                }
                const ytT = playerRef.current.getCurrentTime?.();
                if (typeof ytT === "number" && Number.isFinite(ytT)) {
                  ytAnchorRef.current.perfMs = performance.now();
                  if (performance.now() >= ytAnchorRef.current.suppressUntilMs) {
                    ytAnchorRef.current.rawYtTime = ytT;
                    ytAnchorRef.current.sourceSec = ytT;
                    ytAnchorRef.current.lastEstSec = ytT;
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
      setYtReady(false);
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
    let startCut = readCurrentCutTime();
    if (vid.ended || startCut >= Math.max(0, totalDur - 0.08)) {
      startCut = 0;
      onTimeUpdateRef.current(0);
    }

    const { sceneIndex, sourceSec } = mapCutTimeToSource(curScenes, startCut);
    activeSceneIdxRef.current = sceneIndex;

    isPlayingRef.current = true;

    // Auto-recover if Chrome/mobile evicted the hardware video decoder or media pipeline
    if (
      vid.error ||
      vid.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
      vid.networkState === HTMLMediaElement.NETWORK_EMPTY
    ) {
      reloadAttemptedRef.current = true;
      pendingLocalSeekRef.current = sourceSec;
      pendingLocalPlayRef.current = true;
      playAttemptPendingRef.current = false;
      onPlayingChangeRef.current(true);
      try {
        vid.load();
      } catch {
        // ignore
      }
      return;
    }

    if (vid.readyState >= 1) {
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceSec + 10;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
      if (Math.abs(vid.currentTime - clamped) > 0.08) {
        seekSettleUntilRef.current = performance.now() + 650;
        try {
          vid.currentTime = clamped;
        } catch {
          // ignore invalid media seek state
        }
      } else {
        seekSettleUntilRef.current = 0;
      }
      pendingLocalSeekRef.current = null;
    } else {
      pendingLocalSeekRef.current = sourceSec;
    }

    try {
      if (vid.muted !== mutedRef.current) {
        vid.muted = mutedRef.current;
      }
    } catch {
      // ignore
    }
    const targetRate = getEffectivePlaybackSpeed(
      "local",
      editSettingsRef.current.playbackSpeed,
      voiceSettingsRef.current.speed
    );
    applySafePlaybackRate(vid, targetRate);

    pendingLocalPlayRef.current = true;
    playAttemptPendingRef.current = true;
    let playPromise: Promise<void> | undefined;
    try {
      playPromise = vid.play();
    } catch {
      playPromise = undefined;
    }
    onPlayingChangeRef.current(true);
    if (playPromise && typeof playPromise.then === "function") {
      playPromise
        .then(() => {
          playAttemptPendingRef.current = false;
          pendingLocalPlayRef.current = false;
          onPlayingChangeRef.current(!vid.paused);
        })
        .catch((err: unknown) => {
          playAttemptPendingRef.current = false;
          const errName = err instanceof DOMException ? err.name : "";
          // If play() was interrupted by an active seek or metadata load, wait for canplay/seeked to resume
          if (errName === "AbortError" && isPlayingRef.current) {
            pendingLocalPlayRef.current = true;
            return;
          }
          if (vid.error && !reloadAttemptedRef.current) {
            reloadAttemptedRef.current = true;
            pendingLocalSeekRef.current = sourceSec;
            pendingLocalPlayRef.current = true;
            try {
              vid.load();
              return;
            } catch {
              // fall through
            }
          }
          // If unmuted autoplay blocked in an edge-case webview, retry muted cleanly
          if (!vid.muted) {
            autoMutedFallbackRef.current = true;
            setAutoMutedFallback(true);
            vid.muted = true;
            playAttemptPendingRef.current = true;
            vid
              .play()
              .then(() => {
                playAttemptPendingRef.current = false;
                pendingLocalPlayRef.current = false;
                onPlayingChangeRef.current(!vid.paused);
              })
              .catch((err2: unknown) => {
                playAttemptPendingRef.current = false;
                const err2Name = err2 instanceof DOMException ? err2.name : "";
                if (err2Name === "AbortError" && isPlayingRef.current) {
                  pendingLocalPlayRef.current = true;
                  return;
                }
                pendingLocalPlayRef.current = false;
                autoMutedFallbackRef.current = false;
                setAutoMutedFallback(false);
                onPlayingChangeRef.current(false);
                setLocalPlayError("Tap the video to start playback.");
              });
          } else {
            pendingLocalPlayRef.current = false;
            onPlayingChangeRef.current(false);
            setLocalPlayError("Tap the video to start playback.");
          }
        });
    } else {
      playAttemptPendingRef.current = false;
      pendingLocalPlayRef.current = false;
      onPlayingChangeRef.current(!vid.paused);
    }
  }, [readCurrentCutTime]);

  const pauseLocalPlayback = useCallback(() => {
    isPlayingRef.current = false;
    playAttemptPendingRef.current = false;
    pendingLocalPlayRef.current = false;
    autoMutedFallbackRef.current = false;
    setAutoMutedFallback(false);
    const vid = localVideoRef.current;
    if (vid && !vid.paused) {
      try {
        vid.pause();
      } catch {
        // ignore
      }
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
      let startCut = readCurrentCutTime();
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
            lastEstSec: sourceSec,
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
  }, [readCurrentCutTime]);

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
          if (!vid || vid.paused || vid.ended || vid.error) {
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

  // If Android mobile browser blocks external YT.Player.playVideo() after iframe is ready, surface a direct tap hint
  useEffect(() => {
    if (sourceType !== "youtube" || !isPlaying || !ytReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      const st = playerRef.current?.getPlayerState?.() ?? ytStateRef.current;
      if (isPlayingRef.current && st !== 1 && st !== 3) {
        setNeedsDirectYtTap(true);
        onPlayingChangeRef.current(false);
      }
    }, 2800);
    return () => window.clearTimeout(timer);
  }, [sourceType, isPlaying, ytReady]);

  // Reset initial position when source or scenes change (without interrupting active playback)
  useEffect(() => {
    if (isPlayingRef.current || playAttemptPendingRef.current || pendingLocalPlayRef.current) return;
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenes, readCurrentCutTime());
    activeSceneIdxRef.current = sceneIndex;

    if (sourceType === "local") {
      const vid = localVideoRef.current;
      if (vid) {
        if (vid.readyState >= 1) {
          if (Math.abs(vid.currentTime - sourceSec) > 0.08) {
            seekSettleUntilRef.current = performance.now() + 650;
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
            lastEstSec: sourceSec,
            perfMs: performance.now(),
            suppressUntilMs: performance.now() + 500,
          };
        } catch {
          // ignore
        }
      }
    }
  }, [sourceType, localUrl, scenes, readCurrentCutTime]);

  // Explicit user seek (scrubber drag, clicking subtitle card, or clicking scene chip)
  useEffect(() => {
    if (seekNonce === 0) return;
    const { sceneIndex, sourceSec } = mapCutTimeToSource(scenesRef.current, readCurrentCutTime());
    activeSceneIdxRef.current = sceneIndex;

    if (sourceType === "local") {
      const vid = localVideoRef.current;
      if (vid) {
        if (vid.readyState >= 1) {
          const actualDur =
            Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceSec + 10;
          const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
          if (Math.abs(vid.currentTime - clamped) > 0.04) {
            seekSettleUntilRef.current = performance.now() + 650;
            vid.currentTime = clamped;
          }
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
          lastEstSec: sourceSec,
          perfMs: performance.now(),
          suppressUntilMs: performance.now() + 1200,
        };
      } catch {
        // ignore
      }
    }
  }, [seekNonce, sourceType, readCurrentCutTime]);

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
          const { sceneIndex, sourceSec } = mapCutTimeToSource(scenesRef.current, readCurrentCutTime());
          activeSceneIdxRef.current = sceneIndex;
          const ytT = playerRef.current.getCurrentTime?.();
          if (typeof ytT !== "number" || Math.abs(ytT - sourceSec) > 0.35) {
            playerRef.current.seekTo(sourceSec, true);
            ytAnchorRef.current = {
              rawYtTime: -1,
              sourceSec,
              lastEstSec: sourceSec,
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
  }, [sourceType, isPlaying, muted, voiceSettings.speed, editSettings.playbackSpeed, readCurrentCutTime]);

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
                anchor.lastEstSec = ytTime;
                anchor.perfMs = now;
              }
            } else if (typeof ytTime === "number" && Number.isFinite(ytTime)) {
              if (ytTime !== anchor.rawYtTime) {
                anchor.rawYtTime = ytTime;
                // Avoid backward micro-jitter when YouTube discrete clock lags our extrapolation slightly
                if (ytTime >= anchor.lastEstSec - 0.35 && ytTime < anchor.lastEstSec) {
                  anchor.sourceSec = anchor.lastEstSec;
                } else {
                  anchor.sourceSec = ytTime;
                  anchor.lastEstSec = ytTime;
                }
                anchor.perfMs = now;
              }
            }

            const elapsed = Math.min(0.35, Math.max(0, (now - anchor.perfMs) / 1000));
            const estSourceSec = anchor.sourceSec + elapsed * youtubeSpeedRef.current;
            anchor.lastEstSec = estSourceSec;

            const idx = Math.min(activeSceneIdxRef.current, curScenes.length - 1);
            const sc = curScenes[idx];

            if (anchor.rawYtTime >= 0 && now >= anchor.suppressUntilMs && estSourceSec < sc.startSec - 0.8) {
              player.seekTo(sc.startSec, true);
              anchor.rawYtTime = -1;
              anchor.sourceSec = sc.startSec;
              anchor.lastEstSec = sc.startSec;
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
                  lastEstSec: nextSc.startSec,
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
    if ((!autoMutedFallbackRef.current || muted) && vid.muted !== muted) {
      vid.muted = muted;
    }
    const targetRate = getEffectivePlaybackSpeed(
      "local",
      editSettings.playbackSpeed,
      voiceSettings.speed
    );
    applySafePlaybackRate(vid, targetRate);
    if (hasVoiceEffects || voiceAttachedRef.current) {
      voiceAttachedRef.current = true;
      applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);
    }

    if (isPlaying) {
      if (vid.paused && !playAttemptPendingRef.current && !pendingLocalPlayRef.current) {
        startLocalPlayback();
      }
    } else {
      playAttemptPendingRef.current = false;
      pendingLocalPlayRef.current = false;
      autoMutedFallbackRef.current = false;
      setAutoMutedFallback(false);
      if (!vid.paused) {
        try {
          vid.pause();
        } catch {
          // ignore
        }
      }
    }
  }, [sourceType, isPlaying, muted, voiceSettings, editSettings.playbackSpeed, hasVoiceEffects, startLocalPlayback]);

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
        const idx = Math.max(0, Math.min(activeSceneIdxRef.current, curScenes.length - 1));
        const sc = curScenes[idx];
        const srcT = vid.currentTime;
        const now = performance.now();

        if (srcT < sc.startSec - 0.85 && now >= seekSettleUntilRef.current) {
          if (now - lastSeekFixAtRef.current > 600) {
            lastSeekFixAtRef.current = now;
            seekSettleUntilRef.current = now + 650;
            try {
              vid.currentTime = sc.startSec;
            } catch {
              // ignore
            }
          }
        } else if (srcT >= sc.endSec - 0.03 && now >= seekSettleUntilRef.current) {
          if (idx + 1 < curScenes.length) {
            const nextIdx = idx + 1;
            const nextSc = curScenes[nextIdx];
            activeSceneIdxRef.current = nextIdx;
            if (Math.abs(nextSc.startSec - srcT) > 0.18) {
              lastSeekFixAtRef.current = now;
              seekSettleUntilRef.current = now + 650;
              try {
                vid.currentTime = nextSc.startSec;
              } catch {
                // ignore
              }
            }
            onTimeUpdateRef.current(getSceneCutStart(curScenes, nextIdx));
          } else {
            try {
              vid.pause();
            } catch {
              // ignore
            }
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

  const applyPendingLocalSeekAndPlay = useCallback((vid: HTMLVideoElement) => {
    const target = pendingLocalSeekRef.current;
    if (target !== null) {
      const actualDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : target + 1;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), target));
      pendingLocalSeekRef.current = null;
      if (Math.abs(vid.currentTime - clamped) > 0.04) {
        seekSettleUntilRef.current = performance.now() + 650;
        vid.currentTime = clamped;
      }
    }
    const targetRate = getEffectivePlaybackSpeed(
      "local",
      editSettingsRef.current.playbackSpeed,
      voiceSettingsRef.current.speed
    );
    applySafePlaybackRate(vid, targetRate);
    if (pendingLocalPlayRef.current && isPlayingRef.current && vid.paused && vid.readyState >= 1) {
      pendingLocalPlayRef.current = false;
      playAttemptPendingRef.current = true;
      vid
        .play()
        .then(() => {
          playAttemptPendingRef.current = false;
          onPlayingChangeRef.current(!vid.paused);
        })
        .catch((err: unknown) => {
          playAttemptPendingRef.current = false;
          const errName = err instanceof DOMException ? err.name : "";
          if (errName === "AbortError" && isPlayingRef.current) {
            pendingLocalPlayRef.current = true;
            return;
          }
          if (!vid.muted) {
            autoMutedFallbackRef.current = true;
            setAutoMutedFallback(true);
            vid.muted = true;
            playAttemptPendingRef.current = true;
            vid
              .play()
              .then(() => {
                playAttemptPendingRef.current = false;
                onPlayingChangeRef.current(!vid.paused);
              })
              .catch(() => {
                playAttemptPendingRef.current = false;
                onPlayingChangeRef.current(false);
                setLocalPlayError("Tap the video to start playback.");
              });
          } else {
            onPlayingChangeRef.current(false);
            setLocalPlayError("Tap the video to start playback.");
          }
        });
    }
  }, []);

  const transformCss = buildCssTransformString(editSettings);
  const filterCss = buildCssFilterString(editSettings);
  const safeVignette =
    typeof editSettings.vignette === "number" && Number.isFinite(editSettings.vignette)
      ? editSettings.vignette
      : 0;
  const vignetteOpacity = Math.max(0, Math.min(1, safeVignette / 100));

  if (sourceType === "local") {
    if (!localUrl) {
      return (
        <div className="relative w-full h-full flex items-center justify-center p-4 bg-[#0b0f17] text-center">
          <p className="text-xs text-[#8e9aaf] leading-relaxed max-w-[240px]">
            Local video file is not linked. Link or re-upload the video in the Projects tab to preview.
          </p>
        </div>
      );
    }

    return (
      <div
        onClick={() => {
          const vid = localVideoRef.current;
          if (!vid || vid.paused || vid.ended || vid.error) startLocalPlayback();
          else pauseLocalPlayback();
        }}
        className="relative w-full h-full overflow-hidden bg-neutral-950 cursor-pointer group"
      >
        <video
          key={localUrl}
          ref={localVideoRef}
          src={localUrl}
          preload="auto"
          playsInline
          muted={muted || autoMutedFallback}
          onLoadedData={() => setLocalPlayError(null)}
          onLoadedMetadata={(e) => {
            setLocalPlayError(null);
            applyPendingLocalSeekAndPlay(e.currentTarget);
          }}
          onCanPlay={(e) => {
            setLocalPlayError(null);
            applyPendingLocalSeekAndPlay(e.currentTarget);
          }}
          onSeeked={(e) => {
            seekSettleUntilRef.current = 0;
            applyPendingLocalSeekAndPlay(e.currentTarget);
          }}
          onPlay={(e) => {
            setLocalPlayError(null);
            reloadAttemptedRef.current = false;
            playAttemptPendingRef.current = false;
            pendingLocalPlayRef.current = false;
            if (hasVoiceEffectsRef.current || voiceAttachedRef.current) {
              resumeAllVoiceContexts();
              voiceAttachedRef.current = true;
              applyVoiceEffectsToVideoElement(e.currentTarget, voiceSettingsRef.current, true);
            }
            const nextRate = getEffectivePlaybackSpeed(
              "local",
              editSettingsRef.current.playbackSpeed,
              voiceSettingsRef.current.speed
            );
            applySafePlaybackRate(e.currentTarget, nextRate);
            if (!isPlayingRef.current) {
              onPlayingChangeRef.current(true);
            }
          }}
          onPause={(e) => {
            const v = e.currentTarget;
            if (v.seeking || v.ended || playAttemptPendingRef.current || pendingLocalPlayRef.current) {
              return;
            }
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
              seekSettleUntilRef.current = performance.now() + 650;
              vid.currentTime = nextSc.startSec;
              onTimeUpdateRef.current(getSceneCutStart(curScenes, nextIdx));
              vid.play().catch(() => {
                onEndedRef.current();
              });
            } else {
              onEndedRef.current();
            }
          }}
          onError={(e) => {
            playAttemptPendingRef.current = false;
            const v = e.currentTarget;
            if (
              !reloadAttemptedRef.current &&
              localUrl &&
              (isPlayingRef.current || pendingLocalPlayRef.current)
            ) {
              reloadAttemptedRef.current = true;
              pendingLocalPlayRef.current = true;
              try {
                v.load();
                return;
              } catch {
                // fall through
              }
            }
            pendingLocalPlayRef.current = false;
            isPlayingRef.current = false;
            onPlayingChangeRef.current(false);
            setLocalPlayError("Could not play this video file.");
          }}
          style={{
            ...(transformCss !== "none" ? { transform: transformCss } : {}),
            ...(filterCss !== "none" ? { filter: filterCss } : {}),
          }}
          className={`w-full h-full bg-neutral-950 origin-center ${
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
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/15 group-hover:bg-black/25">
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
        className="w-full h-full origin-center"
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
            className={`absolute inset-0 w-full h-full pointer-events-none transition-opacity duration-200 ${
              ytActualPlaying ? "opacity-0" : "opacity-50"
            } ${editSettings.fitMode === "contain" ? "object-contain" : "object-cover"}`}
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
  })
);
