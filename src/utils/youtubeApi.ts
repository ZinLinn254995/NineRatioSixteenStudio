let ytApiPromise: Promise<void> | null = null;

export function loadYouTubeIframeAPI(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube player requires a browser environment."));
  }
  if (window.YT?.Player) {
    return Promise.resolve();
  }
  if (ytApiPromise) {
    return ytApiPromise;
  }

  ytApiPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;

    const cleanup = () => {
      if (pollTimer) window.clearInterval(pollTimer);
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      ytApiPromise = null;
      reject(err);
    };

    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        if (prevReady) prevReady();
      } catch {
        // ignore previous callback errors
      }
      if (window.YT?.Player) {
        finishResolve();
      }
    };

    // Poll in case YT.Player becomes available without firing our chained callback
    pollTimer = window.setInterval(() => {
      if (window.YT?.Player) {
        finishResolve();
      }
    }, 100);

    timeoutTimer = window.setTimeout(() => {
      if (window.YT?.Player) {
        finishResolve();
      } else {
        finishReject(new Error("YouTube player API timed out while loading."));
      }
    }, 12000);

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]'
    );
    if (!existingScript) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      tag.onerror = () => {
        tag.remove();
        finishReject(new Error("Could not load YouTube player script."));
      };
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}
