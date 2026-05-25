import fs from "fs";
import path from "path";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const { id } = req.query;
  // id is the full filename e.g. "1234567890-abc123.webm"
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
    res.status(400).send("Invalid id");
    return;
  }

  const filePath = path.join(process.cwd(), "data", "recordings", id);
  if (!fs.existsSync(filePath)) {
    res.status(404).send("Recording not found");
    return;
  }

  const ext = path.extname(id).toLowerCase();
  const mimeTypes = { ".webm": "audio/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
  const contentType = mimeTypes[ext] || "application/octet-stream";

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
}
