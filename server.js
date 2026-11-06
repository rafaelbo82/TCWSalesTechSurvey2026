"use strict";
/*
 * Distribution Transformation Roadmap: live survey server.
 * No dependencies. Votes persist in an append-only log. Results stream over Server-Sent Events.
 *
 * Environment:
 *   PORT             listen port (default 3000)
 *   DATA_DIR         where votes are stored (default ./data). Point this at a persistent disk.
 *   SURVEY_PASSWORD  password attendees enter to open the survey (default tcw2026*)
 *   ADMIN_KEY        unlocks the organizer tools: close/reopen voting, downloads and reset. Without it, they stay off.
 *   TRUST_PROXY      set to 1 behind a hosting proxy so rate limits and secure cookies see the real request.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PASSWORD = process.env.SURVEY_PASSWORD || "tcw2026*";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const BUDGET = 15;
const MAX_BODY = 4096;
const MAX_VOTERS = 20000;
const RATE_PER_MIN = 300; // Generous, because a whole venue can share one address.
const LOGIN_PER_MIN = 60;
const LOB_NAMES = {
  "strategic-partnership": "Strategic Partnership",
  wag: "WAG",
  ria: "RIA",
  "internal-desk": "Internal Desk",
  "na-institutional": "NA Institutional",
};
const TYPE_NAMES = { challenger: "Challenger", pacesetter: "Pacesetter", pragmatist: "Pragmatist", controller: "Controller" };
const LOBS = new Set(Object.keys(LOB_NAMES));
const TYPES = new Set(Object.keys(TYPE_NAMES));
const CODES = [];
for (const c of "ABCDE") for (let n = 1; n <= 5; n++) CODES.push(c + n);
const LOG = path.join(DATA_DIR, "votes.ndjson");
const STATE = path.join(DATA_DIR, "state.json");

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
let open = true;
try {
  open = JSON.parse(fs.readFileSync(STATE, "utf8")).open !== false;
} catch {}
const saveState = () => fs.writeFileSync(STATE, JSON.stringify({ open }));

/* ---------- access ---------- */
const same = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest()
  );
// Changing the password changes this token, which signs everyone out.
const ACCESS = crypto.createHmac("sha256", PASSWORD).update("lineup-access-v1").digest("hex");
function cookie(req, name) {
  const c = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith(name + "="));
  try {
    return c ? decodeURIComponent(c.slice(name.length + 1)) : "";
  } catch {
    return "";
  }
}
const hasAccess = (req) => same(cookie(req, "lineup_access"), ACCESS);
const isAdmin = (req) => !!ADMIN_KEY && same(req.headers["x-admin-key"] || "", ADMIN_KEY);
const isHttps = (req) => (TRUST_PROXY ? req.headers["x-forwarded-proto"] === "https" : !!req.socket.encrypted);

/* ---------- validation ---------- */
const publicId = (token) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 20);
const validToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const spentOf = (picks) => picks.reduce((s, p) => s + Number(p[1]), 0);

function checkVote(body) {
  if (!validToken(body.voter)) return "This browser's voter ID isn't valid. Reload the page and try again.";
  if (!LOBS.has(body.lob)) return "Choose your line of business.";
  if (!TYPES.has(body.type)) return "Choose a firm type.";
  if (!Array.isArray(body.picks) || !body.picks.length) return "Pick at least one use case.";
  if (body.picks.some((p) => typeof p !== "string" || !/^[A-E][1-5]$/.test(p))) return "That lineup includes an unknown use case.";
  if (new Set(body.picks).size !== body.picks.length) return "That lineup repeats a use case.";
  const spent = spentOf(body.picks);
  if (spent > BUDGET) return `That lineup costs $${spent}. The budget is $${BUDGET}.`;
  return null;
}
const publicVote = (v) => ({ type: v.type, lob: v.lob, picks: v.picks, at: v.at });

/* ---------- live stream ---------- */
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => {
  for (const c of clients) c.write(": keep-alive\n\n");
}, 25000).unref();

/* ---------- rate limits ---------- */
const hits = new Map();
const loginHits = new Map();
setInterval(() => {
  hits.clear();
  loginHits.clear();
}, 60000).unref();
function clientIp(req) {
  const fwd = TRUST_PROXY && req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",").pop().trim() : req.socket.remoteAddress;
}
function limited(req, map = hits, max = RATE_PER_MIN) {
  const ip = clientIp(req);
  const n = (map.get(ip) || 0) + 1;
  map.set(ip, n);
  return n > max;
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
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Stops spreadsheets from running a value as a formula.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const LOCKED = { error: "Enter the survey password first." };

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /" || route === "HEAD /") return send(res, 200, HTML, "text/html; charset=utf-8");
    if (route === "GET /vendor/qrcode.js") return send(res, 200, QR_JS, "text/javascript; charset=utf-8");
    if (route === "GET /healthz") return send(res, 200, { ok: true });

    if (route === "POST /api/login") {
      if (limited(req, loginHits, LOGIN_PER_MIN)) return send(res, 429, { error: "Too many attempts. Wait a minute and try again." });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "That request couldn't be read." });
      }
      if (typeof body.password !== "string" || !same(body.password, PASSWORD)) {
        return send(res, 401, { error: "That password isn't right." });
      }
      const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${isHttps(req) ? "; Secure" : ""}`;
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": `lineup_access=${ACCESS}; ${flags}` });
    }

    if (route === "GET /api/stream") {
      if (!hasAccess(req)) return send(res, 401, LOCKED);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...SECURITY,
      });
      const all = {};
      for (const [id, v] of votes) all[id] = publicVote(v);
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify({ open })}\n\nevent: init\ndata: ${JSON.stringify(all)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (route === "POST /api/me" || route === "POST /api/vote") {
      if (limited(req)) return send(res, 429, { error: "Too many requests. Wait a minute and try again." });
      if (!hasAccess(req)) return send(res, 401, LOCKED);
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "That request couldn't be read." });
      }
      if (route === "POST /api/me") {
        if (!validToken(body.voter)) return send(res, 400, { error: "Invalid voter ID." });
        return send(res, 200, { id: publicId(body.voter), open });
      }
      if (!open) return send(res, 403, { error: "Voting is closed. You can still see the results." });
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

    /* ---------- organizer ---------- */
    if (url.pathname.startsWith("/api/admin/") || route === "GET /api/export.csv" || route === "POST /api/reset" || route === "POST /api/state") {
      if (limited(req, loginHits, LOGIN_PER_MIN)) return send(res, 429, { error: "Too many attempts. Wait a minute and try again." });
      if (!isAdmin(req)) return send(res, 403, { error: "Admin key required." });
    }

    if (route === "GET /api/admin/check") return send(res, 200, { ok: true, open });

    if (route === "POST /api/state") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "That request couldn't be read." });
      }
      if (typeof body.open !== "boolean") return send(res, 400, { error: "Say whether voting should be open." });
      open = body.open;
      saveState();
      broadcast("state", { open });
      return send(res, 200, { open });
    }

    if (route === "GET /api/export.csv") {
      // One row per response, plus a 1/0 column per use case so it pivots easily in Excel.
      const rows = [["submitted_at", "line_of_business", "firm_type", "picks", "spent", ...CODES]];
      const sorted = [...votes.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      for (const v of sorted) {
        rows.push([
          v.at,
          LOB_NAMES[v.lob] || "",
          TYPE_NAMES[v.type] || v.type,
          v.picks.join(" "),
          spentOf(v.picks),
          ...CODES.map((c) => (v.picks.includes(c) ? 1 : 0)),
        ]);
      }
      // The byte-order mark makes Excel read the file as UTF-8.
      const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
      return send(res, 200, csv, "text/csv; charset=utf-8", {
        "Content-Disposition": 'attachment; filename="lineup-responses.csv"',
      });
    }

    if (route === "POST /api/reset") {
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
  console.log(
    `Survey on http://localhost:${PORT}  (${votes.size} responses loaded, voting ${open ? "open" : "closed"}, admin ${ADMIN_KEY ? "on" : "off"})`
  );
});
