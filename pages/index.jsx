import { useEffect, useRef, useState } from "react";
import Head from "next/head";

const MODELS = [
  { value: "medium", label: "Whisper Medium.en", detail: "Higher accuracy" },
  { value: "small", label: "Whisper Small", detail: "Faster" },
];
const USAGE_KEYS = ["cpuPercent", "ramPercent", "gpuPercent", "npuPercent"];
const USAGE_RANGES = [1, 2, 5, 10];
const MAX_USAGE_HISTORY_MS = 10 * 60 * 1000;
const CURRENT_FILE_AUDIO_ID = "__current-file-audio__";

function progressLabel(stage) {
  if (stage === "uploading") return "Uploading";
  if (stage === "queued") return "Starting";
  if (stage === "preparing") return "Preparing audio";
  if (stage === "loading_model") return "Loading model on NPU";
  if (stage === "transcribing") return "Transcribing on NPU";
  if (stage === "complete") return "Complete";
  return "Progress";
}

function isIndeterminateStage(stage) {
  return ["queued", "preparing", "loading_model"].includes(stage);
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(value || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString();
}

function usagePercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usageValueLabel(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return `${value.toFixed(1)}%`;
}

function usageStatusLabel(label, value, unavailableReason) {
  if (label !== "NPU") return usageValueLabel(value);
  if (typeof value === "number" && !Number.isNaN(value)) return `${value.toFixed(1)}%`;
  return unavailableReason ? "Unavailable" : "N/A";
}

function graphPoints(samples, rangeMinutes) {
  const width = 220;
  const height = 72;
  const now = Date.now();
  const windowMs = rangeMinutes * 60 * 1000;
  const visibleSamples = samples.filter((sample) => sample.t >= now - windowMs);
  if (!visibleSamples.length) return "";
  return visibleSamples
    .map((sample, index) => {
      const x = Math.max(0, Math.min(width, ((sample.t - (now - windowMs)) / windowMs) * width));
      const y = height - (usagePercent(sample.value) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export default function Home() {
  const [file, setFile] = useState(null);
  const [model, setModel] = useState("medium");
  const [status, setStatus] = useState("");
  const [transcript, setTranscript] = useState("");
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [copiedHistoryId, setCopiedHistoryId] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [audioProgress, setAudioProgress] = useState({});
  const [audioDuration, setAudioDuration] = useState({});
  const [audioVolume, setAudioVolume] = useState({});
  const [currentFileAudioUrl, setCurrentFileAudioUrl] = useState("");
  const audioRefs = useRef({});
  const [splitSpeakers, setSplitSpeakers] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [usageView, setUsageView] = useState("graph");
  const [usageRangeMinutes, setUsageRangeMinutes] = useState(5);
  const [usage, setUsage] = useState(null);
  const [usageHistory, setUsageHistory] = useState({
    cpuPercent: [],
    ramPercent: [],
    gpuPercent: [],
    npuPercent: [],
  });
  const [loading, setLoading] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  // queue: [{ id, name, file, status: "waiting"|"transcribing"|"done"|"error", progress, stage, elapsed, transcript, errorMsg }]
  const [queue, setQueue] = useState([]);
  const queueRef = useRef([]);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [finalElapsedSeconds, setFinalElapsedSeconds] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(1366);
  const dropRef = useRef(null);
  const transcriptionStartedAt = useRef(null);
  const xhrRef = useRef(null);
  const loadModelXhrRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const recordingStartedAt = useRef(null);
  const waveformCanvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const analyserRef = useRef(null);
  const autoLoadModelRef = useRef(null);
  const transcriptCopyTimerRef = useRef(null);
  const historyCopyTimerRef = useRef(null);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth || 1366);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => () => {
    if (transcriptCopyTimerRef.current) window.clearTimeout(transcriptCopyTimerRef.current);
    if (historyCopyTimerRef.current) window.clearTimeout(historyCopyTimerRef.current);
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    Object.values(audioRefs.current).forEach((audio) => audio?.pause?.());
  }, []);

  useEffect(() => {
    if (!file) {
      setCurrentFileAudioUrl("");
      setAudioProgress((current) => ({ ...current, [CURRENT_FILE_AUDIO_ID]: 0 }));
      setAudioDuration((current) => ({ ...current, [CURRENT_FILE_AUDIO_ID]: 0 }));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setCurrentFileAudioUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  // Auto-load model on NPU at startup
  useEffect(() => { autoLoadModelRef.current?.(); }, []);

  useEffect(() => {
    if (!recording || !analyserRef.current) return;
    const analyser = analyserRef.current;
    const buf = new Float32Array(analyser.fftSize);

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw);
      const canvas = waveformCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      analyser.getFloatTimeDomainData(buf);
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#a78bfa";
      ctx.beginPath();
      const step = W / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const x = i * step;
        const y = (1 - (buf[i] * 0.9 + 1) / 2) * H;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw();
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    };
  }, [recording]);

  useEffect(() => {
    if (!loading || stage !== "transcribing") return;
    const timer = window.setInterval(() => {
      if (!transcriptionStartedAt.current) return;
      setElapsedSeconds((Date.now() - transcriptionStartedAt.current) / 1000);
    }, 250);
    return () => window.clearInterval(timer);
  }, [loading, stage]);

  // Queue processor: when not loading, pick the next waiting item and transcribe it
  useEffect(() => {
    if (loading) return;
    const next = queue.find((item) => item.status === "waiting");
    if (!next) return;

    const updateItem = (id, patch) => {
      setQueue((prev) => {
        const updated = prev.map((item) => item.id === id ? { ...item, ...patch } : item);
        queueRef.current = updated;
        return updated;
      });
    };

    updateItem(next.id, { status: "transcribing", stage: "uploading", progress: 0 });
    setLoading(true);
    setStage("uploading");
    setStatus(`Transcribing: ${next.name}`);
    setProgress(0);
    setElapsedSeconds(0);
    setFinalElapsedSeconds(null);
    setTranscript("");
    setTranscriptCopied(false);
    setUsage(null);

    const form = new FormData();
    form.append("audio", next.file);
    form.append("model", model);
    form.append("showUsage", "1");

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let responseOffset = 0;
    let responseBuffer = "";
    let completed = false;
    const startedAt = { current: null };

    const elapsedTimer = window.setInterval(() => {
      if (!startedAt.current) return;
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsedSeconds(s);
      updateItem(next.id, { elapsed: s });
    }, 250);

    const handleEvent = (event) => {
      if (event.type === "stage") {
        setStage(event.stage);
        setStatus(event.message || event.stage);
        updateItem(next.id, { stage: event.stage });
        if (["queued", "preparing", "loading_model"].includes(event.stage)) {
          setProgress(0);
          updateItem(next.id, { progress: 0 });
        }
        if (event.stage === "transcribing") {
          startedAt.current = Date.now();
          transcriptionStartedAt.current = startedAt.current;
          setElapsedSeconds(0);
          setProgress(0);
          updateItem(next.id, { progress: 0 });
        }
      }
      if (event.type === "progress") {
        setStage(event.stage || "transcribing");
        setStatus("Transcribing");
        setProgress(event.progress ?? 0);
        updateItem(next.id, { progress: event.progress ?? 0 });
      }
      if (event.type === "complete") {
        completed = true;
        setStage("complete");
        setProgress(100);
        setTranscript(event.transcript || "");
        setFinalElapsedSeconds(event.elapsedSeconds ?? null);
        setStatus("Done");
        updateItem(next.id, { status: "done", progress: 100, stage: "complete", transcript: event.transcript || "" });
        if (event.historyEntry) {
          setHistory((current) => [event.historyEntry, ...current.filter((item) => item.id !== event.historyEntry.id)]);
          setExpandedHistoryId(event.historyEntry.id);
        }
      }
      if (event.type === "usage") setUsage(event);
      if (event.type === "error") throw new Error(event.message || "Transcription failed");
    };

    const readEvents = () => {
      responseBuffer += xhr.responseText.slice(responseOffset);
      responseOffset = xhr.responseText.length;
      const lines = responseBuffer.split(/\r?\n/);
      responseBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handleEvent(JSON.parse(line));
      }
    };

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      setStage("uploading"); setStatus("Uploading"); setProgress(p);
      updateItem(next.id, { stage: "uploading", progress: p });
    };
    xhr.onprogress = () => { try { readEvents(); } catch (err) { setStatus(`Error: ${err.message}`); setStage("error"); setProgress(0); xhr.abort(); } };
    xhr.onload = () => {
      window.clearInterval(elapsedTimer);
      try {
        readEvents();
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(xhr.responseText || "Transcription failed");
        if (!completed) throw new Error("Transcription ended without a completion event.");
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        setStage("error");
        setProgress(0);
        updateItem(next.id, { status: "error", stage: "error", errorMsg: err.message });
      } finally {
        setLoading(false);
        xhrRef.current = null;
      }
    };
    xhr.onerror = () => {
      window.clearInterval(elapsedTimer);
      setStatus("Error: Network request failed"); setStage("error"); setProgress(0);
      updateItem(next.id, { status: "error", stage: "error", errorMsg: "Network request failed" });
      setLoading(false); xhrRef.current = null;
    };
    xhr.onabort = () => {
      window.clearInterval(elapsedTimer);
      setStatus("Stopped"); setStage("stopped"); setProgress(0);
      updateItem(next.id, { status: "error", stage: "stopped", errorMsg: "Stopped" });
      setLoading(false); xhrRef.current = null;
    };

    xhr.open("POST", "/api/transcribe");
    xhr.send(form);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, queue]);

  useEffect(() => {
    if (!showUsage) return;
    let cancelled = false;
    let timerId = null;
    const fetchUsage = async () => {
      try {
        const res = await fetch("/api/system-usage");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setUsage(data);
      } catch {}
    };
    fetchUsage();
    timerId = window.setInterval(fetchUsage, 1800);
    return () => {
      cancelled = true;
      if (timerId) window.clearInterval(timerId);
    };
  }, [showUsage]);

  useEffect(() => {
    if (!usage) return;
    setUsageHistory((current) => {
      const now = Date.now();
      const cutoff = now - MAX_USAGE_HISTORY_MS;
      const next = {};
      for (const key of USAGE_KEYS) {
        const value = typeof usage[key] === "number" ? usage[key] : 0;
        next[key] = [...current[key], { t: now, value }].filter((sample) => sample.t >= cutoff);
      }
      return next;
    });
  }, [usage]);

  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    const loadHistory = async () => {
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const res = await fetch("/api/transcript-history");
        if (!res.ok) throw new Error("Failed to load transcript history");
        const data = await res.json();
        if (!cancelled) {
          const nextHistory = Array.isArray(data.history) ? data.history : [];
          setHistory(nextHistory);
          setExpandedHistoryId((current) => current ?? nextHistory[0]?.id ?? null);
        }
      } catch (err) {
        if (!cancelled) setHistoryError(err.message || "Failed to load transcript history");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    };
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [historyOpen]);

  const onFile = (f) => {
    const currentAudio = audioRefs.current[CURRENT_FILE_AUDIO_ID];
    if (currentAudio) currentAudio.pause();
    setFile(f);
    setPlayingId((current) => current === CURRENT_FILE_AUDIO_ID ? null : current);
    setTranscript("");
    setTranscriptCopied(false);
    setStatus("");
    setProgress(0);
    setStage("idle");
    setElapsedSeconds(0);
    setFinalElapsedSeconds(null);
    setUsage(null);
    xhrRef.current = null;
  };

  const syncAudioState = (id, audio) => {
    if (!audio) return;
    setAudioProgress((current) => ({ ...current, [id]: audio.currentTime || 0 }));
    setAudioDuration((current) => ({ ...current, [id]: audio.duration || 0 }));
    setAudioVolume((current) => ({ ...current, [id]: Number.isFinite(audio.volume) ? audio.volume : 1 }));
  };

  const pauseOtherAudio = (activeId) => {
    Object.entries(audioRefs.current).forEach(([id, audio]) => {
      if (!audio || id === activeId) return;
      audio.pause();
    });
  };

  const toggleAudioPlayback = async (id) => {
    const audio = audioRefs.current[id];
    if (!audio) return;

    if (playingId === id && !audio.paused) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    pauseOtherAudio(id);
    try {
      await audio.play();
      setPlayingId(id);
    } catch {
      setStatus("Error: Could not play audio");
    }
  };

  const seekAudio = (id, nextTime) => {
    const audio = audioRefs.current[id];
    const duration = audio?.duration || audioDuration[id] || 0;
    if (!audio || !duration) return;

    const clampedTime = Math.max(0, Math.min(duration, nextTime));
    audio.currentTime = clampedTime;
    setAudioProgress((current) => ({ ...current, [id]: clampedTime }));
  };

  const skipAudio = (id, deltaSeconds) => {
    const audio = audioRefs.current[id];
    if (!audio) return;
    seekAudio(id, (audio.currentTime || 0) + deltaSeconds);
  };

  const setAudioVolumeLevel = (id, nextVolume) => {
    const audio = audioRefs.current[id];
    const clampedVolume = Math.max(0, Math.min(1, nextVolume));
    if (audio) audio.volume = clampedVolume;
    setAudioVolume((current) => ({ ...current, [id]: clampedVolume }));
  };

  const renderAudioPlayer = ({ id, src }) => {
    if (!src) return null;

    const progressValue = audioProgress[id] ?? 0;
    const durationValue = audioDuration[id] ?? 0;
    const volumeValue = audioVolume[id] ?? 1;
    const isPlaying = playingId === id;

    return (
      <div style={styles.audioPlayer}>
        <audio
          ref={(el) => {
            if (el) audioRefs.current[id] = el;
            else delete audioRefs.current[id];
          }}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => syncAudioState(id, e.target)}
          onDurationChange={(e) => syncAudioState(id, e.target)}
          onTimeUpdate={(e) => setAudioProgress((current) => ({ ...current, [id]: e.target.currentTime }))}
          onVolumeChange={(e) => setAudioVolume((current) => ({ ...current, [id]: e.target.volume }))}
          onPlay={() => {
            pauseOtherAudio(id);
            setPlayingId(id);
          }}
          onPause={() => setPlayingId((current) => current === id ? null : current)}
          onEnded={() => setPlayingId((current) => current === id ? null : current)}
        />
        <div style={styles.audioControls}>
          <div style={styles.audioControlsRow}>
            <button
              type="button"
              style={styles.audioTransportButton}
              onClick={() => skipAudio(id, -10)}
              aria-label="Rewind 10 seconds"
              title="Rewind 10 seconds"
            >
              -10s
            </button>
            <button
              type="button"
              style={styles.audioPlayButton}
              onClick={() => toggleAudioPlayback(id)}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              style={styles.audioTransportButton}
              onClick={() => skipAudio(id, 10)}
              aria-label="Fast forward 10 seconds"
              title="Fast forward 10 seconds"
            >
              +10s
            </button>
            <div style={styles.audioTime}>
              {formatSeconds(progressValue)} / {formatSeconds(durationValue)}
            </div>
          </div>
          <div style={styles.audioSliderRow}>
            <input
              type="range"
              min={0}
              max={durationValue || 0}
              step={0.1}
              value={Math.min(progressValue, durationValue || 0)}
              onChange={(e) => seekAudio(id, Number(e.target.value))}
              style={styles.audioSlider}
              aria-label="Playback position"
              disabled={!durationValue}
            />
          </div>
          <div style={styles.audioVolumeRow}>
            <span style={styles.audioVolumeLabel}>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volumeValue}
              onChange={(e) => setAudioVolumeLevel(id, Number(e.target.value))}
              style={styles.audioVolumeSlider}
              aria-label="Volume"
            />
            <span style={styles.audioVolumeValue}>{Math.round(volumeValue * 100)}%</span>
          </div>
        </div>
      </div>
    );
  };

  const loadModelOnNpu = () => {
    if (modelLoading) return;
    setModelLoading(true);
    setModelLoaded(false);
    setStatus("Loading model on NPU...");

    const xhr = new XMLHttpRequest();
    loadModelXhrRef.current = xhr;
    let responseOffset = 0;
    let responseBuffer = "";

    const readEvents = () => {
      responseBuffer += xhr.responseText.slice(responseOffset);
      responseOffset = xhr.responseText.length;
      const lines = responseBuffer.split(/\r?\n/);
      responseBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "stage") setStatus(event.message || event.stage);
          if (event.type === "complete") {
            setModelLoaded(true);
            setStatus("Model loaded - ready to transcribe");
          }
          if (event.type === "error") setStatus(`Error: ${event.message}`);
        } catch {}
      }
    };

    xhr.onprogress = () => { try { readEvents(); } catch {} };
    xhr.onload = () => {
      try { readEvents(); } catch {}
      setModelLoading(false);
      loadModelXhrRef.current = null;
    };
    xhr.onerror = () => {
      setStatus("Error: Failed to load model");
      setModelLoading(false);
      loadModelXhrRef.current = null;
    };

    xhr.open("POST", `/api/load-model?model=${encodeURIComponent(model)}`);
    xhr.send();
  };
  autoLoadModelRef.current = loadModelOnNpu;

  const startRecording = async () => {
    if (recording) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("Error: Microphone access denied");
      return;
    }

    audioChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    // Set up Web Audio analyser for waveform visualisation
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyserRef.current = analyser;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      analyserRef.current = null;
      audioCtx.close();

      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;

      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const ext = mimeType.includes("webm") ? "webm" : "ogg";
      const recordedFile = new File([blob], `recording-${timestamp}.${ext}`, { type: mimeType });

      setRecording(false);

      const queueItem = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: recordedFile.name,
        file: recordedFile,
        status: "waiting",
        progress: 0,
        stage: "waiting",
        elapsed: 0,
        transcript: null,
        errorMsg: null,
      };
      setQueue((prev) => {
        const next = [...prev, queueItem];
        queueRef.current = next;
        return next;
      });
    };

    recorder.start(100);
    recordingStartedAt.current = Date.now();
    setRecordingSeconds(0);
    setRecording(true);
    setStatus("Recording...");

    recordingTimerRef.current = window.setInterval(() => {
      setRecordingSeconds(Math.round((Date.now() - recordingStartedAt.current) / 1000));
    }, 500);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  // Manual transcribe for file-drop/browse (enqueues like recordings do)
  const submit = () => {
    if (!file) return;
    const queueItem = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: file.name,
      file,
      status: "waiting",
      progress: 0,
      stage: "waiting",
      elapsed: 0,
      transcript: null,
      errorMsg: null,
    };
    setQueue((prev) => {
      const next = [...prev, queueItem];
      queueRef.current = next;
      return next;
    });
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setTranscriptCopied(true);
      if (transcriptCopyTimerRef.current) window.clearTimeout(transcriptCopyTimerRef.current);
      transcriptCopyTimerRef.current = window.setTimeout(() => setTranscriptCopied(false), 1600);
    } catch {
      setStatus("Error: Could not copy transcript to clipboard");
    }
  };

  const deleteHistoryEntry = async (id) => {
    try {
      const audio = audioRefs.current[id];
      if (audio) audio.pause();
      await fetch(`/api/transcript-history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setHistory((current) => current.filter((e) => e.id !== id));
      if (expandedHistoryId === id) setExpandedHistoryId(null);
      if (playingId === id) setPlayingId(null);
    } catch {
      setStatus("Error: Could not delete entry");
    }
  };

  const copyHistoryTranscript = async (entry) => {
    if (!entry?.transcript) return;
    try {
      await navigator.clipboard.writeText(entry.transcript);
      setCopiedHistoryId(entry.id);
      if (historyCopyTimerRef.current) window.clearTimeout(historyCopyTimerRef.current);
      historyCopyTimerRef.current = window.setTimeout(() => setCopiedHistoryId(null), 1600);
    } catch {
      setStatus("Error: Could not copy transcript to clipboard");
    }
  };

  const showWideUsageLayout = showUsage && viewportWidth >= 1180;
  const shellWidth = showWideUsageLayout ? Math.min(viewportWidth - 48, 1440) : Math.min(viewportWidth - 48, 760);
  const statsColumnWidth = Math.max(320, Math.floor((shellWidth - 16) / 3));
  const uploadColumnWidth = shellWidth - statsColumnWidth - 16;
  const wideColumns = `${uploadColumnWidth}px ${statsColumnWidth}px`;

  return (
    <>
      <Head>
        <title>Whisper_NPU</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </Head>
      <div style={styles.page}>
        <div
          style={{
            ...styles.appShell,
            width: `${shellWidth}px`,
            ...(showWideUsageLayout ? styles.appShellWide : {}),
            ...(showWideUsageLayout ? { gridTemplateColumns: wideColumns } : {}),
          }}
        >
          <div style={{ ...styles.card, ...(showWideUsageLayout ? styles.cardShifted : {}) }}>
          <div style={styles.pill}><span style={styles.badge}>NPU</span>Intel AI Boost - Whisper (OpenVINO)</div>
          <h1 style={styles.title}>Transcribe locally</h1>
          <p style={styles.subtitle}>Drag & drop audio (.wav, .m4a, .mp3). All inference stays on-device via your NPU.</p>
          <div ref={dropRef} style={styles.drop} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }}>
            <input type="file" accept="audio/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} style={styles.input} />
            <div>Drop a file here or click to browse</div>
            {file && <div style={styles.chip}>{file.name}</div>}
          </div>
          {currentFileAudioUrl && renderAudioPlayer({ id: CURRENT_FILE_AUDIO_ID, src: currentFileAudioUrl })}
          {recording && (
            <canvas
              ref={waveformCanvasRef}
              width={700}
              height={56}
              style={styles.waveformCanvas}
            />
          )}
          <label style={styles.label} htmlFor="model">Whisper model</label>
          <select id="model" value={model} onChange={(e) => { setModel(e.target.value); setModelLoaded(false); }} disabled={loading || modelLoading} style={styles.select}>
            {MODELS.map((option) => <option key={option.value} value={option.value}>{option.label} - {option.detail}</option>)}
          </select>
          <label style={styles.toggleRow}>
            <input type="checkbox" checked={splitSpeakers} onChange={(e) => setSplitSpeakers(e.target.checked)} disabled />
            <span>Split transcript by speaker (not working yet)</span>
            <span style={styles.toggleHint}>Requires speaker diarization</span>
          </label>
          <div style={styles.actions}>
            <button style={styles.button} disabled={!file || loading || recording} onClick={submit}>{loading ? "Transcribing..." : "Transcribe"}</button>
            <button
              style={{ ...styles.secondaryButton, ...(recording ? styles.recordingActiveButton : styles.recordButton) }}
              disabled={modelLoading}
              onClick={recording ? stopRecording : startRecording}
              type="button"
            >
              {recording ? `Stop  ${formatSeconds(recordingSeconds)}` : "Record"}
            </button>
            <button
              style={{ ...styles.secondaryButton, ...(modelLoaded ? styles.secondaryButtonActive : {}), ...(modelLoading ? styles.secondaryButtonLoading : {}) }}
              disabled={loading || modelLoading}
              onClick={loadModelOnNpu}
              type="button"
              title="Load the Whisper model onto the NPU so the first transcription starts faster"
            >
              {modelLoading ? "Loading..." : modelLoaded ? "Model Loaded" : "Load Model"}
            </button>
            <button style={{ ...styles.secondaryButton, ...(showUsage ? styles.secondaryButtonActive : {}) }} onClick={() => setShowUsage((v) => !v)}>
              {showUsage ? "Hide Usage" : "Show Usage"}
            </button>
            <button
              style={{ ...styles.secondaryButton, ...(historyOpen ? styles.secondaryButtonActive : {}) }}
              onClick={() => setHistoryOpen((v) => !v)}
              type="button"
            >
              {historyOpen ? "Hide History" : "History"}
            </button>
            {loading && <button style={styles.stopButton} onClick={() => xhrRef.current?.abort()}>Stop</button>}
          </div>
          {queue.length > 0 && (
            <div style={styles.queuePanel}>
              <div style={styles.queueHeader}>
                <span style={styles.queueTitle}>Queue</span>
                <span style={styles.queueSubtle}>
                  {queue.filter((i) => i.status === "waiting").length} waiting
                  {queue.filter((i) => i.status === "transcribing").length > 0 && " - 1 transcribing"}
                  {queue.filter((i) => i.status === "done").length > 0 && ` - ${queue.filter((i) => i.status === "done").length} done`}
                </span>
              </div>
              {queue.map((item) => (
                <div key={item.id} style={{ ...styles.queueItem, ...(item.status === "transcribing" ? styles.queueItemActive : item.status === "done" ? styles.queueItemDone : item.status === "error" ? styles.queueItemError : {}) }}>
                  <div style={styles.queueItemTop}>
                    <span style={styles.queueItemName}>{item.name}</span>
                    <span style={styles.queueItemBadge}>
                      {item.status === "waiting" && "Waiting"}
                      {item.status === "transcribing" && `${progressLabel(item.stage)} ${isIndeterminateStage(item.stage) ? "" : `${item.progress}%`}`}
                      {item.status === "done" && `Done - ${formatSeconds(item.elapsed)}`}
                      {item.status === "error" && (item.errorMsg === "Stopped" ? "Stopped" : "Error")}
                    </span>
                  </div>
                  {item.status === "transcribing" && (
                    <div style={styles.progressTrack}>
                      {isIndeterminateStage(item.stage)
                        ? <div className="indeterminateBar" style={styles.progressBarIndeterminate} />
                        : <div style={{ ...styles.progressBar, width: `${item.progress}%` }} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {status && <pre style={styles.status}>{status}</pre>}
          {transcript && (
            <div className="transcriptPanel" style={styles.transcript}>
              <button
                className="transcriptCopyButton"
                type="button"
                style={styles.transcriptCopyButton}
                onClick={copyTranscript}
                aria-label="Copy transcript"
              >
                {transcriptCopied ? "Copied" : "Copy"}
              </button>
              <strong>Transcript</strong>
              <div style={styles.transcriptBody}>{transcript}</div>
            </div>
          )}
          {historyOpen && (
            <div style={styles.historyPanel}>
              <div style={styles.historyHeader}>
                <strong>Transcript History</strong>
                <span style={styles.historySubtle}>Saved locally on this machine</span>
              </div>
              {historyLoading && <div style={styles.historyState}>Loading history...</div>}
              {!historyLoading && historyError && <div style={styles.historyState}>{historyError}</div>}
              {!historyLoading && !historyError && history.length === 0 && <div style={styles.historyState}>No saved transcripts yet.</div>}
              {!historyLoading && !historyError && history.length > 0 && (
                <div style={styles.historyList}>
                  {history.map((item) => {
                    const isExpanded = expandedHistoryId === item.id;
                    const audioSrc = item.audioFile ? `/api/recording/${encodeURIComponent(item.audioFile)}` : null;

                    return (
                      <article key={item.id} className="historySession" style={styles.historyItem}>
                        {/* Header row: title + delete */}
                        <div style={styles.historyItemHeadingRow}>
                          <button
                            type="button"
                            style={styles.historyItemButton}
                            onClick={() => setExpandedHistoryId((c) => c === item.id ? null : item.id)}
                            aria-expanded={isExpanded}
                          >
                            <div style={styles.historyItemHeading}>
                              <strong style={styles.historyItemTitle}>{item.fileName || "Unknown file"}</strong>
                              <span style={styles.historyItemChevron}>{isExpanded ? "Hide" : "Show"}</span>
                            </div>
                            <div style={styles.historyItemMeta}>
                              <span>{formatDateTime(item.savedAt)}</span>
                              <span>{item.model || "unknown model"}</span>
                              {typeof item.elapsedSeconds === "number" && <span>{formatSeconds(item.elapsedSeconds)}</span>}
                            </div>
                          </button>
                          <button
                            type="button"
                            style={styles.historyDeleteButton}
                            onClick={() => deleteHistoryEntry(item.id)}
                            aria-label="Delete this recording"
                            title="Delete"
                          >X</button>
                        </div>

                        {/* Audio player */}
                        {renderAudioPlayer({ id: item.id, src: audioSrc })}

                        {/* Transcript */}
                        {isExpanded && (
                          <div className="historyTranscriptPanel" style={styles.historyTranscriptPanel}>
                            <button
                              type="button"
                              className="historyCopyButton"
                              style={styles.historyCopyButton}
                              onClick={() => copyHistoryTranscript(item)}
                              aria-label={`Copy transcript from ${item.fileName || "session"}`}
                            >
                              {copiedHistoryId === item.id ? "Copied" : "Copy"}
                            </button>
                            <div style={styles.historyTranscript}>{item.transcript}</div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
          {showUsage && (
          <section style={styles.widgetsPane}>
            <div style={styles.monitorHeaderRow}>
              <div>
                <div style={styles.monitorHeader}>Resource Monitor</div>
                <div style={styles.monitorSubtle}>{loading ? "Live during transcription" : "Live system usage"}</div>
              </div>
              <div style={styles.monitorControls}>
                <div style={styles.viewToggle} aria-label="Resource monitor view">
                  <button
                    style={{ ...styles.viewToggleButton, ...(usageView === "bar" ? styles.viewToggleButtonActive : {}) }}
                    onClick={() => setUsageView("bar")}
                    type="button"
                  >
                    Bar
                  </button>
                  <button
                    style={{ ...styles.viewToggleButton, ...(usageView === "graph" ? styles.viewToggleButtonActive : {}) }}
                    onClick={() => setUsageView("graph")}
                    type="button"
                  >
                    Graph
                  </button>
                </div>
                {usageView === "graph" && (
                  <div style={styles.viewToggle} aria-label="Graph time range">
                    {USAGE_RANGES.map((minutes) => (
                      <button
                        key={minutes}
                        style={{ ...styles.rangeToggleButton, ...(usageRangeMinutes === minutes ? styles.viewToggleButtonActive : {}) }}
                        onClick={() => setUsageRangeMinutes(minutes)}
                        type="button"
                      >
                        {minutes}m
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={styles.widgetsGrid}>
              {[{ key: "cpuPercent", label: "CPU", color: "#22c55e" }, { key: "ramPercent", label: "RAM", color: "#38bdf8" }, { key: "gpuPercent", label: "GPU", color: "#f59e0b" }, { key: "npuPercent", label: "NPU", color: "#a78bfa" }].map((item) => {
                const value = usage?.[item.key];
                const isNpuUnavailable = item.key === "npuPercent" && usage?.npuTelemetryAvailable === false;
                return (
                  <div key={item.key} style={styles.widgetCard}>
                    <div style={styles.monitorRowTop}><span>{item.label}</span><span>{usageStatusLabel(item.label, value, isNpuUnavailable)}</span></div>
                    {usageView === "bar" ? (
                      <div style={styles.monitorTrack}><div style={{ ...styles.monitorFill, width: `${usagePercent(value)}%`, background: item.color }} /></div>
                    ) : (
                      <svg viewBox="0 0 220 72" preserveAspectRatio="none" style={styles.usageGraph}>
                        <path d="M0 18 H220 M0 36 H220 M0 54 H220" style={styles.graphGridLine} />
                        <polyline points={graphPoints(usageHistory[item.key], usageRangeMinutes)} fill="none" stroke={item.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                      </svg>
                    )}
                    {isNpuUnavailable && <div style={styles.monitorMeta}>{usage?.npuTelemetryReason}</div>}
                  </div>
                );
              })}
            </div>
            </section>
          )}
        </div>
        <style jsx>{`
          @keyframes indeterminateProgress {0% {transform: translateX(-120%);}100% {transform: translateX(320%);}}
          .indeterminateBar {animation: indeterminateProgress 1.2s ease-in-out infinite;}
        `}</style>
        <style jsx global>{`
          html,
          body,
          #__next {
            height: 100%;
            margin: 0;
            overflow: hidden;
          }

          * {
            box-sizing: border-box;
          }

          .transcriptCopyButton {
            opacity: 0;
            transform: translateY(-2px);
            pointer-events: none;
            transition: opacity 140ms ease, transform 140ms ease, background-color 140ms ease, border-color 140ms ease;
          }

          .transcriptPanel:hover .transcriptCopyButton,
          .transcriptPanel:focus-within .transcriptCopyButton {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
          }

          .historyCopyButton {
            opacity: 0;
            transform: translateY(-2px);
            pointer-events: none;
            transition: opacity 140ms ease, transform 140ms ease, background-color 140ms ease, border-color 140ms ease;
          }

          .historyTranscriptPanel:hover .historyCopyButton,
          .historyTranscriptPanel:focus-within .historyCopyButton {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
          }
        `}</style>
      </div>
    </>
  );
}

const styles = {
  page: { height: "100vh", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 10% 20%, #0f172a 0, #111827 40%, #0b1020 70%)", color: "#e2e8f0", padding: 24, fontFamily: "Inter, system-ui, -apple-system, sans-serif" },
  appShell: { width: "min(760px, 100%)", maxWidth: "100%", maxHeight: "calc(100vh - 48px)", display: "grid", gridTemplateColumns: "1fr", gap: 16, transition: "width 220ms ease, grid-template-columns 220ms ease" },
  appShellWide: { alignItems: "start" },
  card: { width: "100%", minWidth: 0, maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxSizing: "border-box", background: "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))", backdropFilter: "blur(18px)", borderRadius: 20, padding: 28, border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 25px 80px rgba(0,0,0,0.35)", transition: "transform 220ms ease" },
  cardShifted: { transform: "none" },
  pill: { display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "rgba(255,255,255,0.06)", borderRadius: 999, border: "1px solid rgba(255,255,255,0.08)", color: "#cbd5e1", fontSize: 13, marginBottom: 14 },
  badge: { display: "inline-block", padding: "4px 8px", borderRadius: 8, background: "rgba(99,102,241,0.18)", color: "#c7d2fe", fontWeight: 700, fontSize: 12 },
  title: { margin: "0 0 8px 0", fontSize: 32, color: "#f8fafc" },
  subtitle: { margin: "0 0 20px 0", color: "#cbd5e1" },
  drop: { border: "1.5px dashed rgba(148,163,184,0.6)", borderRadius: 16, padding: 16, background: "rgba(255,255,255,0.04)", textAlign: "center", cursor: "pointer", position: "relative" },
  input: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" },
  chip: { display: "inline-flex", alignItems: "center", padding: "8px 12px", marginTop: 10, borderRadius: 999, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#e2e8f0", fontSize: 13 },
  label: { display: "block", marginTop: 16, marginBottom: 8, color: "#cbd5e1", fontSize: 13, fontWeight: 700 },
  select: { width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "#111827", color: "#f8fafc", fontSize: 14, outline: "none" },
  toggleRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 14, color: "#cbd5e1", fontSize: 14, flexWrap: "wrap" },
  toggleHint: { color: "#94a3b8", fontSize: 12 },
  actions: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 },
  button: { padding: "12px 16px", border: "none", borderRadius: 10, background: "linear-gradient(120deg, #8b5cf6, #2563eb)", color: "#fff", fontWeight: 700, cursor: "pointer" },
  secondaryButton: { padding: "12px 16px", border: "1px solid rgba(148,163,184,0.4)", borderRadius: 10, background: "rgba(15,23,42,0.5)", color: "#cbd5e1", fontWeight: 700, cursor: "pointer" },
  secondaryButtonActive: { border: "1px solid rgba(56,189,248,0.65)", color: "#bae6fd", background: "rgba(14,116,144,0.22)" },
  secondaryButtonLoading: { border: "1px solid rgba(167,139,250,0.5)", color: "#c4b5fd", background: "rgba(109,40,217,0.18)", cursor: "wait" },
  stopButton: { padding: "12px 16px", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 10, background: "rgba(127,29,29,0.38)", color: "#fecaca", fontWeight: 700, cursor: "pointer" },
  waveformCanvas: { display: "block", width: "100%", height: 56, marginTop: 10, borderRadius: 10, background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.25)" },
  recordButton: { padding: "12px 16px", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 10, background: "rgba(127,29,29,0.22)", color: "#fca5a5", fontWeight: 700, cursor: "pointer" },
  recordingActiveButton: { padding: "12px 16px", border: "1px solid rgba(248,113,113,0.8)", borderRadius: 10, background: "rgba(185,28,28,0.45)", color: "#fecaca", fontWeight: 700, cursor: "pointer" },
  queuePanel: { marginTop: 14, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", gap: 6 },
  queueHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 },
  queueTitle: { fontWeight: 700, fontSize: 13, color: "#f8fafc" },
  queueSubtle: { fontSize: 12, color: "#94a3b8" },
  queueItem: { padding: "7px 10px", borderRadius: 8, background: "rgba(15,23,42,0.6)", border: "1px solid rgba(148,163,184,0.12)", display: "flex", flexDirection: "column", gap: 5 },
  queueItemActive: { border: "1px solid rgba(167,139,250,0.45)", background: "rgba(109,40,217,0.12)" },
  queueItemDone: { border: "1px solid rgba(34,197,94,0.3)", background: "rgba(20,83,45,0.18)" },
  queueItemError: { border: "1px solid rgba(248,113,113,0.35)", background: "rgba(127,29,29,0.18)" },
  queueItemTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  queueItemName: { fontSize: 12, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  queueItemBadge: { flexShrink: 0, fontSize: 11, color: "#94a3b8", fontWeight: 600 },
  progressWrap: { marginTop: 16 },
  progressMeta: { display: "flex", justifyContent: "space-between", gap: 12, color: "#cbd5e1", fontSize: 13, marginBottom: 8 },
  progressTrack: { height: 10, overflow: "hidden", borderRadius: 999, background: "rgba(148,163,184,0.22)", border: "1px solid rgba(255,255,255,0.06)" },
  progressBar: { height: "100%", borderRadius: 999, background: "linear-gradient(120deg, #22c55e, #38bdf8)", transition: "width 500ms ease" },
  progressBarIndeterminate: { width: "32%", height: "100%", borderRadius: 999, background: "linear-gradient(120deg, #22c55e, #38bdf8)" },
  elapsed: { marginTop: 8, color: "#94a3b8", fontSize: 13 },
  status: { marginTop: 14, maxHeight: 90, overflow: "auto", background: "#0b1020", color: "#e2e8f0", padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", whiteSpace: "pre-wrap" },
  transcript: { marginTop: 14, maxHeight: 140, overflow: "auto", padding: 12, paddingTop: 40, borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#f8fafc", position: "relative" },
  transcriptBody: { marginTop: 8, whiteSpace: "pre-wrap" },
  transcriptCopyButton: { position: "absolute", top: 10, right: 10, border: "1px solid rgba(148,163,184,0.3)", borderRadius: 8, padding: "6px 10px", background: "rgba(15,23,42,0.92)", color: "#cbd5e1", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  historyPanel: { marginTop: 14, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" },
  historyHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 10, color: "#f8fafc" },
  historySubtle: { color: "#94a3b8", fontSize: 12 },
  historyState: { color: "#cbd5e1", fontSize: 14, padding: "8px 0" },
  historyList: { maxHeight: 220, overflow: "auto", display: "grid", gap: 10 },
  historyItem: { padding: 10, borderRadius: 10, background: "rgba(15,23,42,0.7)", border: "1px solid rgba(148,163,184,0.18)" },
  historyItemHeadingRow: { display: "flex", alignItems: "flex-start", gap: 8 },
  historyItemButton: { flex: 1, border: "none", background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", color: "inherit", minWidth: 0 },
  historyItemHeading: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 },
  historyItemTitle: { color: "#f8fafc", fontSize: 14 },
  historyItemChevron: { color: "#94a3b8", fontSize: 12, fontWeight: 700 },
  historyItemMeta: { display: "flex", flexWrap: "wrap", gap: 10, color: "#94a3b8", fontSize: 12 },
  historyDeleteButton: { flexShrink: 0, border: "1px solid rgba(248,113,113,0.3)", borderRadius: 7, padding: "4px 8px", background: "transparent", color: "#f87171", fontSize: 12, cursor: "pointer", lineHeight: 1 },
  audioPlayer: { display: "flex", gap: 10, marginTop: 8, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" },
  audioControls: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 },
  audioControlsRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  audioPlayButton: { flexShrink: 0, minWidth: 56, height: 32, border: "1px solid rgba(167,139,250,0.5)", borderRadius: 8, background: "rgba(109,40,217,0.25)", color: "#c4b5fd", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  audioTransportButton: { flexShrink: 0, minWidth: 52, height: 32, border: "1px solid rgba(148,163,184,0.3)", borderRadius: 8, background: "rgba(15,23,42,0.82)", color: "#cbd5e1", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  audioSliderRow: { display: "flex", alignItems: "center" },
  audioSlider: { width: "100%", margin: 0, accentColor: "#8b5cf6", cursor: "pointer" },
  audioTime: { marginLeft: "auto", color: "#94a3b8", fontSize: 11, textAlign: "right" },
  audioVolumeRow: { display: "flex", alignItems: "center", gap: 8 },
  audioVolumeLabel: { color: "#94a3b8", fontSize: 11, minWidth: 42 },
  audioVolumeSlider: { flex: 1, margin: 0, accentColor: "#38bdf8", cursor: "pointer" },
  audioVolumeValue: { color: "#cbd5e1", fontSize: 11, minWidth: 36, textAlign: "right" },
  historyTranscriptPanel: { marginTop: 10, paddingTop: 34, position: "relative" },
  historyTranscript: { color: "#f8fafc", whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5 },
  historyCopyButton: { position: "absolute", top: 0, right: 0, border: "1px solid rgba(148,163,184,0.3)", borderRadius: 8, padding: "6px 10px", background: "rgba(15,23,42,0.92)", color: "#cbd5e1", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  widgetsPane: { width: "100%", minWidth: 0, maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxSizing: "border-box", background: "rgba(2,6,23,0.78)", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 16, padding: 14 },
  widgetsGrid: { marginTop: 10, display: "grid", gridTemplateColumns: "1fr", gap: 9 },
  widgetCard: { padding: 10, borderRadius: 10, background: "rgba(15,23,42,0.72)", border: "1px solid rgba(148,163,184,0.2)" },
  monitorHeader: { fontSize: 18, fontWeight: 700, color: "#f8fafc" },
  monitorHeaderRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  monitorSubtle: { color: "#94a3b8", fontSize: 14, marginTop: 4 },
  monitorMeta: { marginTop: 8, color: "#94a3b8", fontSize: 11, lineHeight: 1.45 },
  monitorControls: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 },
  viewToggle: { display: "inline-flex", padding: 3, borderRadius: 9, background: "rgba(15,23,42,0.72)", border: "1px solid rgba(148,163,184,0.22)" },
  viewToggleButton: { border: "none", borderRadius: 7, padding: "6px 9px", background: "transparent", color: "#94a3b8", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  rangeToggleButton: { border: "none", borderRadius: 7, padding: "5px 7px", background: "transparent", color: "#94a3b8", fontWeight: 700, cursor: "pointer", fontSize: 11 },
  viewToggleButtonActive: { background: "rgba(56,189,248,0.18)", color: "#bae6fd" },
  monitorRowTop: { display: "flex", justifyContent: "space-between", color: "#cbd5e1", fontSize: 13, marginBottom: 6 },
  monitorTrack: { height: 10, borderRadius: 999, overflow: "hidden", background: "rgba(148,163,184,0.25)", border: "1px solid rgba(255,255,255,0.06)" },
  monitorFill: { height: "100%", transition: "width 280ms ease" },
  usageGraph: { width: "100%", height: 58, marginTop: 8, borderRadius: 8, background: "rgba(2,6,23,0.45)", border: "1px solid rgba(148,163,184,0.18)", display: "block" },
  graphGridLine: { stroke: "rgba(148,163,184,0.18)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" },
};
