"""
Run OpenAI Whisper locally on Intel AI Boost (NPU) using OpenVINO GenAI.

Usage:
  .\\.venv\\Scripts\\python whisper_npu.py --audio path/to/audio.wav --model-dir models/whisper-small-openvino
"""

import argparse
import wave
from pathlib import Path

import numpy as np
import json
import shutil
import subprocess
import tempfile
import time
import threading
import re
from openvino import Core
from openvino_genai import WhisperGenerationConfig, WhisperPipeline

SAMPLE_RATE = 16_000
CHUNK_SECONDS = 30


def ensure_npu_available(core: Core) -> None:
    """Fail fast if the NPU is not visible. We never fall back to CPU."""
    if "NPU" not in core.available_devices:
        raise RuntimeError(f"NPU device not visible. Found: {core.available_devices}")


def load_audio(path: Path) -> np.ndarray:
    """Load a 16 kHz PCM WAV file, downmix stereo to mono, and normalize to float32 in [-1, 1]."""
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        if channels not in (1, 2):
            raise ValueError(f"Unsupported channel count ({channels}). Expected mono or stereo.")
        sample_rate = wf.getframerate()
        sample_width = wf.getsampwidth()
        dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sample_width)
        if dtype is None:
            raise ValueError(f"Unsupported sample width: {sample_width} bytes per sample.")

        n_frames = wf.getnframes()
        frames = wf.readframes(n_frames)

    audio = np.frombuffer(frames, dtype=dtype).astype(np.float32)
    if channels == 2:
        # Downmix stereo to mono by averaging the two channels.
        audio = audio.reshape(-1, 2).mean(axis=1)
    max_val = np.iinfo(dtype).max
    audio = audio / max_val

    if sample_rate != SAMPLE_RATE:
        # Lightweight linear resample to 16 kHz to avoid external deps.
        target_len = int(len(audio) * SAMPLE_RATE / sample_rate)
        x_old = np.linspace(0, 1, num=len(audio), endpoint=False)
        x_new = np.linspace(0, 1, num=target_len, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)

    return audio


def emit_progress(enabled: bool, event: dict) -> None:
    if enabled:
        print(json.dumps(event), flush=True)


def parse_first_float(text: str) -> float | None:
    try:
        match = re.search(r"[-+]?\d*\.?\d+", text or "")
        if not match:
            return None
        return float(match.group(0))
    except Exception:
        return None


def run_powershell(script: str) -> str:
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return ""
    return (proc.stdout or "").strip()


def read_counter(counter_path: str) -> float | None:
    safe_path = counter_path.replace("'", "''")
    out = run_powershell(
        f"(Get-Counter '{safe_path}' -SampleInterval 1 -MaxSamples 1).CounterSamples.CookedValue"
    )
    return parse_first_float(out)


def read_counter_sum(counter_path: str) -> float | None:
    safe_path = counter_path.replace("'", "''")
    out = run_powershell(
        f"$s = Get-Counter '{safe_path}' -ErrorAction SilentlyContinue; "
        "if ($s) { ($s.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum }"
    )
    return parse_first_float(out)


def read_ram_percent() -> float | None:
    out = run_powershell(
        "$os = Get-CimInstance Win32_OperatingSystem; "
        "$total = [double]$os.TotalVisibleMemorySize; "
        "$free = [double]$os.FreePhysicalMemory; "
        "if ($total -gt 0) { (($total - $free) / $total) * 100 }"
    )
    return parse_first_float(out)


def read_utilization_snapshot() -> dict:
    try:
        cpu = read_counter(r"\Processor(_Total)\% Processor Time")
        ram = read_ram_percent()
        gpu = read_counter_sum(r"\GPU Engine(*)\Utilization Percentage")
        npu = read_counter_sum(r"\NPU Engine(*)\Utilization Percentage")
        return {
            "cpuPercent": round(cpu, 1) if cpu is not None else None,
            "ramPercent": round(ram, 1) if ram is not None else None,
            "gpuPercent": round(gpu, 1) if gpu is not None else None,
            "npuPercent": round(npu, 1) if npu is not None else None,
        }
    except Exception:
        return {}


def start_usage_emitter(enabled: bool, progress_enabled: bool):
    stop_event = threading.Event()
    thread = None

    if not enabled:
        return stop_event, thread

    def run():
        while not stop_event.is_set():
            usage = read_utilization_snapshot()
            emit_progress(
                progress_enabled,
                {
                    "type": "usage",
                    "cpuPercent": usage.get("cpuPercent"),
                    "ramPercent": usage.get("ramPercent"),
                    "gpuPercent": usage.get("gpuPercent"),
                    "npuPercent": usage.get("npuPercent"),
                },
            )
            stop_event.wait(1.2)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return stop_event, thread


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Whisper on Intel NPU with OpenVINO GenAI")
    parser.add_argument(
        "--audio",
        required=True,
        type=Path,
        help="Path to audio file to transcribe. WAV preferred; M4A/other formats will be converted with ffmpeg if available.",
    )
    parser.add_argument(
        "--model-dir",
        default=Path("models") / "whisper-small-openvino",
        type=Path,
        help="Path to the OpenVINO-exported Whisper model (output of optimum-cli export).",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="Language code (e.g., en, es). Auto-mapped to Whisper token form if needed.",
    )
    parser.add_argument(
        "--progress-json",
        action="store_true",
        help="Emit newline-delimited JSON progress events instead of plain text only.",
    )
    parser.add_argument(
        "--emit-usage",
        action="store_true",
        help="Emit periodic CPU/RAM/GPU/NPU usage samples as JSON events.",
    )
    args = parser.parse_args()

    def convert_to_wav_if_needed(input_path: Path):
        """If input is not WAV, try to convert to 16 kHz mono WAV using ffmpeg."""
        if input_path.suffix.lower() == ".wav":
            return input_path, lambda: None

        # Prefer a local ffmpeg.exe in repo root if present (user provided portable build).
        local_ffmpeg = Path(__file__).parent / "ffmpeg.exe"
        ffmpeg = str(local_ffmpeg) if local_ffmpeg.exists() else shutil.which("ffmpeg")

        if not ffmpeg:
            raise RuntimeError("Non-WAV input provided and ffmpeg not found. Place ffmpeg.exe next to this script or add it to PATH.")

        tmp = Path(tempfile.NamedTemporaryFile(delete=False, suffix=".wav").name)
        cmd = [ffmpeg, "-y", "-i", str(input_path), "-ac", "1", "-ar", "16000", str(tmp)]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise RuntimeError(f"ffmpeg conversion failed ({proc.returncode}): {proc.stderr.decode(errors='ignore')}")

        def cleanup():
            try:
                tmp.unlink()
            except OSError:
                pass

        return tmp, cleanup

    emit_progress(args.progress_json, {"type": "stage", "stage": "preparing", "message": "Preparing audio"})
    audio_path, cleanup = convert_to_wav_if_needed(args.audio)

    core = Core()
    ensure_npu_available(core)

    audio = load_audio(audio_path)

    # Initialize Whisper on NPU. If the device is unavailable, this raises instead of falling back.
    emit_progress(args.progress_json, {"type": "stage", "stage": "loading_model", "message": "Loading model on NPU"})
    pipeline = WhisperPipeline(models_path=str(args.model_dir), device="NPU")

    # Basic generation settings; adjust if you want timestamps or different decoding.
    gen_cfg = WhisperGenerationConfig()
    gen_cfg.return_timestamps = False
    # Load generation_config.json to populate language map and other defaults.
    gen_config_path = args.model_dir / "generation_config.json"
    if gen_config_path.exists():
        data = json.loads(gen_config_path.read_text(encoding="utf-8"))
        for k, v in data.items():
            try:
                setattr(gen_cfg, k, v)
            except Exception:
                pass
    # Map plain language codes like "en" to the token form "<|en|>" if present in lang_to_id.
    lang = args.language
    lang_to_id = getattr(gen_cfg, "lang_to_id", {}) or {}
    is_multilingual = getattr(gen_cfg, "is_multilingual", None)
    if lang in lang_to_id:
        gen_cfg.language = lang
    elif f"<|{lang}|>" in lang_to_id:
        gen_cfg.language = f"<|{lang}|>"
    elif is_multilingual is False and lang == "en":
        pass
    else:
        raise ValueError(f"Language '{lang}' not found in generation_config lang_to_id.")

    try:
        usage_stop, usage_thread = start_usage_emitter(args.emit_usage, args.progress_json)
        emit_progress(args.progress_json, {"type": "stage", "stage": "transcribing", "message": "Transcribing on NPU"})
        started_at = time.perf_counter()
        chunk_size = SAMPLE_RATE * CHUNK_SECONDS
        total_samples = len(audio)
        transcripts = []

        for start in range(0, total_samples, chunk_size):
            end = min(start + chunk_size, total_samples)
            chunk = audio[start:end]
            result = pipeline.generate(chunk, generation_config=gen_cfg)
            texts = getattr(result, "texts", None)
            transcript = texts[0] if texts else str(result)
            transcripts.append(transcript.strip())
            progress = round((end / total_samples) * 100) if total_samples else 100
            emit_progress(
                args.progress_json,
                {
                    "type": "progress",
                    "stage": "transcribing",
                    "progress": progress,
                    "processedSeconds": round(end / SAMPLE_RATE, 1),
                    "totalSeconds": round(total_samples / SAMPLE_RATE, 1),
                },
            )

        transcript = " ".join(t for t in transcripts if t).strip()
        elapsed = round(time.perf_counter() - started_at, 2)
        emit_progress(
            args.progress_json,
            {"type": "complete", "transcript": transcript, "elapsedSeconds": elapsed},
        )
        if not args.progress_json:
            print("Transcription:", transcript)
    finally:
        if args.emit_usage:
            usage_stop.set()
            if usage_thread is not None:
                usage_thread.join(timeout=1.5)
        cleanup()


if __name__ == "__main__":
    main()
