import type {
  SceneSelection,
  SubtitleSourceLanguage,
  TranscriptModelId,
  TranscriptProgress,
  TranscriptResult,
  TranscriptSegment,
  TranscriptWord,
} from "../types";
import { extractMp4AudioClips } from "./mp4ClipAudio";
import { safeReadJson, uploadBlobInChunks } from "./uploadFile";
import { getRequiredWhisperOnnxFiles } from "./whisperDtypes";

export interface TranscriptModelSpec {
  id: TranscriptModelId;
  hfModelId?: string;
  label: string;
  scopeLabel: string;
  sizeLabel: string;
  approxBytes: number;
  recommended?: boolean;
  isEnglishOnly?: boolean;
  isLargeModel?: boolean;
  isCloud?: boolean;
  description: string;
}

export const TRANSCRIPT_MODELS: TranscriptModelSpec[] = [
  {
    id: "whisper-tiny",
    hfModelId: "onnx-community/whisper-tiny",
    label: "Tiny",
    scopeLabel: "multilingual",
    sizeLabel: "≈61 MB",
    approxBytes: 61 * 1024 * 1024,
    description: "Fastest on-device model. Best for quick drafts on any phone or PC.",
  },
  {
    id: "whisper-base",
    hfModelId: "onnx-community/whisper-base",
    label: "Base",
    scopeLabel: "multilingual",
    sizeLabel: "≈130 MB",
    approxBytes: 130 * 1024 * 1024,
    recommended: true,
    description: "Balanced speed and accuracy for browser transcription.",
  },
  {
    id: "whisper-small",
    hfModelId: "onnx-community/whisper-small",
    label: "Small",
    scopeLabel: "multilingual",
    sizeLabel: "≈486 MB",
    approxBytes: 486 * 1024 * 1024,
    description: "Strong multilingual accuracy for Thai, English, Japanese, and Korean.",
  },
  {
    id: "whisper-medium",
    hfModelId: "onnx-community/whisper-medium",
    label: "Medium",
    scopeLabel: "multilingual",
    sizeLabel: "≈823 MB",
    approxBytes: 823 * 1024 * 1024,
    isLargeModel: true,
    description: "High accuracy with noisy audio. Recommended on desktop with WebGPU.",
  },
  {
    id: "whisper-large-v3-turbo",
    hfModelId: "onnx-community/whisper-large-v3-turbo",
    label: "Large v3 Turbo",
    scopeLabel: "multilingual",
    sizeLabel: "≈874 MB",
    approxBytes: 874 * 1024 * 1024,
    isLargeModel: true,
    description: "Highest Whisper accuracy & speed balance. Requires WebGPU / high RAM.",
  },
  {
    id: "whisper-tiny-en",
    hfModelId: "onnx-community/whisper-tiny.en",
    label: "Tiny (English)",
    scopeLabel: "english-only",
    sizeLabel: "≈61 MB",
    approxBytes: 61 * 1024 * 1024,
    isEnglishOnly: true,
    description: "Lightweight English-only model for fast English speech.",
  },
  {
    id: "gemini-cloud",
    label: "Cloud AI",
    scopeLabel: "multilingual · online",
    sizeLabel: "0 MB",
    approxBytes: 0,
    isCloud: true,
    description: "Server-side transcription. Best for Burmese speech and low-RAM phones.",
  },
];

const WHISPER_LANGUAGE_MAP: Record<SubtitleSourceLanguage, string> = {
  auto: "auto",
  th: "thai",
  my: "burmese",
  en: "english",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  vi: "vietnamese",
  lo: "lao",
  km: "khmer",
  id: "indonesian",
  hi: "hindi",
  es: "spanish",
  fr: "french",
};

const TRANSFORMERS_CACHE_NAME = "transformers-cache";

export async function detectWebGpuSupport(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      userAgent?: string;
      gpu?: {
        requestAdapter?: () => Promise<{
          requestDevice?: () => Promise<{ destroy?: () => void } | null>;
        } | null>;
      };
    };
    if (nav.userAgent && /Android/i.test(nav.userAgent)) {
      return false;
    }
    if (!nav.gpu?.requestAdapter) return false;
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return false;
    if (typeof adapter.requestDevice === "function") {
      const device = await adapter.requestDevice();
      if (!device) return false;
      try {
        device.destroy?.();
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function getCachedWhisperModelIds(): Promise<Set<TranscriptModelId>> {
  const cached = new Set<TranscriptModelId>();
  if (typeof caches === "undefined") return cached;
  try {
    const webGpuReady = !forceWasmSession && (await detectWebGpuSupport());
    const targetDevice = webGpuReady ? "webgpu" : "wasm";

    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    const urls = keys.map((req) => req.url);
    for (const model of TRANSCRIPT_MODELS) {
      if (!model.hfModelId) continue;
      const needle = `/${model.hfModelId}/`;
      const modelUrls = urls.filter((u) => u.includes(needle));
      if (modelUrls.length === 0) continue;

      const [encoderFile, decoderFile] = getRequiredWhisperOnnxFiles(
        targetDevice,
        Boolean(model.isLargeModel)
      );
      const hasEncoder = modelUrls.some((u) => u.endsWith(`/${encoderFile}`));
      const hasDecoder = modelUrls.some((u) => u.endsWith(`/${decoderFile}`));
      if (hasEncoder && hasDecoder) {
        cached.add(model.id);
      }
    }
  } catch {
    // Ignore Cache API permission errors
  }
  return cached;
}

export async function deleteCachedWhisperModel(modelId: TranscriptModelId): Promise<void> {
  const spec = TRANSCRIPT_MODELS.find((m) => m.id === modelId);
  if (!spec?.hfModelId || typeof caches === "undefined") return;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    const needle = `/${spec.hfModelId}/`;
    await Promise.all(
      keys
        .filter((req) => req.url.includes(needle))
        .map((req) => cache.delete(req))
    );
  } catch {
    // Ignore Cache API errors
  }
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const len = audioBuffer.length;
  const chCount = audioBuffer.numberOfChannels;
  if (chCount <= 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }
  const mixed = new Float32Array(len);
  for (let ch = 0; ch < chCount; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      mixed[i] += data[i] / chCount;
    }
  }
  return mixed;
}

async function resampleBufferSegmentTo16k(
  audioBuffer: AudioBuffer,
  startSec: number,
  durationSec: number
): Promise<Float32Array> {
  const targetRate = 16000;
  const safeStart = Math.max(0, Math.min(audioBuffer.duration, startSec));
  const availDur = Math.max(0.05, Math.min(durationSec, audioBuffer.duration - safeStart));
  const targetLength = Math.max(1, Math.ceil(availDur * targetRate));

  const monoFull = mixAudioBufferToMono(audioBuffer);
  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;

  const offline = new OfflineCtx(1, targetLength, targetRate);
  const srcBuffer = offline.createBuffer(1, monoFull.length, audioBuffer.sampleRate);
  srcBuffer.copyToChannel(monoFull as Float32Array<ArrayBuffer>, 0);

  const source = offline.createBufferSource();
  source.buffer = srcBuffer;
  source.connect(offline.destination);
  source.start(0, safeStart, availDur);

  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

function concatFloat32Arrays(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

async function decodeWithAudioContext(arrayBuf: ArrayBuffer): Promise<AudioBuffer> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function extractTimelineAudio16kMono(
  file: File,
  scenes: Array<{ startSec: number; endSec: number }>,
  options: {
    uploadId?: string;
    onUploadId?: (uploadId: string) => void;
    signal?: AbortSignal;
    onProgress?: (p: TranscriptProgress) => void;
  } = {}
): Promise<{ samples: Float32Array; durationSec: number }> {
  const effectiveScenes =
    scenes.length > 0
      ? scenes
      : [{ startSec: 0, endSec: 600 }];

  options.onProgress?.({
    phase: "extracting",
    label: "Extracting timeline audio...",
    percent: 10,
  });

  // Fast path 1: decode whole file directly in browser for <= 150 MB files
  // (avoids MP4 AAC re-mux priming/edit-list/HE-AAC quirks for cleanest speech audio)
  if (file.size <= 150 * 1024 * 1024) {
    try {
      const buf = await file.arrayBuffer();
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const decoded = await decodeWithAudioContext(buf);
      const pcmParts: Float32Array[] = [];
      let totalDur = 0;
      for (let i = 0; i < effectiveScenes.length; i++) {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const sc = effectiveScenes[i];
        const s = Math.max(0, Math.min(decoded.duration, sc.startSec));
        const e = Math.max(s + 0.1, Math.min(decoded.duration, sc.endSec));
        const resampled = await resampleBufferSegmentTo16k(decoded, s, e - s);
        pcmParts.push(resampled);
        totalDur += resampled.length / 16000;
        options.onProgress?.({
          phase: "extracting",
          label: `Preparing audio (${i + 1}/${effectiveScenes.length})...`,
          percent: Math.round(12 + ((i + 1) / effectiveScenes.length) * 18),
        });
      }
      if (totalDur > 0.05) {
        return {
          samples: concatFloat32Arrays(pcmParts),
          durationSec: Number(totalDur.toFixed(2)),
        };
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Fall through to MP4 track extraction / server ffmpeg
    }
  }

  // Fast path 2: extract only AAC audio chunks from large MP4 containers
  try {
    const mp4Clips = await extractMp4AudioClips(file, effectiveScenes, {
      maxTotalAudioBytes: 48 * 1024 * 1024,
    });
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (mp4Clips && mp4Clips.length > 0) {
      const pcmParts: Float32Array[] = [];
      let totalDur = 0;
      for (let i = 0; i < mp4Clips.length; i++) {
        if (options.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const clip = mp4Clips[i];
        const decoded = await decodeWithAudioContext(base64ToArrayBuffer(clip.audioBase64));
        const resampled = await resampleBufferSegmentTo16k(
          decoded,
          clip.trimLeadSec,
          clip.durationSec
        );
        pcmParts.push(resampled);
        totalDur += resampled.length / 16000;
        options.onProgress?.({
          phase: "extracting",
          label: `Preparing audio (${i + 1}/${mp4Clips.length})...`,
          percent: Math.round(12 + ((i + 1) / mp4Clips.length) * 18),
        });
      }
      return {
        samples: concatFloat32Arrays(pcmParts),
        durationSec: Number(totalDur.toFixed(2)),
      };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // Fall through to server ffmpeg extraction
  }

  // Fallback path 3: server ffmpeg extraction to 16kHz mono WAV
  let resolvedUploadId = options.uploadId;
  if (!resolvedUploadId) {
    options.onProgress?.({
      phase: "extracting",
      label: "Preparing audio via server...",
      percent: 15,
    });
    resolvedUploadId = await uploadBlobInChunks(file, file.name, options.signal, (frac) => {
      options.onProgress?.({
        phase: "extracting",
        label: `Uploading media (${Math.round(frac * 100)}%)...`,
        percent: Math.round(15 + frac * 15),
      });
    });
    options.onUploadId?.(resolvedUploadId);
  }

  const resp = await fetch("/api/extract-audio-pcm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      uploadId: resolvedUploadId,
      scenes: effectiveScenes,
    }),
  });
  if (!resp.ok) {
    const errData = await safeReadJson<{ error?: string }>(resp).catch(() => ({
      error: "Failed to extract audio track from video.",
    }));
    throw new Error(errData.error || "Failed to extract audio track from video.");
  }
  const wavBuf = await resp.arrayBuffer();
  const decoded = await decodeWithAudioContext(wavBuf);
  const samples = mixAudioBufferToMono(decoded);
  return {
    samples,
    durationSec: Number((samples.length / Math.max(1, decoded.sampleRate)).toFixed(2)),
  };
}

let activeWorker: Worker | null = null;
let forceWasmSession = false;

function isWebGpuOrOrtError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /ortrun|webgpu|wgpu|instance reference|compute pipeline|onnxruntime|crashed/i.test(
    msg
  );
}

function createWhisperWorker(): Worker {
  if (activeWorker) {
    return activeWorker;
  }
  activeWorker = new Worker(
    new URL("../workers/whisperTranscript.worker.ts", import.meta.url),
    { type: "module" }
  );
  return activeWorker;
}

function terminateActiveWhisperWorker(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
}

export async function downloadWhisperModel(
  modelId: TranscriptModelId,
  options: {
    signal?: AbortSignal;
    onProgress?: (p: TranscriptProgress) => void;
  } = {}
): Promise<void> {
  const spec = TRANSCRIPT_MODELS.find((m) => m.id === modelId);
  if (!spec || !spec.hfModelId) return;

  const worker = createWhisperWorker();
  const requestId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      terminateActiveWhisperWorker();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const onMessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (!data || data.requestId !== requestId) return;

      if (data.type === "progress") {
        const pct = Number(data.percent) || 0;
        const file = typeof data.file === "string" ? data.file : undefined;
        const loadedBytes = typeof data.loadedBytes === "number" ? data.loadedBytes : undefined;
        const totalBytes = typeof data.totalBytes === "number" ? data.totalBytes : undefined;
        options.onProgress?.({
          phase: data.phase === "loading" ? "loading" : "downloading",
          label:
            data.phase === "loading"
              ? pct > 0 && pct < 100
                ? `Loading cached ${spec.label} (${pct}%)...`
                : `Initializing ${spec.label}...`
              : `Downloading ${spec.label} (${pct}%)...`,
          percent: pct,
          file,
          loadedBytes,
          totalBytes,
        });
      } else if (data.type === "downloaded") {
        cleanup();
        resolve();
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(String(data.error || `Failed to download ${spec.label}.`)));
      }
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      terminateActiveWhisperWorker();
      reject(new Error(err.message || "Whisper worker error while downloading model."));
    };

    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    worker.postMessage({
      type: "download",
      requestId,
      hfModelId: spec.hfModelId,
      isEnglishOnly: Boolean(spec.isEnglishOnly),
      isLargeModel: Boolean(spec.isLargeModel),
      forceWasm: forceWasmSession,
    });
  });
}

interface RawWhisperChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

interface RawWhisperOutput {
  text?: string;
  chunks?: RawWhisperChunk[];
}

function buildSegmentsFromWhisperOutput(
  output: RawWhisperOutput,
  durationSec: number,
  wordTimestamps: boolean
): { text: string; segments: TranscriptSegment[] } {
  const rawChunks = Array.isArray(output.chunks) ? output.chunks : [];
  const fullText = String(output.text || "").trim();

  if (rawChunks.length === 0) {
    if (!fullText) {
      return { text: "", segments: [] };
    }
    return {
      text: fullText,
      segments: [
        {
          id: "tr-1",
          index: 1,
          startSec: 0,
          endSec: Math.max(0.5, durationSec),
          text: fullText,
        },
      ],
    };
  }

  if (!wordTimestamps) {
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const ch = rawChunks[i];
      const text = String(ch.text || "").trim();
      if (!text) continue;
      const prevEnd = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
      const rawStart = typeof ch.timestamp?.[0] === "number" ? ch.timestamp[0] : prevEnd;
      const nextChunkStart =
        typeof rawChunks[i + 1]?.timestamp?.[0] === "number"
          ? rawChunks[i + 1].timestamp![0]!
          : durationSec;
      const rawEnd =
        typeof ch.timestamp?.[1] === "number"
          ? ch.timestamp[1]
          : Math.max(rawStart + 0.4, nextChunkStart);
      const startSec = Math.max(0, Math.min(durationSec, rawStart));
      const endSec = Math.max(startSec + 0.1, Math.min(durationSec, rawEnd));
      segments.push({
        id: `tr-${segments.length + 1}`,
        index: segments.length + 1,
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        text,
      });
    }
    return {
      text: fullText || segments.map((s) => s.text).join(" "),
      segments,
    };
  }

  // Group word-level chunks into natural readable sentence/phrase segments
  const words: TranscriptWord[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const ch = rawChunks[i];
    const txt = String(ch.text || "");
    if (!txt.trim()) continue;
    const prevEnd = words.length > 0 ? words[words.length - 1].endSec : 0;
    const rawStart = typeof ch.timestamp?.[0] === "number" ? ch.timestamp[0] : prevEnd;
    const rawEnd =
      typeof ch.timestamp?.[1] === "number"
        ? ch.timestamp[1]
        : Math.max(rawStart + 0.15, rawStart + 0.35);
    words.push({
      text: txt,
      startSec: Number(Math.max(0, Math.min(durationSec, rawStart)).toFixed(2)),
      endSec: Number(Math.max(rawStart + 0.05, Math.min(durationSec, rawEnd)).toFixed(2)),
    });
  }

  const segments: TranscriptSegment[] = [];
  let bucket: TranscriptWord[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const joinedText = bucket
      .map((w) => w.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (joinedText) {
      segments.push({
        id: `tr-${segments.length + 1}`,
        index: segments.length + 1,
        startSec: bucket[0].startSec,
        endSec: Math.max(bucket[0].startSec + 0.1, bucket[bucket.length - 1].endSec),
        text: joinedText,
        words: bucket.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text.length > 0),
      });
    }
    bucket = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = bucket[bucket.length - 1];
    const gap = prev ? w.startSec - prev.endSec : 0;
    const segDur = bucket.length > 0 ? w.endSec - bucket[0].startSec : 0;

    if (bucket.length > 0 && (gap > 0.75 || bucket.length >= 14 || segDur >= 6.5)) {
      flushBucket();
    }

    bucket.push(w);
    if (/[.!?。！？ฯ]\s*$/.test(w.text) && bucket.length >= 2) {
      flushBucket();
    }
  }
  flushBucket();

  return {
    text: fullText || segments.map((s) => s.text).join(" "),
    segments,
  };
}

export async function runTranscriptGeneration(params: {
  file: File;
  title: string;
  scenes: SceneSelection[];
  modelId: TranscriptModelId;
  language: SubtitleSourceLanguage;
  wordTimestamps: boolean;
  uploadId?: string;
  onUploadId?: (uploadId: string) => void;
  signal?: AbortSignal;
  onProgress?: (p: TranscriptProgress) => void;
}): Promise<TranscriptResult> {
  const spec =
    TRANSCRIPT_MODELS.find((m) => m.id === params.modelId) ?? TRANSCRIPT_MODELS[1];

  // Cloud Gemini path
  if (spec.isCloud) {
    params.onProgress?.({
      phase: "extracting",
      label: "Preparing audio for Cloud AI...",
      percent: 15,
    });

    const effectiveScenes =
      params.scenes.length > 0
        ? params.scenes.map((s) => ({ startSec: s.startSec, endSec: s.endSec }))
        : [{ startSec: 0, endSec: 600 }];

    let clipPayloads = await extractMp4AudioClips(params.file, effectiveScenes).catch(
      () => null
    );
    let resolvedUploadId = params.uploadId;

    if (!clipPayloads && !resolvedUploadId) {
      resolvedUploadId = await uploadBlobInChunks(
        params.file,
        params.file.name,
        params.signal,
        (frac) => {
          params.onProgress?.({
            phase: "extracting",
            label: `Uploading media (${Math.round(frac * 100)}%)...`,
            percent: Math.round(15 + frac * 35),
          });
        }
      );
      params.onUploadId?.(resolvedUploadId);
    }

    params.onProgress?.({
      phase: "transcribing",
      label: "Transcribing audio with Cloud AI...",
      percent: 65,
    });

    const resp = await fetch("/api/transcript-only", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: params.signal,
      body: JSON.stringify({
        uploadId: clipPayloads ? undefined : resolvedUploadId,
        clips: clipPayloads ?? undefined,
        scenes: effectiveScenes,
        language: params.language,
      }),
    });

    const data = await safeReadJson<{
      segments?: TranscriptSegment[];
      text?: string;
      durationSec?: number;
      error?: string;
    }>(resp);

    if (!resp.ok || !Array.isArray(data.segments)) {
      throw new Error(data.error || "Failed to transcribe audio with Cloud AI.");
    }

    params.onProgress?.({
      phase: "transcribing",
      label: "Completed",
      percent: 100,
    });

    return {
      id: `tr-${Date.now()}`,
      title: params.title,
      modelId: spec.id,
      modelLabel: spec.label,
      language: params.language,
      durationSec: Number(data.durationSec) || 0,
      text:
        data.text ||
        data.segments.map((s) => s.text).filter(Boolean).join(" "),
      segments: data.segments,
      createdAt: Date.now(),
    };
  }

  // Local browser Whisper path
  const { samples, durationSec } = await extractTimelineAudio16kMono(
    params.file,
    params.scenes.map((s) => ({ startSec: s.startSec, endSec: s.endSec })),
    {
      uploadId: params.uploadId,
      onUploadId: params.onUploadId,
      signal: params.signal,
      onProgress: params.onProgress,
    }
  );

  if (params.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const whisperLang = WHISPER_LANGUAGE_MAP[params.language] ?? "auto";

  const runWorkerPass = (audioBuf: Float32Array, forceWasm: boolean) =>
    new Promise<RawWhisperOutput>((resolve, reject) => {
      const worker = createWhisperWorker();
      const requestId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const onAbort = () => {
        cleanup();
        terminateActiveWhisperWorker();
        reject(new DOMException("Aborted", "AbortError"));
      };

      const onMessage = (event: MessageEvent<Record<string, unknown>>) => {
        const data = event.data;
        if (!data || data.requestId !== requestId) return;

        if (data.type === "progress") {
          const phase = data.phase as TranscriptProgress["phase"];
          const pct = Number(data.percent) || 0;
          if (phase === "transcribing") {
            params.onProgress?.({
              phase: "transcribing",
              label: `Transcribing with ${spec.label}...`,
              percent: 84,
            });
          } else {
            const mappedPct = Math.round(30 + (pct / 100) * 48);
            params.onProgress?.({
              phase: phase === "loading" ? "loading" : "downloading",
              label:
                phase === "loading"
                  ? pct > 0 && pct < 100
                    ? `Loading cached ${spec.label} (${pct}%)...`
                    : `Loading ${spec.label}...`
                  : `Downloading ${spec.label} (${pct}%)...`,
              percent: mappedPct,
              file: typeof data.file === "string" ? data.file : undefined,
              loadedBytes: typeof data.loadedBytes === "number" ? data.loadedBytes : undefined,
              totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : undefined,
            });
          }
        } else if (data.type === "complete") {
          cleanup();
          resolve((data.output as RawWhisperOutput) || { text: "", chunks: [] });
        } else if (data.type === "error") {
          cleanup();
          reject(new Error(String(data.error || "Whisper transcription failed.")));
        }
      };

      const onError = (err: ErrorEvent) => {
        cleanup();
        terminateActiveWhisperWorker();
        reject(new Error(err.message || "Whisper worker crashed during transcription."));
      };

      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        params.signal?.removeEventListener("abort", onAbort);
      };

      if (params.signal?.aborted) {
        onAbort();
        return;
      }

      params.signal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);

      worker.postMessage(
        {
          type: "transcribe",
          requestId,
          hfModelId: spec.hfModelId,
          isEnglishOnly: Boolean(spec.isEnglishOnly),
          isLargeModel: Boolean(spec.isLargeModel),
          forceWasm,
          audio: audioBuf,
          language: whisperLang,
          wordTimestamps: params.wordTimestamps,
        },
        [audioBuf.buffer]
      );
    });

  let output: RawWhisperOutput;
  if (forceWasmSession) {
    output = await runWorkerPass(samples, true);
  } else {
    let fallbackCopy: Float32Array | null = samples.slice();
    try {
      output = await runWorkerPass(samples, false);
      fallbackCopy = null;
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        !isWebGpuOrOrtError(err) ||
        !fallbackCopy
      ) {
        throw err;
      }
      forceWasmSession = true;
      terminateActiveWhisperWorker();
      params.onProgress?.({
        phase: "loading",
        label: `Switching ${spec.label} to WASM mode...`,
        percent: 50,
      });
      output = await runWorkerPass(fallbackCopy, true);
      fallbackCopy = null;
    }
  }

  const normalized = buildSegmentsFromWhisperOutput(
    output,
    durationSec,
    params.wordTimestamps
  );

  params.onProgress?.({
    phase: "transcribing",
    label: "Completed",
    percent: 100,
  });

  return {
    id: `tr-${Date.now()}`,
    title: params.title,
    modelId: spec.id,
    modelLabel: spec.label,
    language: params.language,
    durationSec,
    text: normalized.text,
    segments: normalized.segments,
    createdAt: Date.now(),
  };
}
