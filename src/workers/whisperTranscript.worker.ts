import {
  AutoModel,
  InterruptableStoppingCriteria,
  pipeline,
  env,
  Tensor,
  WhisperTextStreamer,
  type AutomaticSpeechRecognitionPipeline,
  type PreTrainedModel,
} from "@huggingface/transformers";
import { getWhisperDtypeConfig } from "../utils/whisperDtypes";

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
  if (typeof self !== "undefined" && !self.crossOriginIsolated) {
    env.backends.onnx.wasm.numThreads = 1;
  }
}

interface WorkerRequest {
  type: "download" | "transcribe" | "cancel";
  requestId: string;
  hfModelId?: string;
  isEnglishOnly?: boolean;
  isLargeModel?: boolean;
  forceWasm?: boolean;
  audio?: Float32Array;
  language?: string;
  wordTimestamps?: boolean;
}

interface FileProgressState {
  loaded: number;
  total: number;
  cached: boolean;
}

const TRANSFORMERS_CACHE_NAME = "transformers-cache";
const SILERO_VAD_MODEL_ID = "onnx-community/silero-vad";

let cachedKey: string | null = null;
let cachedPipeline: AutomaticSpeechRecognitionPipeline | null = null;
let webGpuDisabledForSession = false;

let cachedVadModel: PreTrainedModel | null = null;

class SoftCancelError extends Error {
  constructor() {
    super("Transcription cancelled.");
    this.name = "SoftCancelError";
  }
}

const cancelledRequests = new Set<string>();
let activeRequestId: string | null = null;
let activeInterruptCriteria: InterruptableStoppingCriteria | null = null;
let workerQueue: Promise<void> = Promise.resolve();
const patchedInterruptModels = new WeakSet<object>();

function throwIfCancelled(requestId: string): void {
  if (cancelledRequests.has(requestId) || activeInterruptCriteria?.interrupted) {
    throw new SoftCancelError();
  }
}

function attachSoftCancelHooks(instance: AutomaticSpeechRecognitionPipeline): void {
  const model = (instance as unknown as { model?: Record<string, unknown> }).model;
  if (!model || typeof model !== "object" || patchedInterruptModels.has(model)) {
    return;
  }
  patchedInterruptModels.add(model);

  const origGetStoppingCriteria = model._get_stopping_criteria as
    | ((genConfig: unknown, stoppingCriteria?: unknown) => { push: (c: unknown) => void })
    | undefined;
  if (typeof origGetStoppingCriteria === "function") {
    model._get_stopping_criteria = function (
      genConfig: unknown,
      stoppingCriteria?: unknown
    ) {
      const list = origGetStoppingCriteria.call(this, genConfig, stoppingCriteria);
      if (activeInterruptCriteria && list && typeof list.push === "function") {
        list.push(activeInterruptCriteria);
      }
      return list;
    };
  }

  const origGenerate = model.generate as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof origGenerate === "function") {
    model.generate = async function (...args: unknown[]) {
      if (activeInterruptCriteria?.interrupted) {
        throw new SoftCancelError();
      }
      const res = await origGenerate.apply(this, args);
      if (activeInterruptCriteria?.interrupted) {
        throw new SoftCancelError();
      }
      return res;
    };
  }

  const origPrepareEncoderDecoder = model._prepare_encoder_decoder_kwargs_for_generation as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  if (typeof origPrepareEncoderDecoder === "function") {
    model._prepare_encoder_decoder_kwargs_for_generation = async function (...args: unknown[]) {
      if (activeInterruptCriteria?.interrupted) {
        throw new SoftCancelError();
      }
      return origPrepareEncoderDecoder.apply(this, args);
    };
  }
}

async function disposeCachedPipeline(): Promise<void> {
  if (!cachedPipeline) {
    cachedKey = null;
    return;
  }
  try {
    await (cachedPipeline as unknown as { dispose?: () => Promise<void> }).dispose?.();
  } catch {
    // ignore dispose errors
  }
  cachedPipeline = null;
  cachedKey = null;
}

async function hasUsableWebGpu(): Promise<boolean> {
  if (webGpuDisabledForSession) return false;
  try {
    const nav =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & {
            userAgent?: string;
            gpu?: {
              requestAdapter?: () => Promise<{
                requestDevice?: () => Promise<{ destroy?: () => void } | null>;
              } | null>;
            };
          })
        : null;

    // Android Chrome Dawn/WebGPU triggers ORT compute-pipeline & external Instance reference errors on Whisper
    if (nav?.userAgent && /Android/i.test(nav.userAgent)) {
      return false;
    }

    if (!nav?.gpu?.requestAdapter) return false;
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

async function getCachedUrlsForModel(hfModelId: string): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    const needle = `/${hfModelId}/`;
    return keys.map((req) => req.url).filter((url) => url.includes(needle));
  } catch {
    return [];
  }
}

function isFileInCachedUrls(cachedUrls: string[], file?: string): boolean {
  if (!file || cachedUrls.length === 0) return false;
  const cleanFile = file.replace(/^\/+/, "");
  const encodedFile = encodeURI(cleanFile);
  return cachedUrls.some(
    (url) => url.endsWith(`/${cleanFile}`) || url.endsWith(`/${encodedFile}`)
  );
}

async function getWhisperPipeline(
  requestId: string,
  hfModelId: string,
  isLargeModel: boolean,
  forceWasm = false
): Promise<{ instance: AutomaticSpeechRecognitionPipeline; device: "webgpu" | "wasm" }> {
  const preferWebGpu = !forceWasm && (await hasUsableWebGpu());
  const devicesToTry: ("webgpu" | "wasm")[] = preferWebGpu ? ["webgpu", "wasm"] : ["wasm"];

  const cachedUrls = await getCachedUrlsForModel(hfModelId);
  const fileProgress = new Map<string, FileProgressState>();

  const reportDownloadProgress = (info: Record<string, unknown>) => {
    const status = String(info.status || "");
    const file = typeof info.file === "string" ? info.file : undefined;
    const fileCached = isFileInCachedUrls(cachedUrls, file);

    if (file && typeof info.total === "number" && info.total > 0) {
      fileProgress.set(file, {
        loaded: typeof info.loaded === "number" ? info.loaded : 0,
        total: info.total,
        cached: fileCached,
      });
    } else if (file && status === "done") {
      const prev = fileProgress.get(file);
      if (prev && prev.total > 0) {
        fileProgress.set(file, {
          loaded: prev.total,
          total: prev.total,
          cached: prev.cached,
        });
      }
    }

    let downloadLoaded = 0;
    let downloadTotal = 0;
    let hasUncachedTransfer = false;
    let allLoaded = 0;
    let allTotal = 0;

    for (const entry of fileProgress.values()) {
      allLoaded += entry.loaded;
      allTotal += entry.total;
      if (!entry.cached) {
        hasUncachedTransfer = true;
        downloadLoaded += entry.loaded;
        downloadTotal += entry.total;
      }
    }

    // Transformers.js still fires "download" / "progress" events while reading bytes from Cache API.
    // Emit "loading" instead of "downloading" when reading cached files.
    const isDownloading = status !== "ready" && (hasUncachedTransfer || (file ? !fileCached : false));
    const sumLoaded = isDownloading ? downloadLoaded : allLoaded;
    const sumTotal = isDownloading ? downloadTotal : allTotal;

    const rawPct =
      sumTotal > 0
        ? Math.round((sumLoaded / sumTotal) * 100)
        : typeof info.progress === "number"
          ? Math.round(info.progress)
          : status === "ready"
            ? 100
            : 0;

    self.postMessage({
      type: "progress",
      requestId,
      phase: isDownloading ? "downloading" : "loading",
      file,
      loadedBytes: sumLoaded > 0 ? sumLoaded : undefined,
      totalBytes: sumTotal > 0 ? sumTotal : undefined,
      percent: Math.max(0, Math.min(100, rawPct)),
    });
  };

  let lastError: unknown = null;
  for (const device of devicesToTry) {
    const key = `${hfModelId}::${device}`;
    if (cachedPipeline && cachedKey === key) {
      return { instance: cachedPipeline, device };
    }

    if (cachedPipeline && cachedKey !== key) {
      await disposeCachedPipeline();
    }

    try {
      const dtype = getWhisperDtypeConfig(device, isLargeModel);
      const instance = (await (pipeline as unknown as (
        task: string,
        model: string,
        opts: Record<string, unknown>
      ) => Promise<AutomaticSpeechRecognitionPipeline>)(
        "automatic-speech-recognition",
        hfModelId,
        {
          device,
          dtype,
          progress_callback: reportDownloadProgress,
        }
      )) as AutomaticSpeechRecognitionPipeline;

      attachSoftCancelHooks(instance);
      cachedPipeline = instance;
      cachedKey = key;
      return { instance, device };
    } catch (err) {
      lastError = err;
      if (device === "webgpu") {
        webGpuDisabledForSession = true;
      }
      await disposeCachedPipeline();
      fileProgress.clear();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "Failed to load Whisper model."));
}

function pickSpeechWindowForLangDetect(audio: Float32Array, sampleRate = 16000): Float32Array {
  const windowSamples = sampleRate * 30;
  if (audio.length <= windowSamples) {
    return audio;
  }

  const hopSamples = sampleRate * 5;
  const maxStart = audio.length - windowSamples;
  const scanLimit = Math.min(maxStart, sampleRate * 240);
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start <= scanLimit; start += hopSamples) {
    let activeFrames = 0;
    let energySum = 0;
    const secStep = sampleRate;
    for (let secOffset = 0; secOffset < windowSamples; secOffset += secStep) {
      let frameSq = 0;
      let count = 0;
      const frameEnd = Math.min(start + secOffset + secStep, audio.length);
      for (let i = start + secOffset; i < frameEnd; i += 16) {
        const v = audio[i];
        frameSq += v * v;
        count++;
      }
      const rms = count > 0 ? Math.sqrt(frameSq / count) : 0;
      energySum += rms;
      if (rms > 0.012) {
        activeFrames++;
      }
    }
    const score = activeFrames * 10 + energySum;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return audio.subarray(bestStart, bestStart + windowSamples);
}

interface WhisperInternals {
  processor?: (audio: Float32Array) => Promise<{ input_features?: Tensor }>;
  model?: {
    config?: { decoder_start_token_id?: number };
    generation_config?: {
      is_multilingual?: boolean;
      decoder_start_token_id?: number;
      lang_to_id?: Record<string, number>;
    };
    forward?: (inputs: Record<string, unknown>) => Promise<{
      logits?: Tensor;
      past_key_values?: unknown;
    }>;
  };
}

function disposeTensorLike(val: unknown): void {
  if (!val || typeof val !== "object") return;
  const maybeTensor = val as { dispose?: () => void };
  if (typeof maybeTensor.dispose === "function") {
    try {
      maybeTensor.dispose();
    } catch {
      // ignore dispose errors
    }
  }
}

async function detectSpokenLanguage(
  instance: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array
): Promise<string | null> {
  const internals = instance as unknown as WhisperInternals;
  const processor = internals.processor;
  const model = internals.model;
  const genConfig = model?.generation_config;
  const langToId = genConfig?.lang_to_id;

  if (
    !genConfig?.is_multilingual ||
    !langToId ||
    typeof processor !== "function" ||
    typeof model?.forward !== "function"
  ) {
    return null;
  }

  let inputFeatures: Tensor | undefined;
  let decoderInputIds: Tensor | undefined;
  let outLogits: Tensor | undefined;
  let floatLogits: Tensor | undefined;
  let pastKeyValues: unknown;

  try {
    const speechWindow = pickSpeechWindowForLangDetect(audio);
    const feature = await processor(speechWindow);
    inputFeatures = feature?.input_features;
    if (!inputFeatures) return null;

    const decoderStartTokenId = Number(
      genConfig.decoder_start_token_id ?? model.config?.decoder_start_token_id ?? 50258
    );
    decoderInputIds = new Tensor(
      "int64",
      new BigInt64Array([BigInt(decoderStartTokenId)]),
      [1, 1]
    );

    const out = await model.forward({
      input_features: inputFeatures,
      decoder_input_ids: decoderInputIds,
    });
    outLogits = out?.logits;
    pastKeyValues = out?.past_key_values;
    if (!outLogits) return null;

    floatLogits = outLogits.type === "float32" ? outLogits : outLogits.to("float32");
    const data = floatLogits.data as Float32Array | number[];
    const dims = floatLogits.dims;
    const vocabSize = dims.length > 0 ? dims[dims.length - 1] : data.length;
    const offset = Math.max(0, data.length - vocabSize);

    let bestLangCode: string | null = null;
    let bestScore = -Infinity;

    for (const [token, tokenId] of Object.entries(langToId)) {
      if (
        typeof tokenId !== "number" ||
        tokenId < 0 ||
        offset + tokenId >= data.length ||
        !token.startsWith("<|") ||
        !token.endsWith("|>")
      ) {
        continue;
      }
      const score = Number(data[offset + tokenId]);
      if (Number.isFinite(score) && score > bestScore) {
        bestScore = score;
        bestLangCode = token.slice(2, -2);
      }
    }

    return bestLangCode;
  } finally {
    disposeTensorLike(inputFeatures);
    disposeTensorLike(decoderInputIds);
    if (floatLogits && floatLogits !== outLogits) {
      disposeTensorLike(floatLogits);
    }
    disposeTensorLike(outLogits);
    if (pastKeyValues && typeof pastKeyValues === "object") {
      for (const entry of Object.values(pastKeyValues as Record<string, unknown>)) {
        disposeTensorLike(entry);
      }
    }
  }
}

function countWhisperChunks(
  audioLength: number,
  samplingRate = 16000,
  chunkLengthS = 30,
  strideLengthS = 5
): number {
  const windowSamples = samplingRate * chunkLengthS;
  if (audioLength <= windowSamples) return 1;
  const strideSamples = samplingRate * strideLengthS;
  const jumpSamples = Math.max(samplingRate, windowSamples - 2 * strideSamples);
  let total = 0;
  let offset = 0;
  while (true) {
    total++;
    if (offset + windowSamples >= audioLength) break;
    offset += jumpSamples;
  }
  return Math.max(1, total);
}

function mergeStreamingChunkWithOverlap(committed: string, nextChunk: string): string {
  const prev = committed.trim();
  const next = nextChunk.trim();
  if (!prev) return next;
  if (!next) return prev;

  const maxCheck = Math.min(80, prev.length, next.length);
  for (let len = maxCheck; len >= 6; len--) {
    const tail = prev.slice(prev.length - len);
    if (next.slice(0, len).toLowerCase() === tail.toLowerCase()) {
      const remainder = next.slice(len).trimStart();
      if (!remainder) return prev;
      const needsSpace =
        /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(remainder);
      return needsSpace ? `${prev} ${remainder}` : `${prev}${remainder}`;
    }
  }

  return `${prev} ${next}`;
}

function createWhisperProgressStreamer(
  instance: AutomaticSpeechRecognitionPipeline,
  requestId: string,
  device: "webgpu" | "wasm",
  totalChunks: number,
  detectedLanguage?: string | null
): WhisperTextStreamer | undefined {
  const tokenizer = (instance as unknown as {
    tokenizer?: ConstructorParameters<typeof WhisperTextStreamer>[0];
  }).tokenizer;
  if (!tokenizer) return undefined;

  let completedChunks = 0;
  let committedText = "";
  let activeChunkText = "";
  let intraChunkFrac = 0;
  let lastPostAt = 0;

  const emitStreamingUpdate = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPostAt < 160) return;
    lastPostAt = now;

    const currentChunk = Math.min(totalChunks, completedChunks + 1);
    const overallFrac = Math.min(
      0.99,
      (completedChunks + intraChunkFrac) / Math.max(1, totalChunks)
    );
    const percent = Math.round(overallFrac * 100);
    const previewCombined = activeChunkText.trim()
      ? mergeStreamingChunkWithOverlap(committedText, activeChunkText)
      : committedText;

    self.postMessage({
      type: "progress",
      requestId,
      phase: "transcribing",
      percent,
      chunkIndex: currentChunk,
      totalChunks,
      partialText: previewCombined.slice(-900),
      detectedLanguage: detectedLanguage ?? undefined,
      device,
    });
  };

  const streamer = new WhisperTextStreamer(tokenizer, {
    skip_prompt: true,
    callback_function: (textPiece: string) => {
      if (!textPiece) return;
      activeChunkText += textPiece;
      emitStreamingUpdate(false);
    },
    on_chunk_end: (localSec: number) => {
      if (Number.isFinite(localSec) && localSec >= 0) {
        intraChunkFrac = Math.max(intraChunkFrac, Math.min(0.95, localSec / 30));
        emitStreamingUpdate(false);
      }
    },
    on_finalize: () => {
      // Reset timestamp state between overlapping 30s chunks in WhisperTextStreamer
      (streamer as unknown as { waiting_for_timestamp?: boolean }).waiting_for_timestamp = false;
      if (activeChunkText.trim()) {
        committedText = mergeStreamingChunkWithOverlap(committedText, activeChunkText);
      }
      activeChunkText = "";
      completedChunks = Math.min(totalChunks, completedChunks + 1);
      intraChunkFrac = 0;
      emitStreamingUpdate(true);
    },
  });

  return streamer;
}

function yieldWorkerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function getSileroVadModel(): Promise<PreTrainedModel> {
  if (cachedVadModel) {
    return cachedVadModel;
  }
  const model = await AutoModel.from_pretrained(SILERO_VAD_MODEL_ID, {
    config: { model_type: "custom" } as never,
    dtype: "fp32",
    device: "wasm",
  });
  cachedVadModel = model;
  return model;
}

interface VadRegionMap {
  origStartSec: number;
  origEndSec: number;
  vadStartSec: number;
  vadEndSec: number;
}

interface VadPreprocessResult {
  audio: Float32Array;
  regions: VadRegionMap[] | null;
  noSpeechDetected: boolean;
}

async function runSileroVadSegmentation(
  audio: Float32Array,
  requestId: string,
  device: "webgpu" | "wasm"
): Promise<VadPreprocessResult> {
  const SAMPLE_RATE = 16000;
  const FRAME_SAMPLES = 512; // 32ms at 16kHz
  const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
  const durationSec = audio.length / SAMPLE_RATE;

  if (durationSec < 1.0) {
    return { audio, regions: null, noSpeechDetected: false };
  }

  let vadModel: PreTrainedModel;
  try {
    vadModel = await getSileroVadModel();
  } catch {
    // Graceful fallback when VAD cannot be fetched (e.g. strictly offline first-time run)
    return { audio, regions: null, noSpeechDetected: false };
  }

  throwIfCancelled(requestId);

  const forwardFn = (
    vadModel as unknown as {
      forward: (inputs: Record<string, Tensor>) => Promise<Record<string, Tensor>>;
    }
  ).forward.bind(vadModel);

  const totalFrames = Math.ceil(audio.length / FRAME_SAMPLES);
  const probs = new Float32Array(totalFrames);

  let state: Tensor = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  let srTensor: Tensor = new Tensor("int64", new BigInt64Array([BigInt(SAMPLE_RATE)]), []);
  let use1DSrFallback = false;

  try {
    for (let f = 0; f < totalFrames; f++) {
      if (f > 0 && f % 64 === 0) {
        await yieldWorkerTurn();
        throwIfCancelled(requestId);
        const scanPct = Math.min(8, Math.max(1, Math.round((f / totalFrames) * 8)));
        self.postMessage({
          type: "progress",
          requestId,
          phase: "transcribing",
          stageLabel: "Scanning speech (Silero VAD)...",
          percent: scanPct,
          device,
        });
      }

      const start = f * FRAME_SAMPLES;
      const end = Math.min(audio.length, start + FRAME_SAMPLES);
      const frame = new Float32Array(FRAME_SAMPLES);
      frame.set(audio.subarray(start, end));

      const inputTensor = new Tensor("float32", frame, [1, FRAME_SAMPLES]);
      let outputs: Record<string, Tensor> | undefined;
      try {
        outputs = await forwardFn({
          input: inputTensor,
          state,
          sr: srTensor,
        });
      } catch (err) {
        if (f === 0 && !use1DSrFallback) {
          use1DSrFallback = true;
          disposeTensorLike(srTensor);
          srTensor = new Tensor("int64", new BigInt64Array([BigInt(SAMPLE_RATE)]), [1]);
          outputs = await forwardFn({
            input: inputTensor,
            state,
            sr: srTensor,
          });
        } else {
          disposeTensorLike(inputTensor);
          throw err;
        }
      }

      disposeTensorLike(inputTensor);

      const probTensor = outputs?.output;
      const probVal = probTensor ? Number((probTensor.data as Float32Array)[0]) : 0;
      probs[f] = Number.isFinite(probVal) ? probVal : 0;
      disposeTensorLike(probTensor);

      const nextState = outputs?.stateN ?? outputs?.state ?? outputs?.hn;
      if (nextState && nextState !== state) {
        disposeTensorLike(state);
        state = nextState;
      }
    }
  } catch (err) {
    if (err instanceof SoftCancelError) throw err;
    // Fallback cleanly to full audio if Silero ONNX execution hits an unexpected error
    return { audio, regions: null, noSpeechDetected: false };
  } finally {
    disposeTensorLike(state);
    disposeTensorLike(srTensor);
  }

  throwIfCancelled(requestId);

  // Hysteresis state machine with padding & gap merging
  const SPEECH_START_PROB = 0.34;
  const SPEECH_END_PROB = 0.18;
  const MIN_SPEECH_FRAMES = Math.ceil(200 / FRAME_MS);
  const MIN_SILENCE_FRAMES = Math.ceil(450 / FRAME_MS);
  const PAD_SEC = 0.25;
  const MERGE_GAP_SEC = 0.6;
  const INTER_REGION_SILENCE_SEC = 0.35;

  const rawSpans: Array<{ startSec: number; endSec: number }> = [];
  let inSpeech = false;
  let speechStartFrame = 0;
  let silenceFrames = 0;

  for (let f = 0; f < totalFrames; f++) {
    const p = probs[f];
    if (!inSpeech) {
      if (p >= SPEECH_START_PROB) {
        inSpeech = true;
        speechStartFrame = f;
        silenceFrames = 0;
      }
    } else if (p < SPEECH_END_PROB) {
      silenceFrames++;
      if (silenceFrames >= MIN_SILENCE_FRAMES) {
        const speechEndFrame = f - silenceFrames + 1;
        if (speechEndFrame - speechStartFrame >= MIN_SPEECH_FRAMES) {
          rawSpans.push({
            startSec: Math.max(0, (speechStartFrame * FRAME_SAMPLES) / SAMPLE_RATE - PAD_SEC),
            endSec: Math.min(durationSec, (speechEndFrame * FRAME_SAMPLES) / SAMPLE_RATE + PAD_SEC),
          });
        }
        inSpeech = false;
        silenceFrames = 0;
      }
    } else {
      silenceFrames = 0;
    }
  }

  if (inSpeech) {
    const speechEndFrame = totalFrames - silenceFrames;
    if (speechEndFrame - speechStartFrame >= MIN_SPEECH_FRAMES) {
      rawSpans.push({
        startSec: Math.max(0, (speechStartFrame * FRAME_SAMPLES) / SAMPLE_RATE - PAD_SEC),
        endSec: Math.min(durationSec, (speechEndFrame * FRAME_SAMPLES) / SAMPLE_RATE + PAD_SEC),
      });
    }
  }

  if (rawSpans.length === 0) {
    return {
      audio: new Float32Array(0),
      regions: [],
      noSpeechDetected: true,
    };
  }

  // Merge adjacent/close speech spans
  const merged: Array<{ startSec: number; endSec: number }> = [rawSpans[0]];
  for (let i = 1; i < rawSpans.length; i++) {
    const cur = rawSpans[i];
    const prev = merged[merged.length - 1];
    if (cur.startSec - prev.endSec <= MERGE_GAP_SEC) {
      prev.endSec = Math.max(prev.endSec, cur.endSec);
    } else {
      merged.push({ ...cur });
    }
  }

  const keptSpeechSec = merged.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
  if (
    keptSpeechSec >= durationSec * 0.88 ||
    (merged.length === 1 && merged[0].startSec <= 0.25 && merged[0].endSec >= durationSec - 0.25)
  ) {
    return { audio, regions: null, noSpeechDetected: false };
  }

  // Concatenate speech regions with 0.35s zero separators for clean Whisper boundaries
  const sepSamples = Math.round(INTER_REGION_SILENCE_SEC * SAMPLE_RATE);
  let totalSamples = 0;
  const regionSlices: Array<{ startSample: number; endSample: number }> = [];

  for (let i = 0; i < merged.length; i++) {
    const sIdx = Math.max(0, Math.floor(merged[i].startSec * SAMPLE_RATE));
    const eIdx = Math.min(audio.length, Math.ceil(merged[i].endSec * SAMPLE_RATE));
    if (eIdx <= sIdx) continue;
    regionSlices.push({ startSample: sIdx, endSample: eIdx });
    totalSamples += eIdx - sIdx;
    if (i < merged.length - 1) {
      totalSamples += sepSamples;
    }
  }

  if (regionSlices.length === 0 || totalSamples === 0) {
    return { audio, regions: null, noSpeechDetected: false };
  }

  const vadAudio = new Float32Array(totalSamples);
  const regions: VadRegionMap[] = [];
  let writeOffset = 0;

  for (let i = 0; i < regionSlices.length; i++) {
    const slice = regionSlices[i];
    const len = slice.endSample - slice.startSample;
    vadAudio.set(audio.subarray(slice.startSample, slice.endSample), writeOffset);
    regions.push({
      origStartSec: slice.startSample / SAMPLE_RATE,
      origEndSec: slice.endSample / SAMPLE_RATE,
      vadStartSec: writeOffset / SAMPLE_RATE,
      vadEndSec: (writeOffset + len) / SAMPLE_RATE,
    });
    writeOffset += len;
    if (i < regionSlices.length - 1) {
      writeOffset += sepSamples;
    }
  }

  return {
    audio: vadAudio,
    regions,
    noSpeechDetected: false,
  };
}

function mapVadTimePoint(
  vadSec: number,
  regions: VadRegionMap[],
  prefer: "start" | "end"
): number {
  if (regions.length === 0) return vadSec;
  if (vadSec <= regions[0].vadStartSec) {
    return regions[0].origStartSec;
  }

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (vadSec >= r.vadStartSec && vadSec <= r.vadEndSec) {
      return r.origStartSec + (vadSec - r.vadStartSec);
    }
    if (i < regions.length - 1) {
      const next = regions[i + 1];
      if (vadSec > r.vadEndSec && vadSec < next.vadStartSec) {
        return prefer === "start" ? next.origStartSec : r.origEndSec;
      }
    }
  }

  return regions[regions.length - 1].origEndSec;
}

function remapWhisperOutputTimestamps(
  output: unknown,
  regions: VadRegionMap[] | null,
  origDurationSec: number
): unknown {
  if (!regions || regions.length === 0 || !output || typeof output !== "object") {
    return output;
  }

  const outObj = output as {
    text?: string;
    chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
  };

  if (!Array.isArray(outObj.chunks) || outObj.chunks.length === 0) {
    return output;
  }

  const mappedChunks = outObj.chunks.map((ch) => {
    const ts = ch.timestamp;
    if (!Array.isArray(ts)) return ch;

    const rawStart = typeof ts[0] === "number" ? ts[0] : null;
    const rawEnd = typeof ts[1] === "number" ? ts[1] : null;

    if (rawStart === null && rawEnd === null) return ch;

    let mappedStart: number | null =
      rawStart !== null ? mapVadTimePoint(rawStart, regions, "start") : null;
    let mappedEnd: number | null =
      rawEnd !== null ? mapVadTimePoint(rawEnd, regions, "end") : null;

    if (mappedStart !== null && mappedEnd !== null && mappedEnd < mappedStart) {
      // Both boundaries fell inside a separator gap; anchor to the nearest region edge
      const mid = ((rawStart ?? 0) + (rawEnd ?? 0)) / 2;
      const anchored = mapVadTimePoint(mid, regions, "end");
      mappedStart = anchored;
      mappedEnd = Math.min(origDurationSec, anchored + 0.05);
    }

    return {
      ...ch,
      timestamp: [
        mappedStart !== null ? Number(Math.max(0, Math.min(origDurationSec, mappedStart)).toFixed(2)) : null,
        mappedEnd !== null ? Number(Math.max(0, Math.min(origDurationSec, mappedEnd)).toFixed(2)) : null,
      ] as [number | null, number | null],
    };
  });

  return {
    ...outObj,
    chunks: mappedChunks,
  };
}

function buildTranscribeOptions(
  msg: WorkerRequest,
  detectedLanguage?: string | null,
  streamer?: WhisperTextStreamer
): Record<string, unknown> {
  const transcribeOpts: Record<string, unknown> = {
    return_timestamps: msg.wordTimestamps ? "word" : true,
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(streamer ? { streamer } : {}),
  };

  if (!msg.isEnglishOnly) {
    transcribeOpts.task = "transcribe";
    if (msg.language && msg.language !== "auto") {
      transcribeOpts.language = msg.language;
    } else if (detectedLanguage) {
      transcribeOpts.language = detectedLanguage;
    }
  }
  return transcribeOpts;
}

async function handleWorkerRequest(msg: WorkerRequest): Promise<void> {
  if (!msg.hfModelId) {
    throw new Error("Missing Whisper model identifier.");
  }

  activeRequestId = msg.requestId;
  activeInterruptCriteria = new InterruptableStoppingCriteria();

  try {
    throwIfCancelled(msg.requestId);

    const forceWasm = Boolean(msg.forceWasm || webGpuDisabledForSession);
    const { instance, device } = await getWhisperPipeline(
      msg.requestId,
      msg.hfModelId,
      Boolean(msg.isLargeModel),
      forceWasm
    );

    throwIfCancelled(msg.requestId);

    if (msg.type === "download") {
      // Best-effort pre-cache of lightweight Silero VAD (~2MB) for offline accuracy
      await getSileroVadModel().catch(() => {});
      self.postMessage({
        type: "downloaded",
        requestId: msg.requestId,
        device,
      });
      return;
    }

    if (!msg.audio || msg.audio.length === 0) {
      throw new Error("No audio samples found to transcribe.");
    }

    const origDurationSec = msg.audio.length / 16000;

    self.postMessage({
      type: "progress",
      requestId: msg.requestId,
      phase: "transcribing",
      stageLabel: "Scanning speech (Silero VAD)...",
      percent: 1,
      device,
    });

    const vadResult = await runSileroVadSegmentation(msg.audio, msg.requestId, device);
    throwIfCancelled(msg.requestId);

    if (vadResult.noSpeechDetected || vadResult.audio.length === 0) {
      self.postMessage({
        type: "complete",
        requestId: msg.requestId,
        device,
        output: { text: "", chunks: [] },
      });
      return;
    }

    const transcribeAudio = vadResult.audio;
    const totalChunks = countWhisperChunks(transcribeAudio.length);
    const needsAutoDetect =
      !msg.isEnglishOnly && (!msg.language || msg.language === "auto");

    let result: unknown;
    let usedDevice: "webgpu" | "wasm" = device;
    let detectedLang: string | null = null;

    self.postMessage({
      type: "progress",
      requestId: msg.requestId,
      phase: "transcribing",
      percent: 8,
      chunkIndex: 1,
      totalChunks,
      device,
    });

    try {
      if (needsAutoDetect) {
        detectedLang = await detectSpokenLanguage(instance, transcribeAudio).catch(() => null);
        throwIfCancelled(msg.requestId);
        if (detectedLang) {
          self.postMessage({
            type: "progress",
            requestId: msg.requestId,
            phase: "transcribing",
            percent: 9,
            chunkIndex: 1,
            totalChunks,
            detectedLanguage: detectedLang,
            device,
          });
        }
      }
      const streamer = createWhisperProgressStreamer(
        instance,
        msg.requestId,
        device,
        totalChunks,
        detectedLang
      );
      const transcribeOpts = buildTranscribeOptions(msg, detectedLang, streamer);
      result = await instance(transcribeAudio, transcribeOpts);
      throwIfCancelled(msg.requestId);
    } catch (inferErr) {
      if (inferErr instanceof SoftCancelError || cancelledRequests.has(msg.requestId)) {
        throw new SoftCancelError();
      }
      // WebGPU ORT inference failures (e.g. WGPUBuffer / external Instance reference lost on mobile/Chrome)
      if (device === "webgpu") {
        webGpuDisabledForSession = true;
        await disposeCachedPipeline();

        self.postMessage({
          type: "progress",
          requestId: msg.requestId,
          phase: "loading",
          percent: 55,
          device: "wasm",
        });

        const wasmPipe = await getWhisperPipeline(
          msg.requestId,
          msg.hfModelId,
          Boolean(msg.isLargeModel),
          true
        );

        throwIfCancelled(msg.requestId);

        if (needsAutoDetect && !detectedLang) {
          detectedLang = await detectSpokenLanguage(wasmPipe.instance, transcribeAudio).catch(
            () => null
          );
          throwIfCancelled(msg.requestId);
        }

        self.postMessage({
          type: "progress",
          requestId: msg.requestId,
          phase: "transcribing",
          percent: 9,
          chunkIndex: 1,
          totalChunks,
          detectedLanguage: detectedLang ?? undefined,
          device: "wasm",
        });

        const wasmStreamer = createWhisperProgressStreamer(
          wasmPipe.instance,
          msg.requestId,
          wasmPipe.device,
          totalChunks,
          detectedLang
        );
        const wasmTranscribeOpts = buildTranscribeOptions(
          msg,
          detectedLang,
          wasmStreamer
        );
        usedDevice = wasmPipe.device;
        result = await wasmPipe.instance(transcribeAudio, wasmTranscribeOpts);
        throwIfCancelled(msg.requestId);
      } else {
        throw inferErr;
      }
    }

    const rawNormalized = Array.isArray(result) ? result[0] : result;
    const normalized = remapWhisperOutputTimestamps(
      rawNormalized,
      vadResult.regions,
      origDurationSec
    );

    self.postMessage({
      type: "complete",
      requestId: msg.requestId,
      device: usedDevice,
      detectedLanguage: detectedLang ?? undefined,
      output: normalized,
    });
  } catch (err) {
    if (err instanceof SoftCancelError || cancelledRequests.has(msg.requestId)) {
      self.postMessage({
        type: "cancelled",
        requestId: msg.requestId,
      });
      return;
    }
    self.postMessage({
      type: "error",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err || "Whisper transcription failed."),
    });
  } finally {
    cancelledRequests.delete(msg.requestId);
    if (activeRequestId === msg.requestId) {
      activeRequestId = null;
      activeInterruptCriteria = null;
    }
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  if (msg.type === "cancel") {
    cancelledRequests.add(msg.requestId);
    if (activeRequestId === msg.requestId && activeInterruptCriteria) {
      activeInterruptCriteria.interrupt();
    }
    return;
  }

  workerQueue = workerQueue
    .catch(() => {})
    .then(() => handleWorkerRequest(msg));
});
