import { loadModel, getModelStatus } from "../../lib/model-process";

const MODEL_DIRS = {
  small: "whisper-small-openvino-stateless",
  medium: "whisper-medium-en-openvino-stateless",
};

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const modelKey = req.query?.model || "medium";
  const modelFolder = MODEL_DIRS[modelKey];
  if (!modelFolder) {
    res.status(400).send(`Unsupported model '${modelKey}'.`);
    return;
  }

  const status = getModelStatus(modelKey);
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
    modelKey,
    modelFolder,
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
