interface YTPreviewPlayerInstance {
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
            onReady?: (e: { target: YTPreviewPlayerInstance }) => void;
            onStateChange?: (e: { data: number }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPreviewPlayerInstance;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export {};
