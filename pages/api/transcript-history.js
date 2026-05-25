import { getTranscriptHistory, deleteTranscriptEntry } from "../../lib/transcript-history";

export default function handler(req, res) {
  if (req.method === "GET") {
    try {
      res.status(200).json({ history: getTranscriptHistory() });
    } catch (err) {
      res.status(500).json({ error: err?.message || "Failed to load transcript history" });
    }
    return;
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) { res.status(400).json({ error: "Missing id" }); return; }
    try {
      const deleted = deleteTranscriptEntry(id);
      if (!deleted) { res.status(404).json({ error: "Entry not found" }); return; }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || "Failed to delete entry" });
    }
    return;
  }

  res.status(405).send("Method not allowed");
}
