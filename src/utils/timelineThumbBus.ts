export interface PassiveTimelineThumb {
  sourceSec: number;
  url: string;
}

interface UrlThumbStore {
  aspect: number;
  byBucket: Map<number, PassiveTimelineThumb>;
  lastCaptureAt: number;
  listeners: Set<() => void>;
}

const storesByUrl = new Map<string, UrlThumbStore>();
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;

function getOrCreateStore(localUrl: string): UrlThumbStore {
  let store = storesByUrl.get(localUrl);
  if (!store) {
    // Keep memory bounded if the user switches between many videos in one session
    if (storesByUrl.size > 16) {
      const oldestKey = storesByUrl.keys().next().value;
      if (oldestKey) storesByUrl.delete(oldestKey);
    }
    store = {
      aspect: 9 / 16,
      byBucket: new Map(),
      lastCaptureAt: 0,
      listeners: new Set(),
    };
    storesByUrl.set(localUrl, store);
  }
  return store;
}

export function getPassiveTimelineThumbs(localUrl: string): {
  aspect: number;
  frames: PassiveTimelineThumb[];
} {
  const store = storesByUrl.get(localUrl);
  if (!store) {
    return { aspect: 9 / 16, frames: [] };
  }
  const frames = Array.from(store.byBucket.values()).sort(
    (a, b) => a.sourceSec - b.sourceSec
  );
  return { aspect: store.aspect, frames };
}

export function subscribePassiveTimelineThumbs(
  localUrl: string,
  listener: () => void
): () => void {
  const store = getOrCreateStore(localUrl);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/**
 * Passively captures a tiny filmstrip thumbnail from the ALREADY-DECODED primary <video>.
 * Never allocates a second <video> element or triggers extra seeks, preventing Android
 * MediaCodec hardware decoder contention and playback stalls.
 */
export function capturePassiveThumbFromVideo(
  localUrl: string | undefined,
  vid: HTMLVideoElement | null,
  force = false
): void {
  if (!localUrl || !vid || typeof document === "undefined") return;
  if (vid.readyState < 2 || vid.videoWidth <= 0 || vid.videoHeight <= 0) return;

  const store = getOrCreateStore(localUrl);
  const now = performance.now();
  if (!force && now - store.lastCaptureAt < 220) return;

  const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 30;
  const curSec = Number.isFinite(vid.currentTime) ? Math.max(0, vid.currentTime) : 0;
  // Cap to ~18 evenly spaced buckets across the entire video regardless of length
  const bucketSpanSec = Math.max(1.5, dur / 18);
  const bucket = Math.floor(curSec / bucketSpanSec);

  if (store.byBucket.has(bucket)) return;
  if (store.byBucket.size >= 24) return;

  const vw = vid.videoWidth;
  const vh = vid.videoHeight;
  const rawAspect = vw / vh;
  const clampedAspect = Math.max(0.5625, Math.min(1.78, rawAspect));
  const ch = 64;
  const cw = Math.max(36, Math.min(116, Math.round(ch * clampedAspect)));

  if (!sharedCanvas) {
    sharedCanvas = document.createElement("canvas");
    sharedCtx = sharedCanvas.getContext("2d");
  }
  if (!sharedCanvas || !sharedCtx) return;

  if (sharedCanvas.width !== cw || sharedCanvas.height !== ch) {
    sharedCanvas.width = cw;
    sharedCanvas.height = ch;
  }

  const targetRatio = cw / ch;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (rawAspect > targetRatio) {
    sw = vh * targetRatio;
    sx = (vw - sw) * 0.5;
  } else if (rawAspect < targetRatio) {
    sh = vw / targetRatio;
    sy = (vh - sh) * 0.5;
  }

  try {
    sharedCtx.imageSmoothingEnabled = true;
    sharedCtx.imageSmoothingQuality = "low";
    sharedCtx.drawImage(vid, sx, sy, sw, sh, 0, 0, cw, ch);
    const dataUrl = sharedCanvas.toDataURL("image/jpeg", 0.68);
    store.aspect = clampedAspect;
    store.lastCaptureAt = now;
    store.byBucket.set(bucket, { sourceSec: curSec, url: dataUrl });
    store.listeners.forEach((fn) => fn());
  } catch {
    // Ignore transient canvas draw failures
  }
}

export async function seedPassiveTimelineThumbsForVideoUrl(
  videoUrl: string,
  durationSec: number
): Promise<void> {
  if (!videoUrl || typeof document === "undefined") return;
  const existing = storesByUrl.get(videoUrl);
  if (existing && existing.byBucket.size >= 3) return;

  const vid = document.createElement("video");
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = "auto";
  vid.src = videoUrl;

  const waitEvent = (evt: "loadeddata" | "seeked", timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        vid.removeEventListener(evt, onOk);
        vid.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onOk = () => finish(true);
      const onErr = () => finish(false);
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      vid.addEventListener(evt, onOk, { once: true });
      vid.addEventListener("error", onErr, { once: true });
    });

  try {
    const loaded = await waitEvent("loadeddata", 5000);
    if (!loaded || vid.readyState < 2) return;
    const dur =
      Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : Math.max(0.5, durationSec);
    const sampleTimes =
      dur <= 1.2
        ? [0]
        : [Math.min(0.15, dur * 0.1), dur * 0.35, dur * 0.7, Math.max(0, dur - 0.25)];
    for (const sec of sampleTimes) {
      const clamped = Math.max(0, Math.min(Math.max(0, dur - 0.05), sec));
      if (Math.abs(vid.currentTime - clamped) > 0.05) {
        try {
          vid.currentTime = clamped;
          await waitEvent("seeked", 2500);
        } catch {
          // ignore
        }
      }
      capturePassiveThumbFromVideo(videoUrl, vid, true);
    }
  } finally {
    try {
      vid.pause();
      vid.removeAttribute("src");
      vid.load();
    } catch {
      // ignore
    }
  }
}
