import { spawn } from "child_process";
import path from "path";

// Module-level map: modelKey -> { state, child, subscribers }
// Persists across API requests within the same Node process.
const sessions = {};

export function getModelStatus(modelKey) {
  const s = sessions[modelKey];
  if (!s) return "idle";
  return s.state; // "loading" | "ready" | "error"
}

// Subscribe to events from an ongoing load, or start a new one.
// onEvent(event) is called for each JSON event; returns an unsubscribe fn.
export function loadModel({ modelKey, modelFolder, projectRoot, onEvent }) {
  const existing = sessions[modelKey];

  if (existing?.state === "ready") {
    onEvent({ type: "stage", stage: "ready", message: "Model already loaded" });
    onEvent({ type: "complete", message: "Model already loaded" });
    return () => {};
  }

  if (existing?.state === "loading") {
    existing.subscribers.push(onEvent);
    onEvent({ type: "stage", stage: "loading_model", message: "Loading model on NPU (already in progress)" });
    return () => {
      const idx = existing.subscribers.indexOf(onEvent);
      if (idx !== -1) existing.subscribers.splice(idx, 1);
    };
  }

  const session = { state: "loading", child: null, subscribers: [onEvent] };
  sessions[modelKey] = session;

  const pythonBin = path.join(projectRoot, ".venv", "Scripts", "python.exe");
  const scriptPath = path.join(projectRoot, "whisper_npu.py");
  const modelDir = path.join(projectRoot, "models", modelFolder);

  const child = spawn(
    pythonBin,
    [scriptPath, "--model-dir", modelDir, "--preload-only", "--progress-json"],
    { cwd: projectRoot }
  );
  session.child = child;

  let buf = "";
  const broadcast = (event) => { for (const cb of session.subscribers) cb(event); };

  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { broadcast(JSON.parse(line)); } catch {}
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  child.on("error", (err) => {
    session.state = "error";
    broadcast({ type: "error", message: err.message || "Failed to start process" });
    delete sessions[modelKey];
  });

  child.on("close", (code) => {
    if (code === 0) {
      session.state = "ready";
      broadcast({ type: "complete", message: "Model loaded and ready" });
    } else {
      session.state = "error";
      broadcast({ type: "error", message: stderr.trim() || `Model load exited with code ${code}` });
      delete sessions[modelKey];
    }
    session.subscribers = [];
  });

  return () => {
    const idx = session.subscribers.indexOf(onEvent);
    if (idx !== -1) session.subscribers.splice(idx, 1);
  };
}

export function unloadModel(modelKey) {
  const s = sessions[modelKey];
  if (s?.child) { try { s.child.kill(); } catch {} }
  delete sessions[modelKey];
}
