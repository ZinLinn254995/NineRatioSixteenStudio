import {
  pipeline,
  env,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
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
  type: "download" | "transcribe";
  requestId: string;
  hfModelId: string;
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

let cachedKey: string | null = null;
let cachedPipeline: AutomaticSpeechRecognitionPipeline | null = null;
let webGpuDisabledForSession = false;

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

function buildTranscribeOptions(
  msg: WorkerRequest,
  detectedLanguage?: string | null
): Record<string, unknown> {
  const transcribeOpts: Record<string, unknown> = {
    return_timestamps: msg.wordTimestamps ? "word" : true,
    chunk_length_s: 30,
    stride_length_s: 5,
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

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  try {
    const forceWasm = Boolean(msg.forceWasm || webGpuDisabledForSession);
    const { instance, device } = await getWhisperPipeline(
      msg.requestId,
      msg.hfModelId,
      Boolean(msg.isLargeModel),
      forceWasm
    );

    if (msg.type === "download") {
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

    self.postMessage({
      type: "progress",
      requestId: msg.requestId,
      phase: "transcribing",
      percent: 82,
      device,
    });

    const needsAutoDetect =
      !msg.isEnglishOnly && (!msg.language || msg.language === "auto");

    let result: unknown;
    let usedDevice: "webgpu" | "wasm" = device;
    let detectedLang: string | null = null;

    try {
      if (needsAutoDetect) {
        detectedLang = await detectSpokenLanguage(instance, msg.audio).catch(() => null);
      }
      const transcribeOpts = buildTranscribeOptions(msg, detectedLang);
      result = await instance(msg.audio, transcribeOpts);
    } catch (inferErr) {
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

        self.postMessage({
          type: "progress",
          requestId: msg.requestId,
          phase: "transcribing",
          percent: 82,
          device: "wasm",
        });

        if (needsAutoDetect && !detectedLang) {
          detectedLang = await detectSpokenLanguage(wasmPipe.instance, msg.audio).catch(
            () => null
          );
        }
        const wasmTranscribeOpts = buildTranscribeOptions(msg, detectedLang);
        usedDevice = wasmPipe.device;
        result = await wasmPipe.instance(msg.audio, wasmTranscribeOpts);
      } else {
        throw inferErr;
      }
    }

    const normalized = Array.isArray(result) ? result[0] : result;

    self.postMessage({
      type: "complete",
      requestId: msg.requestId,
      device: usedDevice,
      detectedLanguage: detectedLang ?? undefined,
      output: normalized,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err || "Whisper transcription failed."),
    });
  }
});
