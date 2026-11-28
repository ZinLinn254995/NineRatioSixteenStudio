import type {
  LocalStudioMedia,
  SavedProjectRecord,
  SceneSelection,
  SpeakingScene,
  SubtitleItem,
  SubtitleSourceLanguage,
  SubtitleWord,
  TranscriptModelId,
  TranscriptResult,
  TranscriptSegment,
  TranscriptWord,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
} from "../types";
import { DEFAULT_VOICE_SETTINGS } from "./voicePresets";
import { DEFAULT_VIDEO_EDIT } from "./videoFilters";

const DB_NAME = "nine-ratio-sixteen-studio-offline";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_BLOBS = "mediaBlobs";

interface MediaBlobEntry {
  id: string;
  blob: Blob;
  fileName: string;
  fileType: string;
  contentFingerprint?: string;
  updatedAt: number;
}

function openOfflineDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("Offline browser storage (IndexedDB) is not available."));
  }
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open offline storage."));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

export function inferVideoMimeType(fileName?: string, explicitType?: string): string {
  const cleanType = (explicitType || "").trim().toLowerCase();
  if (cleanType.startsWith("video/")) return cleanType;

  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".3gp")) return "video/3gpp";
  if (lower.endsWith(".ogv")) return "video/ogg";
  return "";
}

export async function materializeReadableBlob(source: Blob, mimeType: string): Promise<Blob> {
  if (!source || source.size <= 0) {
    throw new Error("Video file is empty or unreadable.");
  }
  const chunkSize = 8 * 1024 * 1024;
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < source.size; offset += chunkSize) {
    const end = Math.min(source.size, offset + chunkSize);
    const buf = await source.slice(offset, end).arrayBuffer();
    if (buf.byteLength === 0 && end > offset) {
      throw new Error("Could not read video bytes from file.");
    }
    parts.push(buf);
  }
  const blob = new Blob(parts, mimeType ? { type: mimeType } : undefined);
  if (blob.size !== source.size) {
    throw new Error("Video bytes were truncated while reading.");
  }
  return blob;
}

async function verifyStoredBlob(blob?: Blob | null): Promise<boolean> {
  if (!blob || blob.size <= 0) return false;
  try {
    const headLen = Math.min(64, blob.size);
    const head = await blob.slice(0, headLen).arrayBuffer();
    if (head.byteLength !== headLen) return false;
    if (blob.size > headLen) {
      const tailStart = Math.max(headLen, blob.size - 64);
      const tail = await blob.slice(tailStart, blob.size).arrayBuffer();
      if (tail.byteLength !== blob.size - tailStart) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function computeBlobFingerprint(blob: Blob): Promise<string> {
  const size = blob.size;
  const sampleLen = 64 * 1024;
  const slices: ArrayBuffer[] = [];
  slices.push(await blob.slice(0, Math.min(size, sampleLen)).arrayBuffer());
  if (size > sampleLen * 2) {
    const midStart = Math.floor((size - sampleLen) / 2);
    slices.push(await blob.slice(midStart, midStart + sampleLen).arrayBuffer());
  }
  if (size > sampleLen) {
    const tailStart = Math.max(sampleLen, size - sampleLen);
    slices.push(await blob.slice(tailStart, size).arrayBuffer());
  }

  const sizeTrailer = new ArrayBuffer(8);
  new DataView(sizeTrailer).setFloat64(0, size);
  slices.push(sizeTrailer);

  const totalBytes = slices.reduce((acc, s) => acc + s.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const s of slices) {
    combined.set(new Uint8Array(s), offset);
    offset += s.byteLength;
  }

  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", combined);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `${size}:${hex}`;
    } catch {
      // Fallback below
    }
  }

  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < combined.length; i++) {
    h1 ^= combined[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= combined[i] + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${size}:${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const rec = raw && typeof raw === "object" ? (raw as Partial<VoiceSettings>) : {};
  return {
    presetId: typeof rec.presetId === "string" ? rec.presetId : DEFAULT_VOICE_SETTINGS.presetId,
    pitchSemitones: clampFinite(rec.pitchSemitones, -12, 12, DEFAULT_VOICE_SETTINGS.pitchSemitones),
    speed: clampFinite(rec.speed, 0.25, 2.5, DEFAULT_VOICE_SETTINGS.speed),
    tone: clampFinite(rec.tone, -10, 10, DEFAULT_VOICE_SETTINGS.tone),
    echo: clampFinite(rec.echo, 0, 100, DEFAULT_VOICE_SETTINGS.echo),
    robot: clampFinite(rec.robot, 0, 100, DEFAULT_VOICE_SETTINGS.robot),
    adversarialNoise:
      typeof rec.adversarialNoise === "boolean"
        ? rec.adversarialNoise
        : DEFAULT_VOICE_SETTINGS.adversarialNoise,
    adversarialStrength: clampFinite(
      rec.adversarialStrength,
      5,
      100,
      DEFAULT_VOICE_SETTINGS.adversarialStrength
    ),
    spectralPhaseShift:
      typeof rec.spectralPhaseShift === "boolean"
        ? rec.spectralPhaseShift
        : DEFAULT_VOICE_SETTINGS.spectralPhaseShift,
    spectralPhaseStrength: clampFinite(
      rec.spectralPhaseStrength,
      10,
      100,
      DEFAULT_VOICE_SETTINGS.spectralPhaseStrength
    ),
    vocalIsolation:
      typeof rec.vocalIsolation === "boolean"
        ? rec.vocalIsolation
        : DEFAULT_VOICE_SETTINGS.vocalIsolation,
    vocalIsolationStrength: clampFinite(
      rec.vocalIsolationStrength,
      10,
      100,
      DEFAULT_VOICE_SETTINGS.vocalIsolationStrength
    ),
  };
}

export function sanitizeEditSettings(raw: unknown): VideoEditSettings {
  const rec = raw && typeof raw === "object" ? (raw as Partial<VideoEditSettings>) : {};
  return {
    filterPreset: typeof rec.filterPreset === "string" ? rec.filterPreset : DEFAULT_VIDEO_EDIT.filterPreset,
    playbackSpeed: clampFinite(rec.playbackSpeed, 0.25, 2.5, DEFAULT_VIDEO_EDIT.playbackSpeed),
    aspectRatio:
      rec.aspectRatio === "original" ||
      rec.aspectRatio === "9:16" ||
      rec.aspectRatio === "9:16-overlay" ||
      rec.aspectRatio === "16:9" ||
      rec.aspectRatio === "1:1" ||
      rec.aspectRatio === "4:5" ||
      rec.aspectRatio === "4:5-overlay"
        ? rec.aspectRatio
        : DEFAULT_VIDEO_EDIT.aspectRatio,
    zoom: clampFinite(rec.zoom, 0.5, 3, DEFAULT_VIDEO_EDIT.zoom),
    panX: clampFinite(rec.panX, -50, 50, DEFAULT_VIDEO_EDIT.panX),
    panY: clampFinite(rec.panY, -50, 50, DEFAULT_VIDEO_EDIT.panY),
    rotateDeg: clampFinite(rec.rotateDeg, -180, 180, DEFAULT_VIDEO_EDIT.rotateDeg),
    flipH: typeof rec.flipH === "boolean" ? rec.flipH : DEFAULT_VIDEO_EDIT.flipH,
    flipV: typeof rec.flipV === "boolean" ? rec.flipV : DEFAULT_VIDEO_EDIT.flipV,
    fitMode: rec.fitMode === "contain" || rec.fitMode === "cover" ? rec.fitMode : DEFAULT_VIDEO_EDIT.fitMode,
    videoHeightPct: clampFinite(rec.videoHeightPct, 26, 52, DEFAULT_VIDEO_EDIT.videoHeightPct),
    brightness: clampFinite(rec.brightness, 20, 200, DEFAULT_VIDEO_EDIT.brightness),
    contrast: clampFinite(rec.contrast, 20, 200, DEFAULT_VIDEO_EDIT.contrast),
    saturation: clampFinite(rec.saturation, 0, 250, DEFAULT_VIDEO_EDIT.saturation),
    hueDeg: clampFinite(rec.hueDeg, -180, 180, DEFAULT_VIDEO_EDIT.hueDeg),
    sepia: clampFinite(rec.sepia, 0, 100, DEFAULT_VIDEO_EDIT.sepia),
    grayscale: clampFinite(rec.grayscale, 0, 100, DEFAULT_VIDEO_EDIT.grayscale),
    blurPx: clampFinite(rec.blurPx, 0, 20, DEFAULT_VIDEO_EDIT.blurPx),
    vignette: clampFinite(rec.vignette, 0, 100, DEFAULT_VIDEO_EDIT.vignette),
    adversarialNoise:
      typeof rec.adversarialNoise === "boolean"
        ? rec.adversarialNoise
        : DEFAULT_VIDEO_EDIT.adversarialNoise,
    adversarialStrength: clampFinite(
      rec.adversarialStrength,
      1,
      32,
      DEFAULT_VIDEO_EDIT.adversarialStrength
    ),
    showThaiScript:
      typeof rec.showThaiScript === "boolean"
        ? rec.showThaiScript
        : DEFAULT_VIDEO_EDIT.showThaiScript,
    translationTone:
      rec.translationTone === "casual" ||
      rec.translationTone === "formal" ||
      rec.translationTone === "dramatic" ||
      rec.translationTone === "literal"
        ? rec.translationTone
        : DEFAULT_VIDEO_EDIT.translationTone,
    subtitleFontScale:
      rec.subtitleFontScale === "sm" ||
      rec.subtitleFontScale === "md" ||
      rec.subtitleFontScale === "lg"
        ? rec.subtitleFontScale
        : DEFAULT_VIDEO_EDIT.subtitleFontScale,
    subtitleTheme:
      rec.subtitleTheme === "auto" ||
      rec.subtitleTheme === "light" ||
      rec.subtitleTheme === "dark" ||
      rec.subtitleTheme === "warm"
        ? rec.subtitleTheme
        : DEFAULT_VIDEO_EDIT.subtitleTheme,
    subtitleHighlightColor:
      rec.subtitleHighlightColor === "amber" ||
      rec.subtitleHighlightColor === "emerald" ||
      rec.subtitleHighlightColor === "indigo" ||
      rec.subtitleHighlightColor === "rose"
        ? rec.subtitleHighlightColor
        : DEFAULT_VIDEO_EDIT.subtitleHighlightColor,
    showWordGloss:
      typeof rec.showWordGloss === "boolean"
        ? rec.showWordGloss
        : DEFAULT_VIDEO_EDIT.showWordGloss,
    showBurmeseLine:
      typeof rec.showBurmeseLine === "boolean"
        ? rec.showBurmeseLine
        : DEFAULT_VIDEO_EDIT.showBurmeseLine,
    subtitleCardStyle:
      rec.subtitleCardStyle === "card" ||
      rec.subtitleCardStyle === "minimal" ||
      rec.subtitleCardStyle === "outline" ||
      rec.subtitleCardStyle === "glass"
        ? rec.subtitleCardStyle
        : DEFAULT_VIDEO_EDIT.subtitleCardStyle,
    subtitleWordStyle:
      rec.subtitleWordStyle === "fill" ||
      rec.subtitleWordStyle === "underline" ||
      rec.subtitleWordStyle === "glow" ||
      rec.subtitleWordStyle === "text"
        ? rec.subtitleWordStyle
        : DEFAULT_VIDEO_EDIT.subtitleWordStyle,
    subtitleFontFamily:
      rec.subtitleFontFamily === "sans" ||
      rec.subtitleFontFamily === "display" ||
      rec.subtitleFontFamily === "serif" ||
      rec.subtitleFontFamily === "mono"
        ? rec.subtitleFontFamily
        : DEFAULT_VIDEO_EDIT.subtitleFontFamily,
    subtitleAlign:
      rec.subtitleAlign === "left" || rec.subtitleAlign === "center"
        ? rec.subtitleAlign
        : DEFAULT_VIDEO_EDIT.subtitleAlign,
    subtitleSizePct: clampFinite(rec.subtitleSizePct, 75, 140, DEFAULT_VIDEO_EDIT.subtitleSizePct ?? 100),
    subtitleCardRadius: clampFinite(rec.subtitleCardRadius, 0, 28, DEFAULT_VIDEO_EDIT.subtitleCardRadius ?? 18),
    subtitleTextWeight:
      rec.subtitleTextWeight === "normal" ||
      rec.subtitleTextWeight === "semibold" ||
      rec.subtitleTextWeight === "bold"
        ? rec.subtitleTextWeight
        : DEFAULT_VIDEO_EDIT.subtitleTextWeight,
    subtitleLineSpacing:
      rec.subtitleLineSpacing === "compact" ||
      rec.subtitleLineSpacing === "normal" ||
      rec.subtitleLineSpacing === "relaxed"
        ? rec.subtitleLineSpacing
        : DEFAULT_VIDEO_EDIT.subtitleLineSpacing,
    subtitleOverlayX: clampFinite(
      rec.subtitleOverlayX,
      -50,
      50,
      DEFAULT_VIDEO_EDIT.subtitleOverlayX ?? 0
    ),
    subtitleOverlayY: clampFinite(
      rec.subtitleOverlayY,
      0,
      100,
      DEFAULT_VIDEO_EDIT.subtitleOverlayY ?? 96
    ),
  };
}

const VALID_TRANSCRIPT_MODELS = new Set<TranscriptModelId>([
  "whisper-tiny",
  "whisper-base",
  "whisper-small",
  "whisper-medium",
  "whisper-large-v3-turbo",
  "whisper-tiny-en",
  "gemini-cloud",
]);

const VALID_SOURCE_LANGUAGES = new Set<SubtitleSourceLanguage>([
  "auto",
  "th",
  "my",
  "en",
  "zh",
  "ja",
  "ko",
  "vi",
  "lo",
  "km",
  "id",
  "hi",
  "es",
  "fr",
]);

export function sanitizeTranscriptResult(raw: unknown): TranscriptResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Partial<TranscriptResult>;
  if (!Array.isArray(rec.segments)) return undefined;

  const segments: TranscriptSegment[] = rec.segments
    .filter((s): s is TranscriptSegment => Boolean(s && typeof s === "object"))
    .map((s, idx) => {
      const startSec = Number.isFinite(Number(s.startSec))
        ? Math.max(0, Number(s.startSec))
        : 0;
      const rawEnd = Number(s.endSec);
      const endSec = Number.isFinite(rawEnd) && rawEnd >= startSec ? rawEnd : startSec;
      const words: TranscriptWord[] | undefined = Array.isArray(s.words)
        ? s.words
            .filter((w): w is TranscriptWord => Boolean(w && typeof w === "object"))
            .map((w) => {
              const ws = Number.isFinite(Number(w.startSec))
                ? Math.max(0, Number(w.startSec))
                : startSec;
              const we = Number.isFinite(Number(w.endSec)) && Number(w.endSec) >= ws
                ? Number(w.endSec)
                : ws;
              return {
                text: typeof w.text === "string" ? w.text : String(w.text ?? ""),
                startSec: ws,
                endSec: we,
              };
            })
        : undefined;

      return {
        id: typeof s.id === "string" && s.id.trim() ? s.id : `tr-${idx + 1}`,
        index: Number.isInteger(Number(s.index)) && Number(s.index) > 0 ? Number(s.index) : idx + 1,
        startSec,
        endSec,
        text: typeof s.text === "string" ? s.text : "",
        ...(words && words.length > 0 ? { words } : {}),
      };
    });

  const modelId: TranscriptModelId =
    typeof rec.modelId === "string" && VALID_TRANSCRIPT_MODELS.has(rec.modelId as TranscriptModelId)
      ? (rec.modelId as TranscriptModelId)
      : "whisper-base";

  const language: SubtitleSourceLanguage =
    typeof rec.language === "string" &&
    VALID_SOURCE_LANGUAGES.has(rec.language as SubtitleSourceLanguage)
      ? (rec.language as SubtitleSourceLanguage)
      : "auto";

  const text =
    typeof rec.text === "string"
      ? rec.text
      : segments
          .map((s) => s.text.trim())
          .filter(Boolean)
          .join(" ");

  return {
    id: typeof rec.id === "string" && rec.id.trim() ? rec.id : `tr-${Date.now()}`,
    title: typeof rec.title === "string" ? rec.title : "Audio Transcript",
    modelId,
    modelLabel: typeof rec.modelLabel === "string" && rec.modelLabel.trim() ? rec.modelLabel : "Base",
    language,
    ...(typeof rec.detectedLanguage === "string" && rec.detectedLanguage.trim()
      ? { detectedLanguage: rec.detectedLanguage.trim() }
      : {}),
    durationSec:
      typeof rec.durationSec === "number" && Number.isFinite(rec.durationSec) && rec.durationSec >= 0
        ? rec.durationSec
        : 0,
    text,
    segments,
    createdAt:
      typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) && rec.createdAt > 0
        ? rec.createdAt
        : Date.now(),
  };
}

export async function captureLocalVideoThumbnail(localUrl: string): Promise<string | undefined> {
  if (typeof document === "undefined" || !localUrl) return undefined;
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let settled = false;

    const finish = (result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(undefined), 2500);

    video.onloadeddata = () => {
      try {
        const targetTime =
          Number.isFinite(video.duration) && video.duration > 1.2
            ? Math.min(1, video.duration * 0.15)
            : 0;
        if (targetTime > 0.05) {
          video.currentTime = targetTime;
        } else {
          drawFrame();
        }
      } catch {
        drawFrame();
      }
    };

    const drawFrame = () => {
      try {
        const vw = video.videoWidth || 320;
        const vh = video.videoHeight || 180;
        const maxW = 360;
        const scale = Math.min(1, maxW / vw);
        const w = Math.max(64, Math.round(vw * scale));
        const h = Math.max(64, Math.round(vh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, w, h);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        finish(undefined);
      }
    };

    video.onseeked = drawFrame;
    video.onerror = () => finish(undefined);
    video.src = localUrl;
  });
}

export function isLegacyYouTubeProject(
  record: Pick<SavedProjectRecord, "sourceType">
): boolean {
  return record.sourceType === "youtube";
}

export async function listSavedProjects(): Promise<SavedProjectRecord[]> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const store = tx.objectStore(STORE_PROJECTS);
    const items = await reqToPromise<SavedProjectRecord[]>(store.getAll());
    await txDone(tx);
    return items
      .map((item) => {
        const scenes = Array.isArray(item.scenes) ? item.scenes : [];
        const sourceType: SavedProjectRecord["sourceType"] =
          item.sourceType === "youtube" ? "youtube" : "local";
        const isLegacy = sourceType === "youtube";
        return {
          ...item,
          sourceType,
          videoId: isLegacy && typeof item.videoId === "string" ? item.videoId : undefined,
          hasLocalVideoBlob: isLegacy ? false : Boolean(item.hasLocalVideoBlob),
          scenes,
          selectedScenes: Array.isArray(item.selectedScenes) ? item.selectedScenes : [],
          subtitles: Array.isArray(item.subtitles)
            ? item.subtitles.map((sub) => ({
                ...sub,
                sceneId:
                  typeof sub.sceneId === "string" && sub.sceneId.trim()
                    ? sub.sceneId
                    : scenes[sub.sceneIndex]?.id,
                isManuallyEdited: Boolean(sub.isManuallyEdited),
                words: Array.isArray(sub.words) ? sub.words : [],
              }))
            : [],
          keyframeUrls: Array.isArray(item.keyframeUrls) ? item.keyframeUrls : [],
          voiceSettings: sanitizeVoiceSettings(item.voiceSettings),
          editSettings: sanitizeEditSettings(item.editSettings),
          ...(item.transcriptResult
            ? { transcriptResult: sanitizeTranscriptResult(item.transcriptResult) }
            : {}),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function getSavedProjectBlob(
  id: string
): Promise<{ blob: Blob; fileName: string; fileType: string } | null> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(STORE_BLOBS, "readonly");
    const store = tx.objectStore(STORE_BLOBS);
    const entry = await reqToPromise<MediaBlobEntry | undefined>(store.get(id));
    await txDone(tx);
    if (!entry?.blob) return null;

    const readable = await verifyStoredBlob(entry.blob);
    if (!readable) {
      // Clean up corrupted/unreadable blob entry and update metadata flag
      try {
        const fixTx = db.transaction([STORE_BLOBS, STORE_PROJECTS], "readwrite");
        fixTx.objectStore(STORE_BLOBS).delete(id);
        const projStore = fixTx.objectStore(STORE_PROJECTS);
        const proj = await reqToPromise<SavedProjectRecord | undefined>(projStore.get(id));
        if (proj && proj.hasLocalVideoBlob) {
          projStore.put({ ...proj, hasLocalVideoBlob: false });
        }
        await txDone(fixTx);
      } catch {
        // ignore cleanup error
      }
      return null;
    }

    const fileName = entry.fileName || "video.mp4";
    const fileType = inferVideoMimeType(fileName, entry.fileType || entry.blob.type);
    return {
      blob: entry.blob,
      fileName,
      fileType,
    };
  } finally {
    db.close();
  }
}

export interface SaveOfflineProjectInput {
  existingId?: string | null;
  title?: string;
  project: VideoProject;
  activeMedia: LocalStudioMedia | null;
  selectedScenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  transcriptResult?: TranscriptResult | null;
}

export async function saveOfflineProject(
  input: SaveOfflineProjectInput
): Promise<{ record: SavedProjectRecord; blobSaved: boolean }> {
  const { existingId, project, activeMedia, selectedScenes, voiceSettings, editSettings, transcriptResult } = input;
  const now = Date.now();
  let id =
    existingId || `proj-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const db = await openOfflineDb();
  try {
    let existingRecord: SavedProjectRecord | undefined;
    let existingBlobEntry: MediaBlobEntry | undefined;
    {
      const tx = db.transaction([STORE_PROJECTS, STORE_BLOBS], "readonly");
      existingRecord = await reqToPromise<SavedProjectRecord | undefined>(
        tx.objectStore(STORE_PROJECTS).get(id)
      );
      if (existingRecord && isLegacyYouTubeProject(existingRecord)) {
        // Never overwrite a legacy YouTube record in place; allocate a fresh local project ID instead.
        id = `proj-${now}-${Math.random().toString(36).slice(2, 8)}`;
        existingRecord = undefined;
      } else {
        existingBlobEntry = await reqToPromise<MediaBlobEntry | undefined>(
          tx.objectStore(STORE_BLOBS).get(id)
        );
      }
      await txDone(tx);
    }

    const localFile = project.localFile ?? activeMedia?.localFile;
    const resolvedMimeType = localFile
      ? inferVideoMimeType(localFile.name, localFile.type)
      : existingRecord?.localFileType;

    const existingBlobValid = existingBlobEntry?.blob
      ? await verifyStoredBlob(existingBlobEntry.blob)
      : false;

    const fileFingerprint = localFile
      ? await computeBlobFingerprint(localFile)
      : undefined;

    const fileChangedFromExisting = Boolean(
      localFile &&
        (!existingBlobEntry ||
          existingBlobEntry.fileName !== localFile.name ||
          existingBlobEntry.blob.size !== localFile.size ||
          !existingBlobEntry.contentFingerprint ||
          existingBlobEntry.contentFingerprint !== fileFingerprint)
    );

    let thumbnail =
      activeMedia?.thumbnail ||
      project.keyframeUrls[0] ||
      (fileChangedFromExisting ? undefined : existingRecord?.thumbnail);

    if (!thumbnail) {
      if (localFile) {
        const tempThumbUrl = URL.createObjectURL(localFile);
        try {
          thumbnail = await captureLocalVideoThumbnail(tempThumbUrl);
        } finally {
          URL.revokeObjectURL(tempThumbUrl);
        }
      } else if (project.localUrl) {
        thumbnail = await captureLocalVideoThumbnail(project.localUrl);
      }
    }

    const normalizedScenes: SceneSelection[] =
      selectedScenes.length > 0
        ? selectedScenes
        : project.scenes.map((sc, i) => ({
            id: `sc-${i}-${sc.startSec}-${sc.endSec}`,
            startSec: sc.startSec,
            endSec: sc.endSec,
          }));

    const sanitizedTranscript = sanitizeTranscriptResult(transcriptResult);

    const baseRecord: SavedProjectRecord = {
      id,
      title: (input.title ?? project.title).trim() || "Untitled Project",
      sourceType: "local",
      channel: project.channel || "Local Video",
      thumbnail,
      sourceDurationSec: project.sourceDurationSec,
      targetDurationSec: project.targetDurationSec,
      selectedScenes: normalizedScenes.map((s) => ({ ...s })),
      scenes: project.scenes.map((s) => ({ ...s })),
      subtitles: project.subtitles.map((sub) => ({
        ...sub,
        isManuallyEdited: Boolean(sub.isManuallyEdited),
        words: (Array.isArray(sub.words) ? sub.words : []).map((w) => ({ ...w })),
      })),
      ...(Array.isArray(project.speechRegions) && project.speechRegions.length > 0
        ? {
            speechRegions: project.speechRegions.map((sr) => ({
              sourceStartSec: sr.sourceStartSec,
              sourceEndSec: sr.sourceEndSec,
            })),
          }
        : {}),
      keyframeUrls: [...project.keyframeUrls],
      voiceSettings: sanitizeVoiceSettings(voiceSettings),
      editSettings: sanitizeEditSettings(editSettings),
      ...(sanitizedTranscript ? { transcriptResult: sanitizedTranscript } : {}),
      hasLocalVideoBlob: Boolean(localFile || existingBlobValid),
      localFileName: localFile?.name || existingRecord?.localFileName,
      localFileType: resolvedMimeType,
      localFileSize: localFile?.size ?? existingRecord?.localFileSize,
      createdAt: existingRecord?.createdAt ?? now,
      updatedAt: now,
    };

    let blobSaved = true;

    // Save materialized byte-backed Blob if missing, unreadable, or content/fingerprint changed
    if (localFile) {
      const shouldWriteBlob = !existingBlobValid || fileChangedFromExisting;

      if (shouldWriteBlob) {
        try {
          const byteBackedBlob = await materializeReadableBlob(
            localFile,
            resolvedMimeType || ""
          );
          const blobTx = db.transaction(STORE_BLOBS, "readwrite");
          blobTx.objectStore(STORE_BLOBS).put({
            id,
            blob: byteBackedBlob,
            fileName: localFile.name,
            fileType: resolvedMimeType || "",
            contentFingerprint: fileFingerprint,
            updatedAt: now,
          } satisfies MediaBlobEntry);
          await txDone(blobTx);

          // Confirm the persisted IDB entry can actually be read back
          const checkTx = db.transaction(STORE_BLOBS, "readonly");
          const stored = await reqToPromise<MediaBlobEntry | undefined>(
            checkTx.objectStore(STORE_BLOBS).get(id)
          );
          await txDone(checkTx);
          const ok = await verifyStoredBlob(stored?.blob);
          if (!ok) {
            throw new Error("Persisted video blob failed verification.");
          }
        } catch {
          blobSaved = false;
          baseRecord.hasLocalVideoBlob = existingBlobValid && !fileChangedFromExisting;
          if (!existingBlobValid || fileChangedFromExisting) {
            try {
              const delTx = db.transaction(STORE_BLOBS, "readwrite");
              delTx.objectStore(STORE_BLOBS).delete(id);
              await txDone(delTx);
            } catch {
              // ignore cleanup error
            }
          }
        }
      }
    }

    const metaTx = db.transaction(STORE_PROJECTS, "readwrite");
    metaTx.objectStore(STORE_PROJECTS).put(baseRecord);
    await txDone(metaTx);

    return { record: baseRecord, blobSaved };
  } finally {
    db.close();
  }
}

export async function renameSavedProject(
  id: string,
  newTitle: string
): Promise<SavedProjectRecord | null> {
  const trimmed = newTitle.trim();
  if (!trimmed) return null;

  const db = await openOfflineDb();
  try {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    const store = tx.objectStore(STORE_PROJECTS);
    const existing = await reqToPromise<SavedProjectRecord | undefined>(store.get(id));
    if (!existing || isLegacyYouTubeProject(existing)) {
      await txDone(tx);
      return null;
    }
    const updated: SavedProjectRecord = {
      ...existing,
      title: trimmed,
      updatedAt: Date.now(),
    };
    store.put(updated);
    await txDone(tx);
    return updated;
  } finally {
    db.close();
  }
}

export async function attachLocalVideoToSavedProject(
  id: string,
  file: File
): Promise<{ record: SavedProjectRecord | null; blobSaved: boolean }> {
  const db = await openOfflineDb();
  try {
    const readTx = db.transaction(STORE_PROJECTS, "readonly");
    const existing = await reqToPromise<SavedProjectRecord | undefined>(
      readTx.objectStore(STORE_PROJECTS).get(id)
    );
    await txDone(readTx);
    if (!existing || isLegacyYouTubeProject(existing)) {
      return { record: null, blobSaved: false };
    }

    const resolvedMime = inferVideoMimeType(file.name, file.type);
    const fingerprint = await computeBlobFingerprint(file);
    const tempUrl = URL.createObjectURL(file);
    let thumbnail: string | undefined;
    try {
      thumbnail = await captureLocalVideoThumbnail(tempUrl);
    } finally {
      URL.revokeObjectURL(tempUrl);
    }
    thumbnail = thumbnail || existing.thumbnail;

    let blobSaved = true;
    try {
      const byteBackedBlob = await materializeReadableBlob(file, resolvedMime);
      const blobTx = db.transaction(STORE_BLOBS, "readwrite");
      blobTx.objectStore(STORE_BLOBS).put({
        id,
        blob: byteBackedBlob,
        fileName: file.name,
        fileType: resolvedMime,
        contentFingerprint: fingerprint,
        updatedAt: Date.now(),
      } satisfies MediaBlobEntry);
      await txDone(blobTx);
    } catch {
      blobSaved = false;
    }

    const updated: SavedProjectRecord = {
      ...existing,
      thumbnail,
      hasLocalVideoBlob: blobSaved,
      localFileName: file.name,
      localFileType: resolvedMime,
      localFileSize: file.size,
      updatedAt: Date.now(),
    };

    const metaTx = db.transaction(STORE_PROJECTS, "readwrite");
    metaTx.objectStore(STORE_PROJECTS).put(updated);
    await txDone(metaTx);

    return { record: updated, blobSaved };
  } finally {
    db.close();
  }
}

export async function deleteSavedProject(id: string): Promise<void> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction([STORE_PROJECTS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.objectStore(STORE_BLOBS).delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export function exportProjectAsJson(record: SavedProjectRecord): Blob {
  const payload = {
    format: "nine-ratio-sixteen-studio-project",
    version: 1,
    exportedAt: new Date().toISOString(),
    project: {
      ...record,
      hasLocalVideoBlob: false,
    },
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
}

export async function importProjectFromJsonText(
  jsonText: string
): Promise<SavedProjectRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON project file.");
  }

  const raw =
    parsed &&
    typeof parsed === "object" &&
    "project" in parsed &&
    (parsed as { project?: unknown }).project &&
    typeof (parsed as { project?: unknown }).project === "object"
      ? (parsed as { project: Partial<SavedProjectRecord> }).project
      : (parsed as Partial<SavedProjectRecord>);

  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.title !== "string" ||
    (raw.sourceType !== "youtube" && raw.sourceType !== "local") ||
    !Array.isArray(raw.subtitles) ||
    !Array.isArray(raw.scenes)
  ) {
    throw new Error("This file is not a valid 9:16 Studio project.");
  }

  const validatedScenes: SpeakingScene[] = raw.scenes.map((sc, idx) => {
    if (!sc || typeof sc !== "object") {
      throw new Error(`Invalid scene entry at index ${idx + 1}.`);
    }
    const startSec = Number((sc as Partial<SpeakingScene>).startSec);
    const endSec = Number((sc as Partial<SpeakingScene>).endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
      throw new Error(`Scene ${idx + 1} has invalid or out-of-order timing values.`);
    }
    return {
      id:
        typeof (sc as Partial<SpeakingScene>).id === "string" && (sc as Partial<SpeakingScene>).id!.trim()
          ? (sc as Partial<SpeakingScene>).id
          : `proj-sc-${idx}-${Math.round(startSec * 10)}-${Math.round(endSec * 10)}`,
      index: idx,
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      durationSec: Number(Math.max(0.1, endSec - startSec).toFixed(2)),
      summary:
        typeof (sc as Partial<SpeakingScene>).summary === "string"
          ? (sc as Partial<SpeakingScene>).summary!
          : `Scene ${idx + 1}`,
    };
  });

  if (raw.selectedScenes !== undefined && !Array.isArray(raw.selectedScenes)) {
    throw new Error("Project file contains invalid selectedScenes data.");
  }

  const validatedSelectedScenes: SceneSelection[] = Array.isArray(raw.selectedScenes)
    ? raw.selectedScenes.map((sel, idx) => {
        if (!sel || typeof sel !== "object") {
          throw new Error(`Invalid selected scene at index ${idx + 1}.`);
        }
        const startSec = Number((sel as Partial<SceneSelection>).startSec);
        const endSec = Number((sel as Partial<SceneSelection>).endSec);
        if (
          !Number.isFinite(startSec) ||
          !Number.isFinite(endSec) ||
          startSec < 0 ||
          endSec <= startSec
        ) {
          throw new Error(`Selected scene ${idx + 1} has invalid timing values.`);
        }
        return {
          id:
            typeof (sel as Partial<SceneSelection>).id === "string" &&
            (sel as Partial<SceneSelection>).id!.trim()
              ? (sel as Partial<SceneSelection>).id!
              : `sc-${idx}-${Math.round(startSec * 10)}-${Math.round(endSec * 10)}`,
          startSec: Number(startSec.toFixed(2)),
          endSec: Number(endSec.toFixed(2)),
        };
      })
    : validatedScenes.map((sc, idx) => ({
        id: sc.id || `sc-${idx}-${Math.round(sc.startSec * 10)}-${Math.round(sc.endSec * 10)}`,
        startSec: sc.startSec,
        endSec: sc.endSec,
      }));

  const computedTargetDur = validatedScenes.reduce(
    (acc, sc) => acc + Math.max(0.1, sc.endSec - sc.startSec),
    0
  );

  const validatedSubtitles: SubtitleItem[] = raw.subtitles.map((sub, idx) => {
    if (!sub || typeof sub !== "object") {
      throw new Error(`Invalid subtitle entry at index ${idx + 1}.`);
    }
    const s = sub as Partial<SubtitleItem>;
    const startTime = Number(s.startTime);
    const endTime = Number(s.endTime);
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      startTime < 0 ||
      endTime <= startTime
    ) {
      throw new Error(`Subtitle ${idx + 1} has invalid or out-of-order timing values.`);
    }
    if (!Array.isArray(s.words)) {
      throw new Error(`Subtitle ${idx + 1} is missing a valid words array.`);
    }
    if (typeof s.thaiPhonetic !== "string" && typeof s.burmese !== "string") {
      throw new Error(`Subtitle ${idx + 1} is missing subtitle text.`);
    }

    const subDur = Math.max(0.1, endTime - startTime);
    const validatedWords: SubtitleWord[] = s.words.map((w, wi) => {
      if (!w || typeof w !== "object" || typeof (w as Partial<SubtitleWord>).phonetic !== "string") {
        throw new Error(`Subtitle ${idx + 1}, word ${wi + 1} is missing required fields.`);
      }
      const ww = w as Partial<SubtitleWord>;
      const wStart = Number(ww.startOffsetSec);
      const wEnd = Number(ww.endOffsetSec);
      if (!Number.isFinite(wStart) || !Number.isFinite(wEnd) || wStart < 0 || wEnd < wStart) {
        throw new Error(`Subtitle ${idx + 1}, word ${wi + 1} has invalid timing values.`);
      }
      return {
        phonetic: ww.phonetic!,
        thai: typeof ww.thai === "string" ? ww.thai : ww.phonetic!,
        burmeseGloss: typeof ww.burmeseGloss === "string" ? ww.burmeseGloss : "",
        startOffsetSec: Number(Math.min(subDur, Math.max(0, wStart)).toFixed(2)),
        endOffsetSec: Number(Math.min(subDur, Math.max(wStart, wEnd)).toFixed(2)),
      };
    });

    const rawSrcStart = Number(s.sourceStartSec);
    const rawSrcEnd = Number(s.sourceEndSec);
    const sourceStartSec =
      Number.isFinite(rawSrcStart) && rawSrcStart >= 0 ? rawSrcStart : startTime;
    const sourceEndSec =
      Number.isFinite(rawSrcEnd) && rawSrcEnd > sourceStartSec
        ? rawSrcEnd
        : sourceStartSec + subDur;

    const rawSceneIndex = Number(s.sceneIndex);
    const sceneIndex =
      Number.isInteger(rawSceneIndex) && rawSceneIndex >= 0 ? rawSceneIndex : 0;
    const sceneId =
      typeof s.sceneId === "string" && s.sceneId.trim()
        ? s.sceneId
        : validatedScenes[sceneIndex]?.id;

    const rawAiSrcStart = Number(s.aiSourceStartSec);
    const rawAiSrcEnd = Number(s.aiSourceEndSec);
    const hasAiOrigin =
      Number.isFinite(rawAiSrcStart) &&
      rawAiSrcStart >= 0 &&
      Number.isFinite(rawAiSrcEnd) &&
      rawAiSrcEnd > rawAiSrcStart;

    return {
      id: typeof s.id === "string" && s.id.trim() ? s.id : `sub-${idx + 1}`,
      sceneIndex,
      ...(sceneId ? { sceneId } : {}),
      startTime: Number(startTime.toFixed(2)),
      endTime: Number(endTime.toFixed(2)),
      sourceStartSec: Number(sourceStartSec.toFixed(2)),
      sourceEndSec: Number(sourceEndSec.toFixed(2)),
      ...(hasAiOrigin
        ? {
            aiSourceStartSec: Number(rawAiSrcStart.toFixed(2)),
            aiSourceEndSec: Number(rawAiSrcEnd.toFixed(2)),
          }
        : {}),
      originalSpokenText: typeof s.originalSpokenText === "string" ? s.originalSpokenText : "",
      thaiPhonetic: typeof s.thaiPhonetic === "string" ? s.thaiPhonetic : "",
      thaiScript: typeof s.thaiScript === "string" ? s.thaiScript : "",
      burmese: typeof s.burmese === "string" ? s.burmese : "",
      words: validatedWords,
      isManuallyEdited: Boolean(s.isManuallyEdited),
    };
  });

  const now = Date.now();
  const id = `proj-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const parsedSourceDur = Number(raw.sourceDurationSec);
  const parsedTargetDur = Number(raw.targetDurationSec);

  const isLegacyYouTube = raw.sourceType === "youtube";
  const record: SavedProjectRecord = {
    id,
    title: raw.title.trim() || "Imported Project",
    sourceType: isLegacyYouTube ? "youtube" : "local",
    videoId: isLegacyYouTube && typeof raw.videoId === "string" ? raw.videoId : undefined,
    channel:
      typeof raw.channel === "string" && raw.channel.trim()
        ? raw.channel
        : isLegacyYouTube
          ? "YouTube"
          : "Local Video",
    thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : undefined,
    sourceDurationSec:
      Number.isFinite(parsedSourceDur) && parsedSourceDur > 0
        ? parsedSourceDur
        : Math.max(computedTargetDur, 0),
    targetDurationSec:
      Number.isFinite(parsedTargetDur) && parsedTargetDur > 0
        ? parsedTargetDur
        : Number(computedTargetDur.toFixed(2)),
    selectedScenes: validatedSelectedScenes,
    scenes: validatedScenes,
    subtitles: validatedSubtitles.sort((a, b) => a.startTime - b.startTime),
    ...(Array.isArray(raw.speechRegions) && raw.speechRegions.length > 0
      ? {
          speechRegions: raw.speechRegions
            .filter(
              (sr) =>
                sr &&
                typeof sr.sourceStartSec === "number" &&
                typeof sr.sourceEndSec === "number" &&
                sr.sourceEndSec > sr.sourceStartSec
            )
            .map((sr) => ({
              sourceStartSec: sr.sourceStartSec,
              sourceEndSec: sr.sourceEndSec,
            })),
        }
      : {}),
    keyframeUrls: Array.isArray(raw.keyframeUrls)
      ? raw.keyframeUrls.filter((u): u is string => typeof u === "string")
      : [],
    voiceSettings: sanitizeVoiceSettings(raw.voiceSettings),
    editSettings: sanitizeEditSettings(raw.editSettings),
    ...(raw.transcriptResult
      ? { transcriptResult: sanitizeTranscriptResult(raw.transcriptResult) }
      : {}),
    hasLocalVideoBlob: false,
    localFileName: typeof raw.localFileName === "string" ? raw.localFileName : undefined,
    localFileType: typeof raw.localFileType === "string" ? raw.localFileType : undefined,
    localFileSize:
      typeof raw.localFileSize === "number" && Number.isFinite(raw.localFileSize) && raw.localFileSize >= 0
        ? raw.localFileSize
        : undefined,
    createdAt:
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt > 0
        ? raw.createdAt
        : now,
    updatedAt: now,
  };

  const db = await openOfflineDb();
  try {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    tx.objectStore(STORE_PROJECTS).put(record);
    await txDone(tx);
    return record;
  } finally {
    db.close();
  }
}
