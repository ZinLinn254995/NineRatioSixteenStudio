import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Film, Loader2 } from "lucide-react";
import type { ActiveMediaSource, YouTubeVideo } from "../types";
import { loadYouTubeIframeAPI } from "../utils/youtubeApi";

interface YTPreviewPlayer {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  pauseVideo?: () => void;
  setPlaybackRate?: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getIframe?: () => HTMLIFrameElement;
  destroy: () => void;
}

export interface YouTubePlayerInstanceGuard {
  nextToken: () => number;
  isCurrent: (token: number) => boolean;
  invalidate: () => number;
  getCurrentToken: () => number;
}

/**
 * Pure monotonic instance token guard ensuring stale async YouTube IFrame callbacks
 * or cleanups can never mutate, play, or destroy a newer player instance.
 */
export function createYouTubePlayerInstanceGuard(): YouTubePlayerInstanceGuard {
  let token = 0;
  return {
    nextToken: () => {
      token += 1;
      return token;
    },
    isCurrent: (candidate: number) => candidate > 0 && candidate === token,
    invalidate: () => {
      token += 1;
      return token;
    },
    getCurrentToken: () => token,
  };
}

interface YouTubePreviewPanelProps {
  media: ActiveMediaSource | null;
  videos: YouTubeVideo[];
  hasMoreVideos: boolean;
  isLoadingMore: boolean;
  isSearching: boolean;
  isWorkspaceVisible?: boolean;
  initialSec?: number;
  seekRequest?: { sec: number; nonce: number } | null;
  onSelectPreviewVideo: (video: YouTubeVideo) => void;
  onLoadMoreVideos: () => void;
  onCurrentSecChange?: (sec: number) => void;
  onDetectedDuration?: (dur: number) => void;
}

export function YouTubePreviewPanel({
  media,
  videos,
  hasMoreVideos,
  isLoadingMore,
  isSearching,
  isWorkspaceVisible = true,
  initialSec = 0,
  seekRequest,
  onSelectPreviewVideo,
  onLoadMoreVideos,
  onCurrentSecChange,
  onDetectedDuration,
}: YouTubePreviewPanelProps) {
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YTPreviewPlayer | null>(null);
  const ytReadyRef = useRef(false);
  const instanceGuardRef = useRef<YouTubePlayerInstanceGuard>(createYouTubePlayerInstanceGuard());
  const savedTimeRef = useRef<number>(initialSec > 0 ? initialSec : 0);
  const pendingSeekRef = useRef<number | null>(initialSec > 0 ? initialSec : null);
  const pendingNextAfterLoadRef = useRef(false);

  const [copiedLink, setCopiedLink] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);

  const onCurrentSecChangeRef = useRef(onCurrentSecChange);
  onCurrentSecChangeRef.current = onCurrentSecChange;
  const onDetectedDurationRef = useRef(onDetectedDuration);
  onDetectedDurationRef.current = onDetectedDuration;

  const youtubeUrl =
    media?.sourceType === "youtube" && media.videoId
      ? `https://www.youtube.com/watch?v=${media.videoId}`
      : "";

  const currentIndex =
    media?.videoId ? videos.findIndex((v) => v.videoId === media.videoId) : -1;

  const canPrev = currentIndex > 0;
  const canNext =
    (currentIndex >= 0 && currentIndex < videos.length - 1) ||
    (currentIndex === -1 && videos.length > 0) ||
    hasMoreVideos;

  useEffect(() => {
    setCopiedLink(false);
    const startSec = initialSec > 0 ? initialSec : 0;
    savedTimeRef.current = startSec;
    pendingSeekRef.current = startSec > 0 ? startSec : null;
  }, [media?.videoId]);

  useEffect(() => {
    if (!pendingNextAfterLoadRef.current) return;
    if (currentIndex >= 0 && currentIndex < videos.length - 1) {
      pendingNextAfterLoadRef.current = false;
      onSelectPreviewVideo(videos[currentIndex + 1]);
    } else if (!isLoadingMore && !hasMoreVideos) {
      pendingNextAfterLoadRef.current = false;
    }
  }, [videos, currentIndex, isLoadingMore, hasMoreVideos, onSelectPreviewVideo]);

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

  const handlePrevious = () => {
    pendingNextAfterLoadRef.current = false;
    if (currentIndex > 0) {
      onSelectPreviewVideo(videos[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < videos.length - 1) {
      pendingNextAfterLoadRef.current = false;
      onSelectPreviewVideo(videos[currentIndex + 1]);
    } else if (currentIndex === -1 && videos.length > 0) {
      pendingNextAfterLoadRef.current = false;
      onSelectPreviewVideo(videos[0]);
    } else if (hasMoreVideos && !isLoadingMore) {
      pendingNextAfterLoadRef.current = true;
      onLoadMoreVideos();
    }
  };

  useEffect(() => {
    const guard = instanceGuardRef.current;

    // When workspace is hidden or no YouTube video is active, safely pause & tear down
    // the active iframe instance while preserving the current playback timestamp.
    if (!isWorkspaceVisible || !media || media.sourceType !== "youtube" || !media.videoId || !ytHostRef.current) {
      if (ytPlayerRef.current && ytReadyRef.current) {
        try {
          const t = ytPlayerRef.current.getCurrentTime?.();
          if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
            savedTimeRef.current = t;
            onCurrentSecChangeRef.current?.(Math.floor(t));
          }
        } catch {
          // ignore
        }
      }
      guard.invalidate();
      ytReadyRef.current = false;
      const existing = ytPlayerRef.current;
      ytPlayerRef.current = null;
      if (existing) {
        try {
          existing.pauseVideo?.();
          existing.destroy();
        } catch {
          // ignore
        }
      }
      if (ytHostRef.current) {
        ytHostRef.current.innerHTML = "";
      }
      return;
    }

    const myToken = guard.nextToken();
    let localPlayer: YTPreviewPlayer | null = null;
    let localReady = false;

    ytReadyRef.current = false;
    setYtError(null);
    const mountEl = document.createElement("div");
    mountEl.className = "w-full h-full";
    ytHostRef.current.innerHTML = "";
    ytHostRef.current.appendChild(mountEl);

    loadYouTubeIframeAPI()
      .then(() => {
        if (!guard.isCurrent(myToken) || !window.YT?.Player) return;
        const startAt =
          pendingSeekRef.current !== null
            ? pendingSeekRef.current
            : savedTimeRef.current > 0
              ? savedTimeRef.current
              : initialSec;
        const playerVars: Record<string, string | number> = {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          ...(startAt > 0.5 ? { start: Math.floor(startAt) } : {}),
        };
        if (window.location.origin.startsWith("http")) {
          playerVars.origin = window.location.origin;
        }
        const created = new window.YT.Player(mountEl, {
          width: "100%",
          height: "100%",
          videoId: media.videoId!,
          playerVars,
          events: {
            onReady: (e) => {
              if (!guard.isCurrent(myToken)) {
                try {
                  e.target.pauseVideo?.();
                  created.destroy();
                } catch {
                  // ignore
                }
                return;
              }
              localReady = true;
              ytReadyRef.current = true;
              try {
                const iframe = e.target.getIframe?.();
                if (iframe) {
                  iframe.style.width = "100%";
                  iframe.style.height = "100%";
                }
              } catch {
                // ignore
              }
              const d = e.target.getDuration?.();
              if (d && Number.isFinite(d) && d > 0) {
                onDetectedDurationRef.current?.(Math.round(d));
              }
              // Position is already cued at playerVars.start with autoplay: 0;
              // avoid calling seekTo on mount/recreate so YouTube never autoplays unexpectedly.
              pendingSeekRef.current = null;
            },
            onError: (e) => {
              if (!guard.isCurrent(myToken)) return;
              if (e.data === 101 || e.data === 150) {
                setYtError("Video owner disabled embedded playback. Try Next video or another clip.");
              } else {
                setYtError("YouTube player could not load this video.");
              }
            },
          },
        }) as unknown as YTPreviewPlayer;

        localPlayer = created;
        if (!guard.isCurrent(myToken)) {
          try {
            created.pauseVideo?.();
            created.destroy();
          } catch {
            // ignore
          }
          localPlayer = null;
          return;
        }
        ytPlayerRef.current = created;
      })
      .catch(() => {
        if (guard.isCurrent(myToken)) {
          setYtError("Could not initialize YouTube player.");
        }
      });

    const interval = setInterval(() => {
      if (!guard.isCurrent(myToken) || !localReady || !localPlayer) return;
      try {
        const t = localPlayer.getCurrentTime?.();
        if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
          savedTimeRef.current = t;
          onCurrentSecChangeRef.current?.(Math.floor(t));
        }
      } catch {
        // ignore
      }
    }, 300);

    return () => {
      clearInterval(interval);
      if (localReady && localPlayer) {
        try {
          const t = localPlayer.getCurrentTime?.();
          if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
            savedTimeRef.current = t;
            onCurrentSecChangeRef.current?.(Math.floor(t));
          }
        } catch {
          // ignore
        }
      }
      if (guard.isCurrent(myToken)) {
        guard.invalidate();
        ytReadyRef.current = false;
      }
      if (ytPlayerRef.current === localPlayer) {
        ytPlayerRef.current = null;
      }
      if (localPlayer) {
        try {
          localPlayer.pauseVideo?.();
          localPlayer.destroy();
        } catch {
          // ignore
        }
      }
    };
  }, [media?.sourceType, media?.videoId, isWorkspaceVisible]);

  useEffect(() => {
    if (!seekRequest) return;
    savedTimeRef.current = seekRequest.sec;
    if (isWorkspaceVisible && ytReadyRef.current && ytPlayerRef.current) {
      try {
        ytPlayerRef.current.seekTo(seekRequest.sec, true);
        onCurrentSecChangeRef.current?.(Math.floor(seekRequest.sec));
      } catch {
        // ignore
      }
    } else {
      pendingSeekRef.current = seekRequest.sec;
    }
  }, [seekRequest, isWorkspaceVisible]);

  const matchedVideo = currentIndex >= 0 ? videos[currentIndex] : undefined;
  const licenseText =
    matchedVideo?.license === "creative_commons"
      ? "Creative Commons"
      : matchedVideo?.license === "standard"
        ? "Standard License"
        : null;

  if (!media || media.sourceType !== "youtube" || !media.videoId) {
    return (
      <div className="w-full">
        <div className="w-full aspect-video rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex flex-col items-center justify-center text-center p-6 gap-2.5 text-neutral-500 dark:text-neutral-400">
          {isSearching ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <p className="text-xs">Loading recommended video...</p>
            </>
          ) : (
            <>
              <Film className="w-6 h-6 opacity-60" />
              <p className="text-xs">
                No YouTube video selected. Search above or choose one from the list.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-3">
      {/* 16:9 YouTube Preview Stage */}
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-neutral-950 border border-neutral-200 dark:border-neutral-800">
        <div ref={ytHostRef} className="w-full h-full" />
        {ytError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 bg-black/80 text-center">
            <p className="text-xs text-white leading-relaxed max-w-xs">{ytError}</p>
            {canNext && (
              <button
                type="button"
                onClick={handleNext}
                className="h-8 px-3 rounded-lg bg-white text-neutral-950 text-xs font-medium hover:bg-neutral-200 transition-colors cursor-pointer"
              >
                Skip to Next Video
              </button>
            )}
          </div>
        )}
      </div>

      {/* Video Info & Transport Controls */}
      <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/70 space-y-3">
        <div className="min-w-0">
          <h2 className="text-sm sm:text-[15px] font-semibold text-neutral-950 dark:text-neutral-50 leading-snug line-clamp-2">
            {media.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="truncate max-w-[220px]">{media.channel}</span>
            {matchedVideo?.durationText && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular shrink-0">{matchedVideo.durationText}</span>
              </>
            )}
            {licenseText && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{licenseText}</span>
              </>
            )}
            {youtubeUrl && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular truncate max-w-[240px]">{youtubeUrl}</span>
              </>
            )}
          </div>
        </div>

        <div className="pt-2.5 border-t border-neutral-200/80 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono-tabular text-neutral-500 dark:text-neutral-400">
            {currentIndex >= 0 && videos.length > 0
              ? `Video ${currentIndex + 1} of ${videos.length}`
              : "YouTube Preview"}
          </span>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handlePrevious}
              disabled={!canPrev}
              aria-label="Previous YouTube video"
              className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-neutral-800 dark:text-neutral-200"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </button>

            <button
              type="button"
              onClick={handleNext}
              disabled={!canNext || isLoadingMore}
              aria-label="Next YouTube video"
              className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-neutral-800 dark:text-neutral-200"
            >
              {isLoadingMore && pendingNextAfterLoadRef.current ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>

            {youtubeUrl && (
              <button
                type="button"
                onClick={handleCopyLink}
                className={`h-9 px-3.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors border ${
                  copiedLink
                    ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                    : "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                }`}
              >
                {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedLink ? "Copied" : "Copy Link"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
