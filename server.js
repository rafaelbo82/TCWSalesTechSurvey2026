"use strict";
/*
 * Transformation Starting Lineup: live survey server.
 * No dependencies. Votes persist in an append-only log. Results stream over Server-Sent Events.
 *
 * Environment:
 *   PORT         listen port (default 3000)
 *   DATA_DIR     where votes are stored (default ./data). Point this at a persistent disk.
 *   ADMIN_KEY    enables CSV export and reset. Without it, those endpoints stay off.
 *   TRUST_PROXY  set to 1 behind a hosting proxy so rate limits see the real client address.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const BUDGET = 15;
const MAX_BODY = 4096;
const MAX_VOTERS = 20000;
const RATE_PER_MIN = 300; // Generous, because a whole venue can share one address.
const TYPES = new Set(["challenger", "pacesetter", "pragmatist", "controller"]);
const LOBS = new Set(["strategic-partnership", "wag", "ria", "internal-desk", "na-institutional"]);
const LOG = path.join(DATA_DIR, "votes.ndjson");

/* ---------- page ---------- */
const SKELETON =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}" +
  "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>" +
  "<script>window.__SERVER_MODE__=true</script></head><body>";
const page = fs
  .readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcode-generator\/[^"]+/, "/vendor/qrcode.js");
const HTML = SKELETON + page + "</body></html>";
const QR_JS = fs.readFileSync(path.join(__dirname, "public", "vendor", "qrcode.js"));

const scriptHashes = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`)
  .join(" ");
const SECURITY = {
  "Content-Security-Policy":
    `default-src 'self'; script-src 'self' ${scriptHashes}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/* ---------- storage ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const votes = new Map(); // public id -> {type, lob, picks, at}
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      votes.set(r.id, { type: r.type, lob: r.lob, picks: r.picks, at: r.at });
    } catch {
      console.warn("Skipped a damaged log line");
    }
  }
}

/* ---------- validation ---------- */
const publicId = (token) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 20);
const validToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);

function checkVote(body) {
  if (!validToken(body.voter)) return "This browser's voter ID isn't valid. Reload the page and try again.";
  if (!LOBS.has(body.lob)) return "Choose your line of business.";
  if (!TYPES.has(body.type)) return "Choose a firm type.";
  if (!Array.isArray(body.picks) || !body.picks.length) return "Pick at least one use case.";
  if (body.picks.some((p) => typeof p !== "string" || !/^[A-E][1-5]$/.test(p))) return "That lineup includes an unknown use case.";
  if (new Set(body.picks).size !== body.picks.length) return "That lineup repeats a use case.";
  const spent = body.picks.reduce((s, p) => s + Number(p[1]), 0);
  if (spent > BUDGET) return `That lineup costs $${spent}. The budget is $${BUDGET}.`;
  return null;
}
const publicVote = (v) => ({ type: v.type, lob: v.lob, picks: v.picks });

/* ---------- live stream ---------- */
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => {
  for (const c of clients) c.write(": keep-alive\n\n");
}, 25000).unref();

/* ---------- rate limit ---------- */
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limited(req) {
  const fwd = TRUST_PROXY && req.headers["x-forwarded-for"];
  const ip = fwd ? fwd.split(",").pop().trim() : req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > RATE_PER_MIN;
}

/* ---------- helpers ---------- */
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const a = crypto.createHash("sha256").update(String(req.headers["x-admin-key"] || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Stops spreadsheets from running a value as a formula.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /" || route === "HEAD /") return send(res, 200, HTML, "text/html; charset=utf-8");
    if (route === "GET /vendor/qrcode.js") return send(res, 200, QR_JS, "text/javascript; charset=utf-8");
    if (route === "GET /healthz") return send(res, 200, { ok: true, responses: votes.size });

    if (route === "GET /api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...SECURITY,
      });
      const all = {};
      for (const [id, v] of votes) all[id] = publicVote(v);
      res.write(`retry: 3000\nevent: init\ndata: ${JSON.stringify(all)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (route === "POST /api/me" || route === "POST /api/vote") {
      if (limited(req)) return send(res, 429, { error: "Too many requests. Wait a minute and try again." });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "That request couldn't be read." });
      }
      if (route === "POST /api/me") {
        if (!validToken(body.voter)) return send(res, 400, { error: "Invalid voter ID." });
        const id = publicId(body.voter);
        return send(res, 200, { id });
      }
      const problem = checkVote(body);
      if (problem) return send(res, 400, { error: problem });
      const id = publicId(body.voter);
      if (!votes.has(id) && votes.size >= MAX_VOTERS) return send(res, 503, { error: "The survey is full." });
      const record = { type: body.type, lob: body.lob, picks: body.picks, at: new Date().toISOString() };
      fs.appendFileSync(LOG, JSON.stringify({ id, ...record }) + "\n");
      votes.set(id, record);
      broadcast("vote", { id, vote: publicVote(record) });
      return send(res, 200, { id });
    }

    if (route === "GET /api/export.csv") {
      if (!isAdmin(req)) return send(res, 403, { error: "Admin key required." });
      const rows = [["line_of_business", "firm_type", "picks", "spent", "submitted_at"]];
      for (const v of votes.values()) {
        rows.push([v.lob || "", v.type, v.picks.join(" "), v.picks.reduce((s, p) => s + Number(p[1]), 0), v.at]);
      }
      return send(res, 200, rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", "text/csv; charset=utf-8", {
        "Content-Disposition": 'attachment; filename="lineup-responses.csv"',
      });
    }

    if (route === "POST /api/reset") {
      if (!isAdmin(req)) return send(res, 403, { error: "Admin key required." });
      // Archive rather than delete, so an accidental reset can be recovered.
      if (fs.existsSync(LOG)) fs.renameSync(LOG, path.join(DATA_DIR, `votes-archived-${Date.now()}.ndjson`));
      votes.clear();
      broadcast("reset", {});
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Not found." });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong on the server. Try again." });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Survey on http://localhost:${PORT}  (${votes.size} responses loaded, admin ${ADMIN_KEY ? "on" : "off"})`);
});
