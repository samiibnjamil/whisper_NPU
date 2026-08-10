import { loadModel, getModelStatus } from "../../lib/model-process";
import { resolveEngineModel } from "../../lib/engines";

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const engineKey = req.query?.engine || "whisper";
  const modelKey = req.query?.model || "medium";
  const resolved = resolveEngineModel(engineKey, modelKey);
  if (!resolved) {
    res.status(400).send(`Unsupported engine/model combination '${engineKey}/${modelKey}'.`);
    return;
  }
  const { engine, model } = resolved;

  const status = getModelStatus(engineKey, modelKey);
  if (status === "ready") {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`${JSON.stringify({ type: "complete", message: "Model already loaded" })}\n`);
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const unsubscribe = loadModel({
    engineKey,
    modelKey,
    scriptName: engine.script,
    modelFolder: model.folder,
    projectRoot: process.cwd(),
    onEvent: (event) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`${JSON.stringify(event)}\n`);
        if (event.type === "complete" || event.type === "error") {
          res.end();
          unsubscribe();
        }
      }
    },
  });

  res.on("close", () => unsubscribe());
}
