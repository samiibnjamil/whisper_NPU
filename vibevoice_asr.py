"""
Run Microsoft VibeVoice-ASR-BitNet locally on CPU via the VibeASR.cpp `asr_infer` CLI.

Unlike the OpenVINO Whisper pipeline, this is a quantized (I8_S + I2_S) ASR model that
runs entirely on CPU threads -- no GPU/NPU required. See:
  https://huggingface.co/microsoft/VibeVoice-ASR-BitNet
  https://github.com/microsoft/VibeASR.cpp

Usage:
  .\\.venv\\Scripts\\python vibevoice_asr.py --audio path/to/audio.wav --model-dir models/vibevoice-asr-bitnet
"""

import argparse
import os
import subprocess
import time
from pathlib import Path

from system_usage import emit_progress, start_usage_emitter

VAE_MODEL_FILENAME = "vibeasr-vae-encoder-i8_s.gguf"
LM_MODEL_FILENAME = "vibeasr-lm-i2_s-embed-q6_k.gguf"
DEFAULT_BINARY = Path(__file__).parent / "third_party" / "VibeASR.cpp" / "build" / "bin" / "asr_infer.exe"
MINGW_BIN_DIR = Path("C:/msys64/mingw64/bin")


def build_runtime_env() -> dict:
    """asr_infer.exe is linked against MinGW runtime DLLs (libgomp, libstdc++, etc.)."""
    env = os.environ.copy()
    if MINGW_BIN_DIR.exists():
        env["PATH"] = f"{MINGW_BIN_DIR};{env.get('PATH', '')}"
    return env


def main() -> None:
    parser = argparse.ArgumentParser(description="Run VibeVoice-ASR-BitNet (CPU) via VibeASR.cpp")
    parser.add_argument("--audio", required=False, type=Path, help="Path to a WAV file to transcribe.")
    parser.add_argument(
        "--model-dir",
        default=Path("models") / "vibevoice-asr-bitnet",
        type=Path,
        help="Directory containing the two VibeVoice-ASR-BitNet GGUF files.",
    )
    parser.add_argument("--binary", default=DEFAULT_BINARY, type=Path, help="Path to the built asr_infer executable.")
    parser.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    parser.add_argument("--progress-json", action="store_true")
    parser.add_argument("--emit-usage", action="store_true")
    parser.add_argument(
        "--preload-only",
        action="store_true",
        help="Only verify the binary and model files are present, then exit. There is no persistent "
        "process to warm up since asr_infer is a one-shot CLI.",
    )
    args = parser.parse_args()

    vae_model = args.model_dir / VAE_MODEL_FILENAME
    lm_model = args.model_dir / LM_MODEL_FILENAME

    if not args.binary.exists():
        emit_progress(
            args.progress_json,
            {"type": "error", "message": f"asr_infer binary not found at {args.binary}. Build VibeASR.cpp first."},
        )
        raise SystemExit(1)
    if not vae_model.exists() or not lm_model.exists():
        emit_progress(
            args.progress_json,
            {
                "type": "error",
                "message": f"Model files not found in {args.model_dir}. Expected {VAE_MODEL_FILENAME} and {LM_MODEL_FILENAME}.",
            },
        )
        raise SystemExit(1)

    if args.preload_only:
        emit_progress(
            args.progress_json,
            {"type": "complete", "message": "VibeVoice binary and model files are present"},
        )
        return

    if not args.audio:
        raise ValueError("--audio is required unless --preload-only is set.")

    emit_progress(args.progress_json, {"type": "stage", "stage": "loading_model", "message": "Preparing VibeVoice ASR (CPU)"})

    usage_stop, usage_thread = start_usage_emitter(args.emit_usage, args.progress_json)
    try:
        emit_progress(args.progress_json, {"type": "stage", "stage": "transcribing", "message": "Transcribing with VibeVoice BitNet (CPU)"})
        started_at = time.perf_counter()
        cmd = [
            str(args.binary),
            "--vae-model", str(vae_model),
            "--lm-model", str(lm_model),
            "--audio", str(args.audio),
            "-t", str(args.threads),
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=build_runtime_env())
        elapsed = round(time.perf_counter() - started_at, 2)

        if proc.returncode != 0:
            message = proc.stderr.decode(errors="ignore").strip() or f"asr_infer exited with code {proc.returncode}"
            emit_progress(args.progress_json, {"type": "error", "message": message})
            raise SystemExit(1)

        transcript = proc.stdout.decode(errors="ignore").strip()
        emit_progress(
            args.progress_json,
            {"type": "progress", "stage": "transcribing", "progress": 100, "processedSeconds": elapsed, "totalSeconds": elapsed},
        )
        emit_progress(args.progress_json, {"type": "complete", "transcript": transcript, "elapsedSeconds": elapsed})
        if not args.progress_json:
            print("Transcription:", transcript)
    finally:
        if args.emit_usage:
            usage_stop.set()
            if usage_thread is not None:
                usage_thread.join(timeout=1.5)


if __name__ == "__main__":
    main()
