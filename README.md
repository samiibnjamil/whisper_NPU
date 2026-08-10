# whisper_NPU

Local transcription app supporting two on-device engines: Whisper on Intel NPU via OpenVINO, and
Microsoft's VibeVoice-ASR-BitNet running quantized on CPU.

## Overview

`whisper_NPU` is a local-first transcription project with:
- Two interchangeable Python inference runners, selected via an "Engine" dropdown in the UI:
  - `whisper_npu.py` loads Whisper through `openvino-genai` and targets `NPU`.
  - `vibevoice_asr.py` shells out to the `asr_infer` CLI from [VibeASR.cpp](https://github.com/microsoft/VibeASR.cpp), running the quantized [microsoft/VibeVoice-ASR-BitNet](https://huggingface.co/microsoft/VibeVoice-ASR-BitNet) model entirely on CPU threads.
- A Next.js web UI for uploading audio, choosing an engine/model, tracking progress, and viewing transcript output.
- API routes that bridge UI requests to the Python process and stream progress updates back to the browser.
- `system_usage.py`: shared CPU/RAM/GPU/NPU telemetry used by both engines.

Whisper inference is designed to run on-device on the NPU; the script checks for NPU visibility and does not intentionally fall back to CPU. VibeVoice BitNet is CPU-only by design (no GPU/NPU dependency).

## App Features

- Audio upload from browser (drag/drop or file picker)
- Engine selector in UI:
  - `Whisper (Intel NPU)` — `Whisper Medium.en` (higher accuracy) or `Whisper Small` (faster)
  - `VibeVoice BitNet (CPU)` — `VibeVoice ASR BitNet` (quantized, CPU-only)
- Streaming transcription progress (NDJSON events)
- Optional live system usage sampling (CPU / RAM / GPU / NPU)
- CLI workflow for direct local transcription without the UI

## Project Structure

- `whisper_npu.py`: Whisper transcription pipeline (OpenVINO GenAI + NPU target)
- `vibevoice_asr.py`: VibeVoice-ASR-BitNet transcription pipeline (CPU, via `asr_infer` CLI)
- `system_usage.py`: Shared CPU/RAM/GPU/NPU telemetry used by both engines
- `lib/engines.js`: Engine/model registry shared by the API routes
- `pages/index.jsx`: Frontend app (engine/model selectors, upload, progress, transcript, usage widgets)
- `pages/api/transcribe.js`: Upload + subprocess orchestration endpoint
- `pages/api/load-model.js`: Model preload/warm-up endpoint
- `pages/api/system-usage.js`: Periodic system usage endpoint
- `models/`: Local Whisper OpenVINO exports and VibeVoice GGUF weights (gitignored)
- `third_party/VibeASR.cpp/`: Cloned + built VibeASR.cpp inference engine (gitignored)

## API Behavior

### `POST /api/transcribe`

- Accepts multipart form data:
  - `audio`: uploaded audio file
  - `engine`: `whisper` or `vibevoice`
  - `model`: `small`/`medium` for `whisper`, `bitnet` for `vibevoice`
  - `showUsage`: `1` to enable usage events
- Spawns `.venv/Scripts/python.exe <engine script> ... --progress-json`
- Streams newline-delimited JSON events such as:
  - `stage`
  - `progress`
  - `usage`
  - `complete`
  - `error`

### `GET /api/system-usage`

Returns a JSON snapshot:
- `cpuPercent`
- `ramPercent`
- `gpuPercent`
- `npuPercent`

## Getting Started

### 1. Clone

```powershell
git clone git@github.com:samiibnjamil/whisper_NPU.git
cd whisper_NPU
```

### 2. Install Python dependencies

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install openvino openvino-genai optimum-intel[openvino] transformers
```

### 3. Install Node dependencies (for web UI)

```powershell
npm install
```

### 4. Download/export Whisper models into `models/`

Create the model directory:

```powershell
mkdir models
```

Export Whisper Small:

```powershell
optimum-cli export openvino --model openai/whisper-small models/whisper-small-openvino-stateless
```

Export Whisper Medium.en:

```powershell
optimum-cli export openvino --model openai/whisper-medium.en models/whisper-medium-en-openvino-stateless
```

Optional legacy export path used by some CLI examples:

```powershell
optimum-cli export openvino --model openai/whisper-small models/whisper-small-openvino
```

### 5. (Optional) Set up VibeVoice BitNet (CPU engine)

Requires a MinGW/GCC toolchain and CMake (MSVC is not supported by VibeASR.cpp). On Windows:

```powershell
winget install --id Kitware.CMake -e
winget install --id MSYS2.MSYS2 -e
C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm && pacman -S --noconfirm mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake mingw-w64-x86_64-make"
```

Clone and build `VibeASR.cpp` into `third_party/`:

```powershell
git clone --recursive https://github.com/microsoft/VibeASR.cpp.git third_party/VibeASR.cpp
cd third_party/VibeASR.cpp
$env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
cmake -B build -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ -DCMAKE_MAKE_PROGRAM=mingw32-make
cmake --build build --target asr_infer -j
cd ../..
```

Download the quantized model weights (~1.6 GB) into `models/vibevoice-asr-bitnet/`:

```powershell
pip install huggingface_hub
python -c "from huggingface_hub import hf_hub_download; [hf_hub_download('microsoft/VibeVoice-ASR-BitNet', f, local_dir='models/vibevoice-asr-bitnet') for f in ['vibeasr-lm-i2_s-embed-q6_k.gguf', 'vibeasr-vae-encoder-i8_s.gguf']]"
```

`vibevoice_asr.py` expects `asr_infer.exe` at `third_party/VibeASR.cpp/build/bin/asr_infer.exe` and prepends `C:\msys64\mingw64\bin` to `PATH` at runtime so the MinGW runtime DLLs (libgomp, libstdc++, etc.) resolve.

## Run

### Web UI

```powershell
npm run dev
```

Open `http://localhost:3000`.

### CLI

```powershell
.venv\Scripts\python whisper_npu.py --audio .\audio.wav --model-dir .\models\whisper-small-openvino --language en
.venv\Scripts\python vibevoice_asr.py --audio .\audio.wav --model-dir .\models\vibevoice-asr-bitnet
```

## Notes

- `models/` and `third_party/` are intentionally gitignored. Each machine should export/download/build them locally.
- Non-WAV input is converted to 16 kHz mono WAV with `ffmpeg` if available.
- If NPU is not visible to OpenVINO, Whisper transcription will fail early.
- VibeVoice BitNet has no persistent "loaded" state (it's a one-shot CLI); the "Load Model" button just checks that the binary and weight files are present.
