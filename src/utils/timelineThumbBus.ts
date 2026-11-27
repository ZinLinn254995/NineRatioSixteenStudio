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
    if (storesByUrl.size > 6) {
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
