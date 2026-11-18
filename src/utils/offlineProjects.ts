import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
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

export async function listSavedProjects(): Promise<SavedProjectRecord[]> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const store = tx.objectStore(STORE_PROJECTS);
    const items = await reqToPromise<SavedProjectRecord[]>(store.getAll());
    await txDone(tx);
    return items
      .map((item) => ({
        ...item,
        voiceSettings: { ...DEFAULT_VOICE_SETTINGS, ...item.voiceSettings },
        editSettings: { ...DEFAULT_VIDEO_EDIT, ...item.editSettings },
      }))
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
  activeMedia: ActiveMediaSource | null;
  selectedScenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
}

export async function saveOfflineProject(
  input: SaveOfflineProjectInput
): Promise<{ record: SavedProjectRecord; blobSaved: boolean }> {
  const { existingId, project, activeMedia, selectedScenes, voiceSettings, editSettings } = input;
  const now = Date.now();
  const id =
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
      if (project.sourceType === "local") {
        existingBlobEntry = await reqToPromise<MediaBlobEntry | undefined>(
          tx.objectStore(STORE_BLOBS).get(id)
        );
      }
      await txDone(tx);
    }

    let thumbnail =
      activeMedia?.thumbnail ||
      project.keyframeUrls[0] ||
      existingRecord?.thumbnail;

    if (!thumbnail && project.sourceType === "youtube" && project.videoId) {
      thumbnail = `https://i.ytimg.com/vi/${project.videoId}/hqdefault.jpg`;
    }
    const localFile = project.localFile ?? activeMedia?.localFile;
    if (!thumbnail && project.sourceType === "local") {
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

    const resolvedMimeType = localFile
      ? inferVideoMimeType(localFile.name, localFile.type)
      : existingRecord?.localFileType;

    const existingBlobValid =
      project.sourceType === "local" && existingBlobEntry?.blob
        ? await verifyStoredBlob(existingBlobEntry.blob)
        : false;

    const baseRecord: SavedProjectRecord = {
      id,
      title: (input.title ?? project.title).trim() || "Untitled Project",
      sourceType: project.sourceType,
      videoId: project.videoId,
      channel: project.channel || (project.sourceType === "local" ? "Local Video" : "YouTube"),
      thumbnail,
      sourceDurationSec: project.sourceDurationSec,
      targetDurationSec: project.targetDurationSec,
      selectedScenes: normalizedScenes.map((s) => ({ ...s })),
      scenes: project.scenes.map((s) => ({ ...s })),
      subtitles: project.subtitles.map((sub) => ({
        ...sub,
        words: sub.words.map((w) => ({ ...w })),
      })),
      keyframeUrls: [...project.keyframeUrls],
      voiceSettings: { ...DEFAULT_VOICE_SETTINGS, ...voiceSettings },
      editSettings: { ...DEFAULT_VIDEO_EDIT, ...editSettings },
      hasLocalVideoBlob: Boolean((project.sourceType === "local" && localFile) || existingBlobValid),
      localFileName: localFile?.name || existingRecord?.localFileName,
      localFileType: resolvedMimeType,
      localFileSize: localFile?.size ?? existingRecord?.localFileSize,
      createdAt: existingRecord?.createdAt ?? now,
      updatedAt: now,
    };

    let blobSaved = true;

    // Save materialized byte-backed Blob if missing, unreadable, or file changed
    if (project.sourceType === "local" && localFile) {
      const shouldWriteBlob =
        !existingBlobValid ||
        !existingBlobEntry ||
        existingBlobEntry.fileName !== localFile.name ||
        existingBlobEntry.blob.size !== localFile.size;

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
          baseRecord.hasLocalVideoBlob = existingBlobValid;
          if (!existingBlobValid) {
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
    if (!existing) {
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
    if (!existing) return { record: null, blobSaved: false };

    const resolvedMime = inferVideoMimeType(file.name, file.type);
    const tempUrl = URL.createObjectURL(file);
    let thumbnail = existing.thumbnail;
    try {
      if (!thumbnail) {
        thumbnail = await captureLocalVideoThumbnail(tempUrl);
      }
    } finally {
      URL.revokeObjectURL(tempUrl);
    }

    let blobSaved = true;
    try {
      const byteBackedBlob = await materializeReadableBlob(file, resolvedMime);
      const blobTx = db.transaction(STORE_BLOBS, "readwrite");
      blobTx.objectStore(STORE_BLOBS).put({
        id,
        blob: byteBackedBlob,
        fileName: file.name,
        fileType: resolvedMime,
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

  const now = Date.now();
  const id = `proj-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const record: SavedProjectRecord = {
    id,
    title: raw.title.trim() || "Imported Project",
    sourceType: raw.sourceType,
    videoId: raw.videoId,
    channel: raw.channel || (raw.sourceType === "local" ? "Local Video" : "YouTube"),
    thumbnail:
      raw.thumbnail ||
      (raw.sourceType === "youtube" && raw.videoId
        ? `https://i.ytimg.com/vi/${raw.videoId}/hqdefault.jpg`
        : undefined),
    sourceDurationSec: Number(raw.sourceDurationSec) || 0,
    targetDurationSec: Number(raw.targetDurationSec) || 0,
    selectedScenes: Array.isArray(raw.selectedScenes) ? raw.selectedScenes : [],
    scenes: raw.scenes,
    subtitles: raw.subtitles,
    keyframeUrls: Array.isArray(raw.keyframeUrls) ? raw.keyframeUrls : [],
    voiceSettings: { ...DEFAULT_VOICE_SETTINGS, ...(raw.voiceSettings || {}) },
    editSettings: { ...DEFAULT_VIDEO_EDIT, ...(raw.editSettings || {}) },
    hasLocalVideoBlob: false,
    localFileName: raw.localFileName,
    localFileType: raw.localFileType,
    localFileSize: raw.localFileSize,
    createdAt: Number(raw.createdAt) || now,
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
