import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import formidable from "formidable";
import { appendTranscriptHistory } from "../../lib/transcript-history";
import { resolveEngineModel } from "../../lib/engines";

function writeEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`${JSON.stringify(event)}\n`);
  }
}

function endResponse(res) {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseForm(req) {
  const form = formidable({ multiples: false, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const { fields, files } = await parseForm(req);
    const file = files.audio;
    if (!file) {
      res.status(400).send("No file uploaded under field 'audio'.");
      return;
    }

    const requestedEngine = Array.isArray(fields.engine) ? fields.engine[0] : fields.engine;
    const requestedModel = Array.isArray(fields.model) ? fields.model[0] : fields.model;
    const showUsageRaw = Array.isArray(fields.showUsage) ? fields.showUsage[0] : fields.showUsage;
    const showUsage = showUsageRaw === "1";
    const engineKey = requestedEngine || "whisper";
    const modelKey = requestedModel || "medium";
    const resolved = resolveEngineModel(engineKey, modelKey);
    if (!resolved) {
      res.status(400).send(`Unsupported engine/model combination '${engineKey}/${modelKey}'.`);
      return;
    }
    const { engine, model: modelInfo } = resolved;
    const modelFolder = modelInfo.folder;

    const audioPath = Array.isArray(file) ? file[0].filepath : file.filepath;
    const originalFilename = Array.isArray(file) ? file[0].originalFilename : file.originalFilename;
    const projectRoot = process.cwd();

    // Save a permanent copy of the audio before transcription
    const recordingsDir = path.join(projectRoot, "data", "recordings");
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
    const audioExt = path.extname(originalFilename || audioPath) || ".webm";
    const audioSaveId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const savedAudioPath = path.join(recordingsDir, `${audioSaveId}${audioExt}`);
    try { fs.copyFileSync(audioPath, savedAudioPath); } catch { /* non-fatal */ }
    const pythonBin = path.join(projectRoot, ".venv", "Scripts", "python.exe");
    const scriptPath = path.join(projectRoot, engine.script);
    const modelDir = path.join(projectRoot, "models", modelFolder);

    const args = [
      scriptPath,
      "--audio",
      audioPath,
      "--model-dir",
      modelDir,
      "--progress-json",
    ];
    if (engineKey === "whisper") {
      args.push("--language", "en");
    }
    if (showUsage) {
      args.push("--emit-usage");
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    writeEvent(res, { type: "stage", stage: "queued", message: "Starting transcription" });

    const child = spawn(pythonBin, args, { cwd: projectRoot });
    let stdoutBuffer = "";
    let stderr = "";
    let childClosed = false;

    const cleanupUpload = () => fs.unlink(audioPath, () => {});

    res.on("close", () => {
      if (!childClosed) {
        child.kill();
        cleanupUpload();
      }
    });

    child.stdout.on("data", (d) => {
      stdoutBuffer += d.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "complete" && event.transcript) {
            const historyEntry = appendTranscriptHistory({
              transcript: event.transcript,
              model: modelKey,
              elapsedSeconds: event.elapsedSeconds ?? null,
              fileName: originalFilename || path.basename(audioPath),
              audioFile: fs.existsSync(savedAudioPath) ? `${audioSaveId}${audioExt}` : null,
            });
            writeEvent(res, { ...event, historyEntry });
            continue;
          }
          writeEvent(res, event);
        } catch {
          writeEvent(res, { type: "log", message: line });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      childClosed = true;
      cleanupUpload();
      writeEvent(res, { type: "error", message: err.message || "Failed to start process" });
      endResponse(res);
    });
    child.on("close", (code) => {
      childClosed = true;
      cleanupUpload();
      if (code !== 0) {
        writeEvent(res, { type: "error", message: stderr || `Failed with code ${code}` });
      }
      endResponse(res);
    });
  } catch (err) {
    if (!res.writableEnded) {
      res.status(500).send(err?.message || "Unexpected error");
    }
  }
}
