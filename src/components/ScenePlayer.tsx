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
import { capturePassiveThumbFromVideo } from "../utils/timelineThumbBus";
import { AdversarialNoiseOverlay } from "./AdversarialNoiseOverlay";

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

export interface ScenePlayerHandle {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setScrubbing: (active: boolean) => void;
  seekCutTime: (cutSec: number, opts?: { force?: boolean }) => void;
  previewSourceTime: (sourceSec: number | null, opts?: { skipResync?: boolean }) => void;
}

interface ScenePlayerProps {
  localUrl?: string;
  scenes: SpeakingScene[];
  cutTime: number;
  getLiveCutTime?: () => number;
  seekNonce: number;
  isPlaying: boolean;
  muted: boolean;
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  onTimeUpdate: (newCutTime: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
}

export const ScenePlayer = memo(
  forwardRef<ScenePlayerHandle, ScenePlayerProps>(function ScenePlayer(
    {
      localUrl,
      scenes,
      cutTime,
      getLiveCutTime,
      seekNonce,
      isPlaying,
      muted,
      voiceSettings,
      editSettings,
      onTimeUpdate,
      onPlayingChange,
      onEnded,
    },
    ref
  ) {
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const scrubCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const activeSceneIdxRef = useRef<number>(0);
    const pendingLocalSeekRef = useRef<number | null>(null);
    const pendingLocalPlayRef = useRef<boolean>(false);
    const reloadAttemptedRef = useRef<boolean>(false);
    const freezeRecoveryStageRef = useRef<number>(0);
    const freezeWatchTimerRef = useRef<number | null>(null);
    const freezeWatchVfcIdRef = useRef<number | null>(null);
    const canPlayWaitTimerRef = useRef<number | null>(null);
    const voiceAttachedRef = useRef<boolean>(false);
    const autoMutedFallbackRef = useRef<boolean>(false);
    const lastSeekFixAtRef = useRef<number>(0);
    const lastLocalSeekIssuedAtRef = useRef<number>(0);
    const lastSeekDurationMsRef = useRef<number>(0);
    const seekSettleUntilRef = useRef<number>(0);
    const playAttemptPendingRef = useRef<boolean>(false);
    const sourcePreviewOverrideRef = useRef<number | null>(null);
    const pendingPreviewSeekRef = useRef<number | null>(null);
    const previewSeekRafRef = useRef<number | null>(null);
    const isScrubbingRef = useRef<boolean>(false);
    const waitingForScrubPaintRef = useRef<boolean>(false);
    const scrubFlushRafRef = useRef<number | null>(null);
    const scrubFlushTimerRef = useRef<number | null>(null);

    const localStageRef = useRef<HTMLDivElement | null>(null);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [autoMutedFallback, setAutoMutedFallback] = useState(false);
    const [localPlayError, setLocalPlayError] = useState<string | null>(null);
    const [localVideoDims, setLocalVideoDims] = useState<{ w: number; h: number } | null>(null);
    const [localViewportDims, setLocalViewportDims] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => {
      setLocalVideoDims(null);
    }, [localUrl]);

    useEffect(() => {
      const host = localStageRef.current;
      if (!host) return;
      const updateSize = () => {
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setLocalViewportDims((prev) =>
            prev && Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5
              ? prev
              : { w: rect.width, h: rect.height }
          );
        }
      };
      updateSize();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(updateSize);
      ro.observe(host);
      return () => ro.disconnect();
    }, [localUrl]);

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
    const localUrlRef = useRef(localUrl);
    localUrlRef.current = localUrl;
    const onEndedRef = useRef(onEnded);
    onEndedRef.current = onEnded;

    const hideScrubCanvas = useCallback(() => {
      const canvas = scrubCanvasRef.current;
      if (canvas) {
        canvas.style.opacity = "0";
        canvas.style.display = "none";
      }
    }, []);

    const paintScrubCanvasFrame = useCallback((vid: HTMLVideoElement, showCanvas: boolean) => {
      const canvas = scrubCanvasRef.current;
      if (!canvas) return;
      if (!showCanvas) {
        canvas.style.opacity = "0";
        canvas.style.display = "none";
        return;
      }
      if (vid.readyState < 2 || vid.videoWidth <= 0 || vid.videoHeight <= 0) return;
      const vw = vid.videoWidth;
      const vh = vid.videoHeight;
      const maxEdge = 540;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const tw = Math.max(2, Math.round(vw * scale));
      const th = Math.max(2, Math.round(vh * scale));
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width = tw;
        canvas.height = th;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        ctx.drawImage(vid, 0, 0, tw, th);
        canvas.style.display = "block";
        canvas.style.opacity = "1";
      } catch {
        // ignore transient frame read errors
      }
    }, []);

    const clearCanPlayWaitTimer = useCallback(() => {
      if (canPlayWaitTimerRef.current !== null) {
        window.clearTimeout(canPlayWaitTimerRef.current);
        canPlayWaitTimerRef.current = null;
      }
    }, []);

    const stopPlaybackFreezeWatchdog = useCallback(() => {
      if (freezeWatchTimerRef.current !== null) {
        window.clearTimeout(freezeWatchTimerRef.current);
        freezeWatchTimerRef.current = null;
      }
      const vid = localVideoRef.current as
        | (HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void })
        | null;
      if (freezeWatchVfcIdRef.current !== null && vid?.cancelVideoFrameCallback) {
        try {
          vid.cancelVideoFrameCallback(freezeWatchVfcIdRef.current);
        } catch {
          // ignore
        }
      }
      freezeWatchVfcIdRef.current = null;
    }, []);

    const startPlaybackFreezeWatchdog = useCallback(
      (vid: HTMLVideoElement, startMediaSec: number) => {
        stopPlaybackFreezeWatchdog();
        if (freezeRecoveryStageRef.current >= 2) return;

        type VfcMeta = { mediaTime?: number; presentedFrames?: number };
        const vidExt = vid as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: (now: number, meta?: VfcMeta) => void) => number;
          getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
        };
        const hasVfc = typeof vidExt.requestVideoFrameCallback === "function";
        const initialTotalFrames =
          typeof vidExt.getVideoPlaybackQuality === "function"
            ? (vidExt.getVideoPlaybackQuality()?.totalVideoFrames ?? 0)
            : null;
        if (!hasVfc && initialTotalFrames === null) return;

        let distinctFrames = 0;
        let lastPresentedMediaTime = -1;

        if (hasVfc) {
          const onFrame = (_now: number, meta?: VfcMeta) => {
            freezeWatchVfcIdRef.current = null;
            const mt =
              meta && typeof meta.mediaTime === "number" && Number.isFinite(meta.mediaTime)
                ? meta.mediaTime
                : null;
            if (mt !== null) {
              if (lastPresentedMediaTime < 0 || Math.abs(mt - lastPresentedMediaTime) > 0.008) {
                distinctFrames++;
                lastPresentedMediaTime = mt;
              }
            } else {
              distinctFrames++;
            }

            const lag =
              lastPresentedMediaTime >= 0 ? Math.abs(vid.currentTime - lastPresentedMediaTime) : 0;
            if (distinctFrames >= 3 && lag < 0.35) {
              freezeRecoveryStageRef.current = 0;
              stopPlaybackFreezeWatchdog();
              return;
            }
            if (!vid.paused && isPlayingRef.current && !isScrubbingRef.current) {
              try {
                freezeWatchVfcIdRef.current = vidExt.requestVideoFrameCallback!(onFrame);
              } catch {
                freezeWatchVfcIdRef.current = null;
              }
            }
          };
          try {
            freezeWatchVfcIdRef.current = vidExt.requestVideoFrameCallback!(onFrame);
          } catch {
            freezeWatchVfcIdRef.current = null;
          }
        }

        freezeWatchTimerRef.current = window.setTimeout(() => {
          freezeWatchTimerRef.current = null;
          const curVid = localVideoRef.current;
          if (
            !curVid ||
            curVid.paused ||
            curVid.seeking ||
            !isPlayingRef.current ||
            isScrubbingRef.current ||
            freezeRecoveryStageRef.current >= 2
          ) {
            stopPlaybackFreezeWatchdog();
            return;
          }

          const currentFramesDelta =
            initialTotalFrames !== null && typeof vidExt.getVideoPlaybackQuality === "function"
              ? (vidExt.getVideoPlaybackQuality()?.totalVideoFrames ?? initialTotalFrames) -
                initialTotalFrames
              : 0;
          const framesRendered = hasVfc ? distinctFrames : currentFramesDelta;
          const advancedSec = curVid.currentTime - startMediaSec;
          const mediaTimeLag =
            lastPresentedMediaTime >= 0 ? curVid.currentTime - lastPresentedMediaTime : 0;

          // Audio/clock advanced >= 0.35s while preview video frame stayed frozen
          const isFrozen =
            advancedSec >= 0.35 && (framesRendered < 2 || mediaTimeLag >= 0.45);

          if (isFrozen) {
            const stage = freezeRecoveryStageRef.current;
            freezeRecoveryStageRef.current = stage + 1;
            stopPlaybackFreezeWatchdog();
            const recoverTarget = startMediaSec < 0.15 ? 0 : startMediaSec;
            pendingLocalPlayRef.current = true;
            playAttemptPendingRef.current = false;
            lastLocalSeekIssuedAtRef.current = performance.now();
            seekSettleUntilRef.current = performance.now() + 1200;

            if (stage === 0) {
              // Stage 1: Clean pause + exact keyframe/target seek, then wait for seeked before play
              try {
                curVid.pause();
                curVid.currentTime = recoverTarget;
              } catch {
                // ignore
              }
            } else {
              // Stage 2: Full MediaCodec pipeline reset via load() and resume from target
              pendingLocalSeekRef.current = recoverTarget;
              try {
                curVid.pause();
                curVid.load();
              } catch {
                // ignore
              }
            }
          } else {
            freezeRecoveryStageRef.current = 0;
            stopPlaybackFreezeWatchdog();
          }
        }, 520);
      },
      [stopPlaybackFreezeWatchdog]
    );

    const cancelPreviewSeekRaf = useCallback(() => {
      if (previewSeekRafRef.current !== null) {
        cancelAnimationFrame(previewSeekRafRef.current);
        previewSeekRafRef.current = null;
      }
    }, []);

    const cancelScrubFlush = useCallback(() => {
      waitingForScrubPaintRef.current = false;
      if (scrubFlushRafRef.current !== null) {
        cancelAnimationFrame(scrubFlushRafRef.current);
        scrubFlushRafRef.current = null;
      }
      if (scrubFlushTimerRef.current !== null) {
        window.clearTimeout(scrubFlushTimerRef.current);
        scrubFlushTimerRef.current = null;
      }
    }, []);

    const issueVideoSeek = useCallback((vid: HTMLVideoElement, targetSec: number) => {
      const now = performance.now();
      lastLocalSeekIssuedAtRef.current = now;
      seekSettleUntilRef.current = now + 650;
      try {
        vid.currentTime = targetSec;
      } catch {
        // ignore invalid media seek state
      }
    }, []);

    const scheduleScrubPaintThenFlush = useCallback(
      (_vid: HTMLVideoElement, onReady: (v: HTMLVideoElement) => void) => {
        cancelScrubFlush();
        waitingForScrubPaintRef.current = true;
        let settled = false;

        const finishPaint = () => {
          if (settled) return;
          settled = true;
          cancelScrubFlush();
          const curVid = localVideoRef.current;
          if (curVid) {
            onReady(curVid);
          }
        };

        // Safety cap in case rAF is throttled
        scrubFlushTimerRef.current = window.setTimeout(finishPaint, 50);

        // Wait two animation frames after seeked so the newly decoded video frame commits to the screen
        // before issuing the next queued scrub seek (reliable on paused <video> across mobile & desktop)
        scrubFlushRafRef.current = requestAnimationFrame(() => {
          scrubFlushRafRef.current = requestAnimationFrame(() => {
            scrubFlushRafRef.current = null;
            finishPaint();
          });
        });
      },
      [cancelScrubFlush]
    );

    const flushLocalPreviewSeek = useCallback((vid: HTMLVideoElement) => {
      const target = pendingPreviewSeekRef.current;
      if (target === null || sourcePreviewOverrideRef.current === null) return;
      if (vid.readyState < 1 || vid.seeking) return;
      const actualDur =
        Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : target + 1;
      const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.02), target));
      pendingPreviewSeekRef.current = null;
      if (Math.abs(vid.currentTime - clamped) > 0.015) {
        seekSettleUntilRef.current = performance.now() + 650;
        try {
          vid.currentTime = clamped;
        } catch {
          // ignore invalid media seek state
        }
      }
    }, []);

    // Reset playback guards when source changes
    useEffect(() => {
      voiceAttachedRef.current = false;
      autoMutedFallbackRef.current = false;
      pendingLocalPlayRef.current = false;
      playAttemptPendingRef.current = false;
      reloadAttemptedRef.current = false;
      freezeRecoveryStageRef.current = 0;
      sourcePreviewOverrideRef.current = null;
      pendingPreviewSeekRef.current = null;
      isScrubbingRef.current = false;
      waitingForScrubPaintRef.current = false;
      lastSeekDurationMsRef.current = 0;
      setIsScrubbing(false);
      hideScrubCanvas();
      clearCanPlayWaitTimer();
      stopPlaybackFreezeWatchdog();
      cancelPreviewSeekRaf();
      cancelScrubFlush();
      setAutoMutedFallback(false);
      setLocalPlayError(null);
      return () => {
        sourcePreviewOverrideRef.current = null;
        pendingPreviewSeekRef.current = null;
        isScrubbingRef.current = false;
        waitingForScrubPaintRef.current = false;
        hideScrubCanvas();
        clearCanPlayWaitTimer();
        stopPlaybackFreezeWatchdog();
        cancelPreviewSeekRaf();
        cancelScrubFlush();
      };
    }, [
      localUrl,
      cancelPreviewSeekRaf,
      cancelScrubFlush,
      clearCanPlayWaitTimer,
      hideScrubCanvas,
      stopPlaybackFreezeWatchdog,
    ]);

    useEffect(() => {
      autoMutedFallbackRef.current = false;
      setAutoMutedFallback(false);
    }, [muted]);

    // Synchronous Play/Pause helpers so Android/iOS mobile browsers honor user tap gestures
    const startLocalPlayback = useCallback(() => {
      sourcePreviewOverrideRef.current = null;
      pendingPreviewSeekRef.current = null;
      isScrubbingRef.current = false;
      setIsScrubbing(false);
      hideScrubCanvas();
      clearCanPlayWaitTimer();
      stopPlaybackFreezeWatchdog();
      cancelPreviewSeekRaf();
      cancelScrubFlush();
      const vid = localVideoRef.current;
      if (!vid) return;

      const fallbackDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 30;
      const curScenes =
        scenesRef.current.length > 0
          ? scenesRef.current
          : [
              {
                index: 0,
                startSec: 0,
                endSec: fallbackDur,
                durationSec: fallbackDur,
                summary: "Full video",
              },
            ];

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

      try {
        if (vid.muted !== mutedRef.current) {
          vid.muted = mutedRef.current;
        }
      } catch {
        // ignore
      }
      const targetRate = getEffectivePlaybackSpeed(
        editSettingsRef.current.playbackSpeed,
        voiceSettingsRef.current.speed
      );
      applySafePlaybackRate(vid, targetRate);

      let needsSeekWait = false;
      if (vid.readyState >= 1) {
        const actualDur =
          Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceSec + 10;
        const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), sourceSec));
        if (Math.abs(vid.currentTime - clamped) > 0.04) {
          needsSeekWait = true;
          lastLocalSeekIssuedAtRef.current = performance.now();
          seekSettleUntilRef.current = performance.now() + 900;
          try {
            if (!vid.paused) vid.pause();
            vid.currentTime = clamped;
          } catch {
            // ignore invalid media seek state
          }
        } else {
          seekSettleUntilRef.current = 0;
          if (vid.seeking) {
            needsSeekWait = true;
          }
        }
        pendingLocalSeekRef.current = null;
      } else {
        pendingLocalSeekRef.current = sourceSec;
        needsSeekWait = true;
      }

      // On Android Chrome, calling play() synchronously while a seek is in flight causes
      // audio to start before MediaCodec finishes decoding the target frame, dropping video
      // until the next keyframe (up to 8s). Wait for seeked/canplay before starting playback.
      if (needsSeekWait) {
        pendingLocalPlayRef.current = true;
        playAttemptPendingRef.current = false;
        onPlayingChangeRef.current(true);
        return;
      }

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
            if (!vid.paused) {
              startPlaybackFreezeWatchdog(vid, vid.currentTime);
            }
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
                  if (!vid.paused) {
                    startPlaybackFreezeWatchdog(vid, vid.currentTime);
                  }
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
        if (!vid.paused) {
          startPlaybackFreezeWatchdog(vid, vid.currentTime);
        }
      }
    }, [
      cancelPreviewSeekRaf,
      cancelScrubFlush,
      clearCanPlayWaitTimer,
      hideScrubCanvas,
      readCurrentCutTime,
      startPlaybackFreezeWatchdog,
      stopPlaybackFreezeWatchdog,
    ]);

    const pauseLocalPlayback = useCallback(() => {
      isPlayingRef.current = false;
      playAttemptPendingRef.current = false;
      pendingLocalPlayRef.current = false;
      autoMutedFallbackRef.current = false;
      setAutoMutedFallback(false);
      clearCanPlayWaitTimer();
      stopPlaybackFreezeWatchdog();
      const vid = localVideoRef.current;
      if (vid && !vid.paused) {
        try {
          vid.pause();
        } catch {
          // ignore
        }
      }
      onPlayingChangeRef.current(false);
    }, [clearCanPlayWaitTimer, stopPlaybackFreezeWatchdog]);

    const seekLocalToCutTime = useCallback(
      (targetCut: number, opts?: { force?: boolean }) => {
        if (sourcePreviewOverrideRef.current !== null) return;
        const curScenes = scenesRef.current;
        const { sceneIndex, sourceSec } = mapCutTimeToSource(curScenes, targetCut);
        activeSceneIdxRef.current = sceneIndex;

        const vid = localVideoRef.current;
        if (!vid) return;

        if (vid.readyState < 1) {
          pendingLocalSeekRef.current = sourceSec;
          return;
        }

        const actualDur =
          Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : sourceSec + 10;
        const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.02), sourceSec));
        const threshold = opts?.force
          ? 0.01
          : isScrubbingRef.current
            ? lastSeekDurationMsRef.current > 80
              ? 0.06
              : 0.03
            : isPlayingRef.current
              ? 0.12
              : 0.015;

        if (Math.abs(vid.currentTime - clamped) <= threshold && !vid.seeking) {
          pendingLocalSeekRef.current = null;
          return;
        }

        const now = performance.now();
        if (!opts?.force) {
          // Allow long-GOP (e.g. 8s keyframe interval) mobile hardware seeks to complete and paint
          // instead of aborting mid-decode.
          const seekInFlight =
            vid.seeking &&
            lastLocalSeekIssuedAtRef.current > 0 &&
            now - lastLocalSeekIssuedAtRef.current < 2500;
          if (seekInFlight || waitingForScrubPaintRef.current) {
            pendingLocalSeekRef.current = clamped;
            return;
          }
        }

        cancelScrubFlush();
        pendingLocalSeekRef.current = null;
        issueVideoSeek(vid, clamped);
      },
      [cancelScrubFlush, issueVideoSeek]
    );

    useImperativeHandle(
      ref,
      () => ({
        play: () => {
          startLocalPlayback();
        },
        pause: () => {
          pauseLocalPlayback();
        },
        togglePlay: () => {
          const vid = localVideoRef.current;
          if (!vid || vid.paused || vid.ended || vid.error) {
            startLocalPlayback();
          } else {
            pauseLocalPlayback();
          }
        },
        setScrubbing: (active: boolean) => {
          isScrubbingRef.current = active;
          setIsScrubbing(active);
          if (active) {
            pendingLocalPlayRef.current = false;
            playAttemptPendingRef.current = false;
            stopPlaybackFreezeWatchdog();
            const vid = localVideoRef.current;
            if (vid) {
              paintScrubCanvasFrame(vid, true);
              if (!vid.paused) {
                try {
                  vid.pause();
                } catch {
                  // ignore
                }
              }
            }
          } else {
            cancelScrubFlush();
            hideScrubCanvas();
          }
        },
        seekCutTime: (cutSec: number, opts?: { force?: boolean }) => {
          seekLocalToCutTime(cutSec, opts);
        },
        previewSourceTime: (sourceSec: number | null, opts?: { skipResync?: boolean }) => {
          const vid = localVideoRef.current;
          if (sourceSec !== null && Number.isFinite(sourceSec)) {
            sourcePreviewOverrideRef.current = sourceSec;
            pendingLocalPlayRef.current = false;
            playAttemptPendingRef.current = false;
            if (vid && !vid.paused) {
              try {
                vid.pause();
              } catch {
                // ignore
              }
            }
            pendingPreviewSeekRef.current = sourceSec;
            if (previewSeekRafRef.current === null) {
              previewSeekRafRef.current = requestAnimationFrame(() => {
                previewSeekRafRef.current = null;
                const v = localVideoRef.current;
                if (v) flushLocalPreviewSeek(v);
              });
            }
            return;
          }

          sourcePreviewOverrideRef.current = null;
          pendingPreviewSeekRef.current = null;
          hideScrubCanvas();
          cancelPreviewSeekRaf();
          if (opts?.skipResync || !vid) return;

          const { sceneIndex, sourceSec: cutSourceSec } = mapCutTimeToSource(
            scenesRef.current,
            readCurrentCutTime()
          );
          activeSceneIdxRef.current = sceneIndex;
          if (vid.readyState >= 1) {
            const actualDur =
              Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : cutSourceSec + 10;
            const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.05), cutSourceSec));
            if (Math.abs(vid.currentTime - clamped) > 0.04) {
              seekSettleUntilRef.current = performance.now() + 650;
              try {
                vid.currentTime = clamped;
              } catch {
                // ignore
              }
            }
            pendingLocalSeekRef.current = null;
          } else {
            pendingLocalSeekRef.current = cutSourceSec;
          }
        },
      }),
      [
        startLocalPlayback,
        pauseLocalPlayback,
        seekLocalToCutTime,
        cancelPreviewSeekRaf,
        cancelScrubFlush,
        flushLocalPreviewSeek,
        hideScrubCanvas,
        paintScrubCanvasFrame,
        stopPlaybackFreezeWatchdog,
        readCurrentCutTime,
      ]
    );

    // Reset initial position when source or scenes change (without interrupting active playback or scrubbing)
    useEffect(() => {
      if (
        isPlayingRef.current ||
        isScrubbingRef.current ||
        playAttemptPendingRef.current ||
        pendingLocalPlayRef.current
      ) {
        return;
      }
      if (sourcePreviewOverrideRef.current !== null) return;
      const { sceneIndex, sourceSec } = mapCutTimeToSource(scenes, readCurrentCutTime());
      activeSceneIdxRef.current = sceneIndex;

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
    }, [localUrl, scenes, readCurrentCutTime]);

    // Explicit user seek (scrubber drag, clicking subtitle card, or clicking scene chip)
    useEffect(() => {
      if (seekNonce === 0) return;
      seekLocalToCutTime(readCurrentCutTime());
    }, [seekNonce, readCurrentCutTime, seekLocalToCutTime]);

    // Sync local HTML5 video settings & attach WebAudio ONLY when voice effects are active
    useEffect(() => {
      const vid = localVideoRef.current;
      if (!vid) return;
      if ((!autoMutedFallbackRef.current || muted) && vid.muted !== muted) {
        vid.muted = muted;
      }
      const targetRate = getEffectivePlaybackSpeed(
        editSettings.playbackSpeed,
        voiceSettings.speed
      );
      applySafePlaybackRate(vid, targetRate);
      if (hasVoiceEffects || voiceAttachedRef.current) {
        voiceAttachedRef.current = true;
        applyVoiceEffectsToVideoElement(vid, voiceSettings, isPlaying);
      }

      if (isPlaying) {
        if (
          !isScrubbingRef.current &&
          vid.paused &&
          !playAttemptPendingRef.current &&
          !pendingLocalPlayRef.current
        ) {
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
    }, [
      isPlaying,
      muted,
      voiceSettings,
      editSettings.playbackSpeed,
      hasVoiceEffects,
      startLocalPlayback,
    ]);

    // Master player-driven 60fps clock for Local <video> (directly tracks vid.currentTime)
    useEffect(() => {
      if (!isPlaying) return;
      let rafId = 0;

      const tick = () => {
        const vid = localVideoRef.current;
        const fallbackDur =
          vid && Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 30;
        const curScenes =
          scenesRef.current.length > 0
            ? scenesRef.current
            : [
                {
                  index: 0,
                  startSec: 0,
                  endSec: fallbackDur,
                  durationSec: fallbackDur,
                  summary: "Full video",
                },
              ];
        if (
          vid &&
          curScenes.length > 0 &&
          sourcePreviewOverrideRef.current === null &&
          !isScrubbingRef.current &&
          !vid.paused &&
          !vid.seeking &&
          vid.readyState >= 1
        ) {
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
    }, [isPlaying]);

    const applyPendingLocalSeekAndPlay = useCallback(
      (vid: HTMLVideoElement, allowLowReadyState = false) => {
        if (sourcePreviewOverrideRef.current !== null) {
          flushLocalPreviewSeek(vid);
          return;
        }
        const target = pendingLocalSeekRef.current;
        if (target !== null && vid.readyState >= 1) {
          const actualDur =
            Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : target + 1;
          const clamped = Math.max(0, Math.min(Math.max(0, actualDur - 0.02), target));
          pendingLocalSeekRef.current = null;
          const threshold = isScrubbingRef.current ? 0.025 : 0.015;
          if (Math.abs(vid.currentTime - clamped) > threshold) {
            issueVideoSeek(vid, clamped);
            return;
          }
        }
        const targetRate = getEffectivePlaybackSpeed(
          editSettingsRef.current.playbackSpeed,
          voiceSettingsRef.current.speed
        );
        applySafePlaybackRate(vid, targetRate);
        if (
          pendingLocalPlayRef.current &&
          isPlayingRef.current &&
          !isScrubbingRef.current &&
          vid.paused &&
          !vid.seeking &&
          vid.readyState >= 1
        ) {
          // Prefer waiting briefly for HAVE_FUTURE_DATA (readyState >= 3) after a seek/load
          // so MediaCodec has decoded future frames before audio starts running.
          if (!allowLowReadyState && vid.readyState < 3) {
            clearCanPlayWaitTimer();
            canPlayWaitTimerRef.current = window.setTimeout(() => {
              canPlayWaitTimerRef.current = null;
              const cur = localVideoRef.current;
              if (cur && pendingLocalPlayRef.current && isPlayingRef.current && !isScrubbingRef.current) {
                applyPendingLocalSeekAndPlay(cur, true);
              }
            }, 320);
            return;
          }
          clearCanPlayWaitTimer();
          pendingLocalPlayRef.current = false;
          playAttemptPendingRef.current = true;
          vid
            .play()
            .then(() => {
              playAttemptPendingRef.current = false;
              onPlayingChangeRef.current(!vid.paused);
              if (!vid.paused) {
                startPlaybackFreezeWatchdog(vid, vid.currentTime);
              }
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
                    if (!vid.paused) {
                      startPlaybackFreezeWatchdog(vid, vid.currentTime);
                    }
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
      },
      [clearCanPlayWaitTimer, flushLocalPreviewSeek, issueVideoSeek, startPlaybackFreezeWatchdog]
    );

    const transformCss = buildCssTransformString(editSettings);
    const filterCss = buildCssFilterString(editSettings);
    const safeVignette =
      typeof editSettings.vignette === "number" && Number.isFinite(editSettings.vignette)
        ? editSettings.vignette
        : 0;
    const vignetteOpacity = Math.max(0, Math.min(1, safeVignette / 100));

    if (!localUrl) {
      return (
        <div className="relative w-full h-full flex items-center justify-center p-4 bg-[#0b0f17] text-center">
          <p className="text-xs text-[#8e9aaf] leading-relaxed max-w-[240px]">
            Local video file is not linked. Link or re-upload the video in the Projects tab to preview.
          </p>
        </div>
      );
    }

    const fittedLocalVideoSize =
      localVideoDims && localViewportDims && localVideoDims.w > 0 && localVideoDims.h > 0
        ? (() => {
            const baseScale =
              editSettings.fitMode === "contain"
                ? Math.min(
                    localViewportDims.w / localVideoDims.w,
                    localViewportDims.h / localVideoDims.h
                  )
                : Math.max(
                    localViewportDims.w / localVideoDims.w,
                    localViewportDims.h / localVideoDims.h
                  );
            return {
              w: localVideoDims.w * baseScale,
              h: localVideoDims.h * baseScale,
            };
          })()
        : null;

    return (
      <div
        ref={localStageRef}
        onClick={() => {
          const vid = localVideoRef.current;
          if (!vid || vid.paused || vid.ended || vid.error) startLocalPlayback();
          else pauseLocalPlayback();
        }}
        className="relative w-full h-full overflow-hidden bg-[#111111] cursor-pointer group"
      >
        <div
          className="absolute inset-0 flex items-center justify-center origin-center pointer-events-none"
          style={{
            ...(transformCss !== "none" ? { transform: transformCss } : {}),
            ...(filterCss !== "none" ? { filter: filterCss } : {}),
          }}
        >
          <video
            key={localUrl}
            ref={localVideoRef}
            src={localUrl}
            preload="auto"
            playsInline
            disablePictureInPicture
            disableRemotePlayback
            muted={muted || autoMutedFallback}
            onLoadedData={() => {
              setLocalPlayError(null);
            }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0) {
                setLocalVideoDims({ w: v.videoWidth, h: v.videoHeight });
              }
              setLocalPlayError(null);
              applyPendingLocalSeekAndPlay(v);
            }}
            onCanPlay={(e) => {
              const v = e.currentTarget;
              if (!localVideoDims && v.videoWidth > 0 && v.videoHeight > 0) {
                setLocalVideoDims({ w: v.videoWidth, h: v.videoHeight });
              }
              setLocalPlayError(null);
              // Never preempt an active scrub seek or frame paint when readyState bounces on canplay
              if (isScrubbingRef.current || waitingForScrubPaintRef.current || v.seeking) {
                return;
              }
              applyPendingLocalSeekAndPlay(v);
            }}
            onSeeked={(e) => {
              const v = e.currentTarget;
              if (lastLocalSeekIssuedAtRef.current > 0) {
                const seekMs = Math.max(0, performance.now() - lastLocalSeekIssuedAtRef.current);
                lastSeekDurationMsRef.current =
                  lastSeekDurationMsRef.current > 0
                    ? lastSeekDurationMsRef.current * 0.6 + seekMs * 0.4
                    : seekMs;
              }
              lastLocalSeekIssuedAtRef.current = 0;
              seekSettleUntilRef.current = 0;
              const showingScrubCanvas =
                isScrubbingRef.current || sourcePreviewOverrideRef.current !== null;
              if (showingScrubCanvas) {
                // During active scrubbing, drawing into scrub canvas forces Android Chrome's
                // SurfaceTexture to flush immediately so the decoded frame visibly updates.
                paintScrubCanvasFrame(v, true);
                capturePassiveThumbFromVideo(localUrlRef.current, v, false);
              } else {
                hideScrubCanvas();
              }
              if (sourcePreviewOverrideRef.current !== null) {
                scheduleScrubPaintThenFlush(v, (curVid) => {
                  flushLocalPreviewSeek(curVid);
                });
                return;
              }
              // During live scrubbing, wait for the newly decoded frame to actually present
              // to the display before issuing the next queued seek.
              if (isScrubbingRef.current || (pendingLocalSeekRef.current !== null && !isPlayingRef.current)) {
                scheduleScrubPaintThenFlush(v, (curVid) => {
                  if (pendingLocalSeekRef.current !== null) {
                    applyPendingLocalSeekAndPlay(curVid);
                  }
                });
                return;
              }
              applyPendingLocalSeekAndPlay(v);
            }}
            onPlay={(e) => {
              const v = e.currentTarget;
              setLocalPlayError(null);
              hideScrubCanvas();
              clearCanPlayWaitTimer();
              reloadAttemptedRef.current = false;
              playAttemptPendingRef.current = false;
              pendingLocalPlayRef.current = false;
              if (hasVoiceEffectsRef.current || voiceAttachedRef.current) {
                resumeAllVoiceContexts();
                voiceAttachedRef.current = true;
                applyVoiceEffectsToVideoElement(v, voiceSettingsRef.current, true);
              }
              const nextRate = getEffectivePlaybackSpeed(
                editSettingsRef.current.playbackSpeed,
                voiceSettingsRef.current.speed
              );
              applySafePlaybackRate(v, nextRate);
              if (!isPlayingRef.current) {
                onPlayingChangeRef.current(true);
              }
              if (!v.paused && !isScrubbingRef.current) {
                startPlaybackFreezeWatchdog(v, v.currentTime);
              }
            }}
            onPause={(e) => {
              const v = e.currentTarget;
              stopPlaybackFreezeWatchdog();
              if (!isScrubbingRef.current && !v.seeking && v.readyState >= 2) {
                capturePassiveThumbFromVideo(localUrlRef.current, v, false);
              }
              if (
                v.seeking ||
                v.ended ||
                isScrubbingRef.current ||
                playAttemptPendingRef.current ||
                pendingLocalPlayRef.current
              ) {
                return;
              }
              if (isPlayingRef.current) {
                onPlayingChangeRef.current(false);
              }
            }}
            onEnded={() => {
              clearCanPlayWaitTimer();
              stopPlaybackFreezeWatchdog();
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
              clearCanPlayWaitTimer();
              stopPlaybackFreezeWatchdog();
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
            style={
              fittedLocalVideoSize
                ? {
                    width: `${Math.round(fittedLocalVideoSize.w)}px`,
                    height: `${Math.round(fittedLocalVideoSize.h)}px`,
                    maxWidth: "none",
                    maxHeight: "none",
                  }
                : undefined
            }
            className={
              fittedLocalVideoSize
                ? "block shrink-0 bg-[#111111]"
                : `w-full h-full bg-[#111111] ${
                    editSettings.fitMode === "contain" ? "object-contain" : "object-cover"
                  }`
            }
          />
          <canvas
            ref={scrubCanvasRef}
            aria-hidden="true"
            style={
              fittedLocalVideoSize
                ? {
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: `${Math.round(fittedLocalVideoSize.w)}px`,
                    height: `${Math.round(fittedLocalVideoSize.h)}px`,
                    maxWidth: "none",
                    maxHeight: "none",
                    transform: "translate(-50%, -50%)",
                    display:
                      isScrubbing || sourcePreviewOverrideRef.current !== null ? "block" : "none",
                    opacity: isScrubbing || sourcePreviewOverrideRef.current !== null ? 1 : 0,
                    pointerEvents: "none",
                  }
                : {
                    display:
                      isScrubbing || sourcePreviewOverrideRef.current !== null ? "block" : "none",
                    opacity: isScrubbing || sourcePreviewOverrideRef.current !== null ? 1 : 0,
                    pointerEvents: "none",
                  }
            }
            className={
              fittedLocalVideoSize
                ? "block"
                : `absolute inset-0 w-full h-full ${
                    editSettings.fitMode === "contain" ? "object-contain" : "object-cover"
                  }`
            }
          />
        </div>
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
        {!isPlaying && !isScrubbing && (
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
  })
);
