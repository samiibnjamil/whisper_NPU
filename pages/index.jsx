import { useEffect, useRef, useState } from "react";
import Head from "next/head";

const MODELS = [
  { value: "medium", label: "Whisper Medium.en", detail: "Higher accuracy" },
  { value: "small", label: "Whisper Small", detail: "Faster" },
];
const USAGE_KEYS = ["cpuPercent", "ramPercent", "gpuPercent", "npuPercent"];
const USAGE_RANGES = [1, 2, 5, 10];
const MAX_USAGE_HISTORY_MS = 10 * 60 * 1000;

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

function usagePercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usageValueLabel(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return `${value.toFixed(1)}%`;
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
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [finalElapsedSeconds, setFinalElapsedSeconds] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(1366);
  const dropRef = useRef(null);
  const transcriptionStartedAt = useRef(null);
  const xhrRef = useRef(null);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth || 1366);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    if (!loading || stage !== "transcribing") return;
    const timer = window.setInterval(() => {
      if (!transcriptionStartedAt.current) return;
      setElapsedSeconds((Date.now() - transcriptionStartedAt.current) / 1000);
    }, 250);
    return () => window.clearInterval(timer);
  }, [loading, stage]);

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

  const onFile = (f) => {
    setFile(f);
    setTranscript("");
    setStatus("");
    setProgress(0);
    setStage("idle");
    setElapsedSeconds(0);
    setFinalElapsedSeconds(null);
    setUsage(null);
    xhrRef.current = null;
  };

  const submit = async () => {
    if (!file) return;
    setLoading(true);
    setStage("uploading");
    setStatus("Uploading");
    setProgress(0);
    setElapsedSeconds(0);
    setFinalElapsedSeconds(null);
    setTranscript("");
    setUsage(null);

    const form = new FormData();
    form.append("audio", file);
    form.append("model", model);
    form.append("showUsage", "1");

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let responseOffset = 0;
    let responseBuffer = "";
    let completed = false;

    const handleEvent = (event) => {
      if (event.type === "stage") {
        setStage(event.stage);
        setStatus(event.message || event.stage);
        if (["queued", "preparing", "loading_model"].includes(event.stage)) setProgress(0);
        if (event.stage === "transcribing") {
          transcriptionStartedAt.current = Date.now();
          setElapsedSeconds(0);
          setProgress(0);
        }
      }
      if (event.type === "progress") {
        setStage(event.stage || "transcribing");
        setStatus("Transcribing");
        setProgress(event.progress ?? 0);
      }
      if (event.type === "complete") {
        completed = true;
        setStage("complete");
        setProgress(100);
        setTranscript(event.transcript || "");
        setFinalElapsedSeconds(event.elapsedSeconds ?? null);
        setStatus("Done");
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

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setStage("uploading");
      setStatus("Uploading");
      setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onprogress = () => {
      try {
        readEvents();
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        setStage("error");
        setProgress(0);
        xhr.abort();
      }
    };
    xhr.onload = () => {
      try {
        readEvents();
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(xhr.responseText || "Transcription failed");
        if (!completed) throw new Error("Transcription ended without a completion event.");
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        setStage("error");
        setProgress(0);
      } finally {
        setLoading(false);
        xhrRef.current = null;
      }
    };
    xhr.onerror = () => {
      setStatus("Error: Network request failed");
      setStage("error");
      setProgress(0);
      setLoading(false);
      xhrRef.current = null;
    };
    xhr.onabort = () => {
      setStatus("Stopped");
      setStage("stopped");
      setProgress(0);
      setLoading(false);
      xhrRef.current = null;
    };

    xhr.open("POST", "/api/transcribe");
    xhr.send(form);
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
          <div style={styles.pill}><span style={styles.badge}>NPU</span>Intel AI Boost · Whisper (OpenVINO)</div>
          <h1 style={styles.title}>Transcribe locally</h1>
          <p style={styles.subtitle}>Drag & drop audio (.wav, .m4a, .mp3). All inference stays on-device via your NPU.</p>
          <div ref={dropRef} style={styles.drop} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }}>
            <input type="file" accept="audio/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} style={styles.input} />
            <div>Drop a file here or click to browse</div>
            {file && <div style={styles.chip}>{file.name}</div>}
          </div>
          <label style={styles.label} htmlFor="model">Whisper model</label>
          <select id="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={loading} style={styles.select}>
            {MODELS.map((option) => <option key={option.value} value={option.value}>{option.label} - {option.detail}</option>)}
          </select>
          <label style={styles.toggleRow}>
            <input type="checkbox" checked={splitSpeakers} onChange={(e) => setSplitSpeakers(e.target.checked)} disabled />
            <span>Split transcript by speaker (not working yet)</span>
            <span style={styles.toggleHint}>Requires speaker diarization</span>
          </label>
          <div style={styles.actions}>
            <button style={styles.button} disabled={!file || loading} onClick={submit}>{loading ? "Transcribing..." : "Transcribe"}</button>
            <button style={{ ...styles.secondaryButton, ...(showUsage ? styles.secondaryButtonActive : {}) }} onClick={() => setShowUsage((v) => !v)}>
              {showUsage ? "Hide Usage" : "Show Usage"}
            </button>
            {loading && <button style={styles.stopButton} onClick={() => xhrRef.current?.abort()}>Stop</button>}
          </div>
          {(loading || progress > 0) && (
            <div style={styles.progressWrap} aria-label="Transcription progress">
              <div style={styles.progressMeta}><span>{progressLabel(stage)}</span><span>{isIndeterminateStage(stage) ? "Working" : `${progress}%`}</span></div>
              <div style={styles.progressTrack}>{isIndeterminateStage(stage) ? <div className="indeterminateBar" style={styles.progressBarIndeterminate} /> : <div style={{ ...styles.progressBar, width: `${progress}%` }} />}</div>
              {(stage === "transcribing" || finalElapsedSeconds !== null) && <div style={styles.elapsed}>Transcription time: {formatSeconds(finalElapsedSeconds ?? elapsedSeconds)}</div>}
            </div>
          )}
          {status && <pre style={styles.status}>{status}</pre>}
          {transcript && <div style={styles.transcript}><strong>Transcript</strong><div>{transcript}</div></div>}
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
                return (
                  <div key={item.key} style={styles.widgetCard}>
                    <div style={styles.monitorRowTop}><span>{item.label}</span><span>{usageValueLabel(value)}</span></div>
                    {usageView === "bar" ? (
                      <div style={styles.monitorTrack}><div style={{ ...styles.monitorFill, width: `${usagePercent(value)}%`, background: item.color }} /></div>
                    ) : (
                      <svg viewBox="0 0 220 72" preserveAspectRatio="none" style={styles.usageGraph}>
                        <path d="M0 18 H220 M0 36 H220 M0 54 H220" style={styles.graphGridLine} />
                        <polyline points={graphPoints(usageHistory[item.key], usageRangeMinutes)} fill="none" stroke={item.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
            </section>
          )}
        </div>
        <style jsx>{`@keyframes indeterminateProgress {0% {transform: translateX(-120%);}100% {transform: translateX(320%);}} .indeterminateBar {animation: indeterminateProgress 1.2s ease-in-out infinite;}`}</style>
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
  stopButton: { padding: "12px 16px", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 10, background: "rgba(127,29,29,0.38)", color: "#fecaca", fontWeight: 700, cursor: "pointer" },
  progressWrap: { marginTop: 16 },
  progressMeta: { display: "flex", justifyContent: "space-between", gap: 12, color: "#cbd5e1", fontSize: 13, marginBottom: 8 },
  progressTrack: { height: 10, overflow: "hidden", borderRadius: 999, background: "rgba(148,163,184,0.22)", border: "1px solid rgba(255,255,255,0.06)" },
  progressBar: { height: "100%", borderRadius: 999, background: "linear-gradient(120deg, #22c55e, #38bdf8)", transition: "width 500ms ease" },
  progressBarIndeterminate: { width: "32%", height: "100%", borderRadius: 999, background: "linear-gradient(120deg, #22c55e, #38bdf8)" },
  elapsed: { marginTop: 8, color: "#94a3b8", fontSize: 13 },
  status: { marginTop: 14, maxHeight: 90, overflow: "auto", background: "#0b1020", color: "#e2e8f0", padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", whiteSpace: "pre-wrap" },
  transcript: { marginTop: 14, maxHeight: 140, overflow: "auto", padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#f8fafc" },
  widgetsPane: { width: "100%", minWidth: 0, maxHeight: "calc(100vh - 48px)", overflow: "hidden", boxSizing: "border-box", background: "rgba(2,6,23,0.78)", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 16, padding: 14 },
  widgetsGrid: { marginTop: 10, display: "grid", gridTemplateColumns: "1fr", gap: 9 },
  widgetCard: { padding: 10, borderRadius: 10, background: "rgba(15,23,42,0.72)", border: "1px solid rgba(148,163,184,0.2)" },
  monitorHeader: { fontSize: 18, fontWeight: 700, color: "#f8fafc" },
  monitorHeaderRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  monitorSubtle: { color: "#94a3b8", fontSize: 14, marginTop: 4 },
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
