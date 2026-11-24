import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { LocateFixed } from "lucide-react";
import type { AutoFollowState } from "../utils/subtitleState";

export interface SubtitleListViewportHandle {
  scrollToSubtitle: (id: string, behavior?: ScrollBehavior) => void;
  registerItemElement: (id: string, el: HTMLElement | null) => void;
}

interface SubtitleListViewportProps {
  playingSubtitleId: string | null;
  autoFollowState: AutoFollowState;
  onChangeAutoFollowState: (next: AutoFollowState) => void;
  children: ReactNode;
  className?: string;
}

export const SubtitleListViewport = forwardRef<
  SubtitleListViewportHandle,
  SubtitleListViewportProps
>(function SubtitleListViewport(
  {
    playingSubtitleId,
    autoFollowState,
    onChangeAutoFollowState,
    children,
    className = "",
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemElementsRef = useRef<Record<string, HTMLElement | null>>({});
  const programmaticScrollUntilRef = useRef<number>(0);
  const lastScrollTopRef = useRef<number>(0);
  const lastFollowedSubIdRef = useRef<string | null>(null);

  const autoFollowStateRef = useRef(autoFollowState);
  autoFollowStateRef.current = autoFollowState;
  const onChangeAutoFollowStateRef = useRef(onChangeAutoFollowState);
  onChangeAutoFollowStateRef.current = onChangeAutoFollowState;

  const scrollToSubtitle = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      const el = itemElementsRef.current[id];
      if (!container || !el) return;

      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (cRect.height <= 0) return;

      const topDelta = eRect.top - cRect.top;
      const bottomDelta = eRect.bottom - cRect.bottom;
      const paddingPx = 8;

      let nextScrollTop: number | null = null;
      if (topDelta < paddingPx || eRect.height >= cRect.height - paddingPx * 2) {
        if (Math.abs(topDelta - paddingPx) > 1) {
          nextScrollTop = Math.max(0, container.scrollTop + topDelta - paddingPx);
        }
      } else if (bottomDelta > -paddingPx) {
        nextScrollTop = Math.max(0, container.scrollTop + bottomDelta + paddingPx);
      }

      if (nextScrollTop !== null && Math.abs(nextScrollTop - container.scrollTop) > 1) {
        programmaticScrollUntilRef.current = Date.now() + 700;
        lastScrollTopRef.current = nextScrollTop;
        try {
          container.scrollTo({
            top: nextScrollTop,
            behavior,
          });
        } catch {
          container.scrollTop = nextScrollTop;
        }
      }
    },
    []
  );

  const registerItemElement = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      itemElementsRef.current[id] = el;
    } else {
      delete itemElementsRef.current[id];
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToSubtitle,
      registerItemElement,
    }),
    [scrollToSubtitle, registerItemElement]
  );

  // Follow active playback row when in "following" state
  useEffect(() => {
    if (autoFollowState !== "following") {
      lastFollowedSubIdRef.current = playingSubtitleId;
      return;
    }
    if (!playingSubtitleId) return;
    if (lastFollowedSubIdRef.current === playingSubtitleId) return;
    lastFollowedSubIdRef.current = playingSubtitleId;

    const rafId = requestAnimationFrame(() => {
      if (autoFollowStateRef.current === "following") {
        scrollToSubtitle(playingSubtitleId, "smooth");
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [playingSubtitleId, autoFollowState, scrollToSubtitle]);

  const markManualScroll = useCallback(() => {
    programmaticScrollUntilRef.current = 0;
    if (autoFollowStateRef.current === "following") {
      onChangeAutoFollowStateRef.current("paused_by_scroll");
    }
  }, []);

  const handleContainerScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const currentTop = container.scrollTop;
    const moved = Math.abs(currentTop - lastScrollTopRef.current) > 2;
    lastScrollTopRef.current = currentTop;

    if (Date.now() <= programmaticScrollUntilRef.current) {
      return;
    }
    if (moved && autoFollowStateRef.current === "following") {
      onChangeAutoFollowStateRef.current("paused_by_scroll");
    }
  }, []);

  const handleResumeFollow = useCallback(() => {
    onChangeAutoFollowState("following");
    if (playingSubtitleId) {
      lastFollowedSubIdRef.current = playingSubtitleId;
      requestAnimationFrame(() => {
        scrollToSubtitle(playingSubtitleId, "smooth");
      });
    }
  }, [onChangeAutoFollowState, playingSubtitleId, scrollToSubtitle]);

  return (
    <div
      ref={containerRef}
      onWheel={markManualScroll}
      onTouchMove={markManualScroll}
      onScroll={handleContainerScroll}
      className={`relative flex-1 min-h-0 overflow-y-auto overscroll-y-contain studio-scrollbar [overflow-anchor:auto] ${className}`}
    >
      {children}

      {autoFollowState === "paused_by_scroll" && (
        <div className="sticky bottom-3 z-20 pointer-events-none flex justify-center py-1">
          <button
            type="button"
            onClick={handleResumeFollow}
            className="pointer-events-auto h-7 px-3 rounded-full shadow-md border border-teal-800/20 dark:border-teal-300/30 bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <LocateFixed className="w-3 h-3" />
            <span>Resume Follow</span>
          </button>
        </div>
      )}
    </div>
  );
});
