import express from "express";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT           = parseInt(process.env.PORT || "8080", 10);
const SNAPSHOT_DIR   = process.env.SNAPSHOT_DIR   || path.join(__dirname, "snapshots");
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || "4194304", 10);
const UPLOAD_TOKEN   = process.env.UPLOAD_TOKEN || "";

await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");

// 10 uploads / minute / IP.
const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: 10, ts: now };
  const elapsedMs = now - b.ts;
  b.tokens = Math.min(10, b.tokens + (elapsedMs / 60_000) * 10);
  b.ts = now;
  if (b.tokens < 1) {
    res.status(429).json({ error: "rate limited" });
    return;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  next();
}

// API 

app.post(
  "/api/upload",
  rateLimit,
  express.raw({ type: "application/json", limit: MAX_BODY_BYTES }),
  async (req, res) => {
    if (UPLOAD_TOKEN && req.get("X-Thunder-Token") !== UPLOAD_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: "empty body" });
    }

    let parsed;
    try {
      parsed = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid json" });
    }
    if (!parsed.meta || parsed.meta.schema !== "thunder/1") {
      return res.status(400).json({ error: "schema mismatch (expected thunder/1)" });
    }

    const id = nanoid(10);
    const file = path.join(SNAPSHOT_DIR, `${id}.json`);
    await fs.writeFile(file, JSON.stringify(parsed));

    const host = req.get("Host");
    const url  = `https://${host}/profile/${id}`;
    console.log(`[upload] ${id} from ${req.ip} (${req.body.length} bytes) → ${url}`);
    res.json({ id, url });
  }
);

app.get("/api/snapshot/:id", async (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(id)) return res.status(400).end();
  try {
    const data = await fs.readFile(path.join(SNAPSHOT_DIR, `${id}.json`), "utf8");
    res.type("application/json").send(data);
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  maxAge: "1h",
}));

app.get("/profile/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

const TTL_MS            = 60 * 60 * 1000;     // 1 hour
const SWEEP_INTERVAL_MS = 5  * 60 * 1000;     // check every 5 minutes

async function sweepOldSnapshots() {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR);
    const now = Date.now();
    let removed = 0;
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(SNAPSHOT_DIR, name);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs > TTL_MS) {
          await fs.unlink(full);
          removed++;
        }
      } catch {}
    }
    if (removed > 0) console.log(`[sweep] removed ${removed} expired snapshot(s)`);
  } catch (e) {
    console.error("[sweep] failed:", e.message);
  }
}

sweepOldSnapshots();
setInterval(sweepOldSnapshots, SWEEP_INTERVAL_MS);

// start

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Thunder viewer listening on 127.0.0.1:${PORT}`);
});
