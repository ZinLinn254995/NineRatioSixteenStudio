export type WhisperRuntimeDevice = "webgpu" | "wasm";

export type WhisperConcreteDtype = "fp32" | "fp16" | "q8" | "q4";

export interface WhisperModelDtypeMap {
  encoder_model: WhisperConcreteDtype;
  decoder_model_merged: WhisperConcreteDtype;
}

const DTYPE_SUFFIX_MAP: Record<WhisperConcreteDtype, string> = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  q4: "_q4",
};

/**
 * Use full fp32 precision for the audio mel encoder on all standard Whisper models
 * (tiny, base, small, tiny.en) across both WebGPU and WASM so INT8 encoder quantization
 * never degrades acoustic features, while keeping the decoder compact (q8 on WASM, q4 on WebGPU).
 */
export function getWhisperDtypeConfig(
  device: WhisperRuntimeDevice,
  isLargeModel: boolean
): WhisperModelDtypeMap {
  if (device === "webgpu") {
    return isLargeModel
      ? { encoder_model: "fp16", decoder_model_merged: "q4" }
      : { encoder_model: "fp32", decoder_model_merged: "q4" };
  }
  return isLargeModel
    ? { encoder_model: "q4", decoder_model_merged: "q4" }
    : { encoder_model: "fp32", decoder_model_merged: "q8" };
}

export function getRequiredWhisperOnnxFiles(
  device: WhisperRuntimeDevice,
  isLargeModel: boolean
): [string, string] {
  const dtype = getWhisperDtypeConfig(device, isLargeModel);
  const encSuffix = DTYPE_SUFFIX_MAP[dtype.encoder_model] ?? "";
  const decSuffix = DTYPE_SUFFIX_MAP[dtype.decoder_model_merged] ?? "";
  return [
    `onnx/encoder_model${encSuffix}.onnx`,
    `onnx/decoder_model_merged${decSuffix}.onnx`,
  ];
}
