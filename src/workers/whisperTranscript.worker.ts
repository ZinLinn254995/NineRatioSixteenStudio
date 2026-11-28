import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

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
}

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

function getDtypeForRun(device: "webgpu" | "wasm", isLargeModel: boolean) {
  if (device === "webgpu") {
    return isLargeModel
      ? ({ encoder_model: "fp16", decoder_model_merged: "q4" } as const)
      : ({ encoder_model: "fp32", decoder_model_merged: "q4" } as const);
  }
  return isLargeModel ? ("q4" as const) : ("q8" as const);
}

async function getWhisperPipeline(
  requestId: string,
  hfModelId: string,
  isLargeModel: boolean,
  forceWasm = false
): Promise<{ instance: AutomaticSpeechRecognitionPipeline; device: "webgpu" | "wasm" }> {
  const preferWebGpu = !forceWasm && (await hasUsableWebGpu());
  const devicesToTry: ("webgpu" | "wasm")[] = preferWebGpu ? ["webgpu", "wasm"] : ["wasm"];

  const fileProgress = new Map<string, FileProgressState>();
  const reportDownloadProgress = (info: Record<string, unknown>) => {
    const status = String(info.status || "");
    const file = typeof info.file === "string" ? info.file : undefined;
    if (file && typeof info.total === "number" && info.total > 0) {
      fileProgress.set(file, {
        loaded: typeof info.loaded === "number" ? info.loaded : 0,
        total: info.total,
      });
    } else if (file && status === "done") {
      const prev = fileProgress.get(file);
      if (prev && prev.total > 0) {
        fileProgress.set(file, { loaded: prev.total, total: prev.total });
      }
    }

    let sumLoaded = 0;
    let sumTotal = 0;
    for (const entry of fileProgress.values()) {
      sumLoaded += entry.loaded;
      sumTotal += entry.total;
    }

    const rawPct =
      sumTotal > 0
        ? Math.round((sumLoaded / sumTotal) * 100)
        : typeof info.progress === "number"
          ? Math.round(info.progress)
          : 0;

    self.postMessage({
      type: "progress",
      requestId,
      phase: status === "ready" ? "loading" : "downloading",
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
      const dtype = getDtypeForRun(device, isLargeModel);
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

function buildTranscribeOptions(msg: WorkerRequest): Record<string, unknown> {
  const transcribeOpts: Record<string, unknown> = {
    return_timestamps: msg.wordTimestamps ? "word" : true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };

  if (!msg.isEnglishOnly) {
    transcribeOpts.task = "transcribe";
    if (msg.language && msg.language !== "auto") {
      transcribeOpts.language = msg.language;
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

    const transcribeOpts = buildTranscribeOptions(msg);

    self.postMessage({
      type: "progress",
      requestId: msg.requestId,
      phase: "transcribing",
      percent: 82,
      device,
    });

    let result: unknown;
    let usedDevice: "webgpu" | "wasm" = device;

    try {
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

        usedDevice = wasmPipe.device;
        result = await wasmPipe.instance(msg.audio, transcribeOpts);
      } else {
        throw inferErr;
      }
    }

    const normalized = Array.isArray(result) ? result[0] : result;

    self.postMessage({
      type: "complete",
      requestId: msg.requestId,
      device: usedDevice,
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
