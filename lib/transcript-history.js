import fs from "fs";
import path from "path";

const HISTORY_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(HISTORY_DIR, "transcript-history.json");

function ensureHistoryFile() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, "[]", "utf8");
  }
}

export function getTranscriptHistory() {
  ensureHistoryFile();
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendTranscriptHistory(entry) {
  const history = getTranscriptHistory();
  const nextEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
    ...entry,
  };
  history.unshift(nextEntry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
  return nextEntry;
}

export function deleteTranscriptEntry(id) {
  const history = getTranscriptHistory();
  const entry = history.find((e) => e.id === id);
  if (!entry) return false;

  // Delete saved audio file if present
  if (entry.audioFile) {
    const audioPath = path.join(HISTORY_DIR, "recordings", entry.audioFile);
    try { fs.unlinkSync(audioPath); } catch {}
  }

  const next = history.filter((e) => e.id !== id);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(next, null, 2), "utf8");
  return true;
}
