# whisper_NPU

Local Whisper transcription app running on Intel NPU via OpenVINO.

## Overview

`whisper_NPU` is a local-first transcription project with:
- A Python inference runner (`whisper_npu.py`) that loads Whisper through `openvino-genai` and targets `NPU`.
- A Next.js web UI for uploading audio, tracking progress, and viewing transcript output.
- API routes that bridge UI requests to the Python process and stream progress updates back to the browser.

Inference is designed to run on-device. The script checks for NPU visibility and does not intentionally fall back to CPU.

## App Features

- Audio upload from browser (drag/drop or file picker)
- Model selector in UI:
  - `Whisper Medium.en` (higher accuracy)
  - `Whisper Small` (faster)
- Streaming transcription progress (NDJSON events)
- Optional live system usage sampling (CPU / RAM / GPU / NPU)
- CLI workflow for direct local transcription without the UI

## Project Structure

- `whisper_npu.py`: Python transcription pipeline (OpenVINO GenAI + NPU target)
- `pages/index.jsx`: Frontend app (upload, progress, transcript, usage widgets)
- `pages/api/transcribe.js`: Upload + subprocess orchestration endpoint
- `pages/api/system-usage.js`: Periodic system usage endpoint
- `models/`: Local exported Whisper OpenVINO models (gitignored)

## API Behavior

### `POST /api/transcribe`

- Accepts multipart form data:
  - `audio`: uploaded audio file
  - `model`: `small` or `medium`
  - `showUsage`: `1` to enable usage events
- Spawns `.venv/Scripts/python.exe whisper_npu.py ... --progress-json`
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

## Run

### Web UI

```powershell
npm run dev
```

Open `http://localhost:3000`.

### CLI

```powershell
.venv\Scripts\python whisper_npu.py --audio .\audio.wav --model-dir .\models\whisper-small-openvino --language en
```

## Notes

- `models/` is intentionally gitignored. Each machine should export/download models locally.
- Non-WAV input is converted to 16 kHz mono WAV with `ffmpeg` if available.
- If NPU is not visible to OpenVINO, transcription will fail early.
