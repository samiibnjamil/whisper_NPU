// Registry of transcription engines. Adding a new engine means adding an entry here plus a
// matching Python script that speaks the same newline-delimited JSON progress-event contract
// (see whisper_npu.py / vibevoice_asr.py).
export const ENGINES = {
  whisper: {
    label: "Whisper (Intel NPU)",
    script: "whisper_npu.py",
    defaultModel: "medium",
    models: {
      medium: { folder: "whisper-medium-en-openvino-stateless", label: "Whisper Medium.en", detail: "Higher accuracy" },
      small: { folder: "whisper-small-openvino-stateless", label: "Whisper Small", detail: "Faster" },
    },
  },
  vibevoice: {
    label: "VibeVoice BitNet (CPU)",
    script: "vibevoice_asr.py",
    defaultModel: "bitnet",
    models: {
      bitnet: { folder: "vibevoice-asr-bitnet", label: "VibeVoice ASR BitNet", detail: "Quantized, CPU-only" },
    },
  },
};

export function resolveEngineModel(engineKey, modelKey) {
  const engine = ENGINES[engineKey];
  if (!engine) return null;
  const model = engine.models[modelKey];
  if (!model) return null;
  return { engine, model };
}
