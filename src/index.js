const crypto = require("node:crypto");
const fs = require("node:fs");
const express = require("express");
const { getConfig } = require("./config");
const { openDatabase } = require("./db");
const {
  issueSession,
  verifySession,
  verifyPlaybackToken,
  hashPassword,
  generateOpaqueToken,
  timingSafeCompare,
} = require("./auth");
const { createTorrentService } = require("./torrent");
const { renderLogin, renderDashboard, renderKeyDetails, renderSessions } = require("./views");
const { createAddonInterface, validateAddonKey } = require("./stremio");
const { createBitmagnetService } = require("./bitmagnet");
const { getStatusVideoPath } = require("./status-video");
const { getPostgresStats } = require("./postgres");

const config = getConfig();
const db = openDatabase(config);
const torrentService = createTorrentService(config);
const bitmagnet = createBitmagnetService(config);
const addonInterface = createAddonInterface({ db, config, bitmagnet, torrentService });
const app = express();


const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function runWatchHistoryCleanup() {
  try {
    const result = db.deleteOldWatchHistory();
    if (result.changes > 0) {
      console.log(`[cleanup] Removed ${result.changes} watch history entries older than 30 days`);
    }
  } catch (error) {
    console.error(`[cleanup] Failed to delete old watch history: ${error.message}`);
  }
}

runWatchHistoryCleanup();
setInterval(runWatchHistoryCleanup, ONE_DAY_MS);

function hashPlaybackToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const [startString, endString] = rangeHeader.slice(6).split("-");
  const start = Number(startString);
  const end = endString ? Number(endString) : totalSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= totalSize) {
    return null;
  }

  return { start, end };
}

function sendVideoFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const range = parseRange(req.headers.range, stat.size);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=60");

  if (req.method === "HEAD") {
    res.setHeader("Content-Length", stat.size);
    res.status(200).end();
    return;
  }

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.status(206);
  res.setHeader("Content-Length", range.end - range.start + 1);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
}

function sendBlockedPlaybackVideo(req, res, key) {
  const filePath = getStatusVideoPath(config, {
    kind: "paused",
    keyName: key.name,
  });
  sendVideoFile(req, res, filePath);
}



app.set("trust proxy", true);
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const requestBaseUrl = `${protocol}://${req.get("host")}`;

  if (config.baseUrl) {
    try {
      const configured = new URL(config.baseUrl);
      const requestUrl = new URL(requestBaseUrl);
      const configuredHost = configured.hostname.toLowerCase();
      const requestHost = requestUrl.hostname.toLowerCase();
      const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
      if (!(loopbackHosts.has(configuredHost) && !loopbackHosts.has(requestHost))) {
        return config.baseUrl.replace(/\/$/, "");
      }
    } catch (_error) {
      return config.baseUrl.replace(/\/$/, "");
    }
  }
  return requestBaseUrl;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
      }),
  );
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  parts.push("Path=/");
  if (options.maxAge) {
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }
  parts.push("SameSite=Lax");
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token || !verifySession(token, config.sessionSecret)) {
    res.status(401).send(renderLogin("Admin session required."));
    return;
  }

  const dbSession = db.getSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.status(401).send(renderLogin("Session has been revoked or is invalid."));
    return;
  }

  db.updateSessionLastActive(token);
  next();
}

function adminMessage(req) {
  return typeof req.query.msg === "string" ? req.query.msg : "";
}

function redirectToAdmin(res, message = "") {
  const suffix = message ? `?msg=${encodeURIComponent(message)}` : "";
  res.redirect(`/admin${suffix}`);
}

const DEFAULT_WATCH_HISTORY_LIMIT = 5;
const WATCH_HISTORY_LIMIT_STEP = 10;
const MAX_WATCH_HISTORY_LIMIT = 250;

function getWatchHistoryLimit(req) {
  const requested = Number(req.query.historyLimit);
  if (!Number.isInteger(requested) || requested < 1) {
    return DEFAULT_WATCH_HISTORY_LIMIT;
  }

  return Math.min(requested, MAX_WATCH_HISTORY_LIMIT);
}

function renderAdmin(req, res, message = "") {
  const activeKeys = db.getActiveKeys()
    .sort((a, b) => {
      const aTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      const bTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return b.id - a.id;
    });

  res.send(
    renderDashboard({
      baseUrl: getBaseUrl(req),
      activeKeys,
      bitmagnetStatus: { ok: null },
      message: message || adminMessage(req),
    }),
  );
}

async function renderKeyAdmin(req, res, key, message = "") {
  const historyLimit = getWatchHistoryLimit(req);
  const watchHistory = db.getWatchHistoryForKey(key.id, historyLimit + 1);

  res.send(
    renderKeyDetails({
      baseUrl: getBaseUrl(req),
      key,
      watchHistory: watchHistory.slice(0, historyLimit),
      watchHistoryHasMore: watchHistory.length > historyLimit,
      watchHistoryLimit: historyLimit,
      watchHistoryStep: WATCH_HISTORY_LIMIT_STEP,
      message: message || adminMessage(req),
      timezone: config.timezone,
    }),
  );
}

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.get("/admin/api/keys/:id", requireAdmin, async (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);
  if (!key || key.revoked_at) {
    res.status(404).json({ err: "Key not found" });
    return;
  }

  const historyLimit = getWatchHistoryLimit(req);
  const watchHistory = db.getWatchHistoryForKey(key.id, historyLimit);

  res.json({
    paused: Boolean(key.paused_at),
    paused_at: key.paused_at,
    watchHistory,
  });
});

app.get("/admin/api/status", requireAdmin, async (req, res) => {
  const activeKeys = db.getActiveKeys()
    .map((key) => ({
      id: key.id,
      paused: Boolean(key.paused_at),
      last_active_at: key.last_active_at,
    }))
    .sort((a, b) => {
      const aTime = a.last_active_at || "";
      const bTime = b.last_active_at || "";
      if (aTime !== bTime) return bTime < aTime ? -1 : 1;
      return b.id - a.id;
    });

  const postgresStats = await getPostgresStats(config);

  res.json({
    bitmagnet: await bitmagnet.getStatus(),
    activeKeys,
    postgres: postgresStats,
  });
});

async function proxyToBitmagnet(req, res, targetPath) {
  const { Readable } = require("node:stream");
  const targetUrl = new URL(targetPath, "http://localhost:3333");

  try {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];

    let body = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.body && Object.keys(req.body).length > 0) {
        if (req.is("json")) {
          body = JSON.stringify(req.body);
        } else if (req.is("application/x-www-form-urlencoded")) {
          body = new URLSearchParams(req.body).toString();
        } else {
          body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        }
      }
    }

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      let html = await response.text();
      // Dynamically align the base href to the proxy's current request path
      const baseHref = req.path.endsWith("/") ? req.path : `${req.path}/`;
      html = html.replace(/<base href="[^"]*"/, `<base href="${baseHref}"`);

      res.status(response.status);
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "location") {
          const rewritten = value.startsWith("/") ? `/admin/bitmagnet${value}` : value;
          res.setHeader(key, rewritten);
        } else if (
          lowerKey !== "content-encoding" &&
          lowerKey !== "content-length"
        ) {
          res.setHeader(key, value);
        }
      });
      res.send(html);
    } else {
      res.status(response.status);
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "location") {
          const rewritten = value.startsWith("/") ? `/admin/bitmagnet${value}` : value;
          res.setHeader(key, rewritten);
        } else if (lowerKey !== "content-encoding") {
          res.setHeader(key, value);
        }
      });

      if (response.body) {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end();
      }
    }
  } catch (error) {
    console.error(`[bitmagnet-proxy] Error proxying ${req.method} ${req.originalUrl}:`, error);
    res.status(502).send("Bad Gateway: Error proxying request to bitmagnet");
  }
}

app.all("/admin/bitmagnet{/*splat}", requireAdmin, async (req, res) => {
  if (req.path === "/admin/bitmagnet") {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
      : "";
    return res.redirect(`/admin/bitmagnet/${query}`);
  }
  const proxiedPath = req.originalUrl.replace(/^\/admin\/bitmagnet/, "") || "/";
  proxyToBitmagnet(req, res, proxiedPath);
});

app.all("/graphql", requireAdmin, async (req, res) => {
  proxyToBitmagnet(req, res, req.originalUrl);
});

app.all("/api/*splat", requireAdmin, async (req, res) => {
  proxyToBitmagnet(req, res, req.originalUrl);
});

app.get("/admin", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token || !verifySession(token, config.sessionSecret)) {
    res.send(renderLogin(""));
    return;
  }

  const dbSession = db.getSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.send(renderLogin("Session has been revoked."));
    return;
  }

  db.updateSessionLastActive(token);
  renderAdmin(req, res);
});

function getSessionName(req) {
  const ua = req.headers["user-agent"] || "";
  
  // Basic user agent parsing
  let browser = "Unknown Browser";
  if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/")) browser = "Safari";
  else if (ua.includes("Edge/")) browser = "Edge";
  else if (ua.includes("Opera/") || ua.includes("OPR/")) browser = "Opera";

  let os = "Unknown OS";
  if (ua.includes("Windows NT")) os = "Windows";
  else if (ua.includes("Macintosh") || ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  return `${browser} on ${os}`;
}

app.post("/admin/login", async (req, res) => {
  const provided = String(req.body.password || "");
  if (!timingSafeCompare(hashPassword(provided), hashPassword(config.adminPassword))) {
    res.status(401).send(renderLogin("Invalid password."));
    return;
  }

  const session = issueSession(config.sessionSecret, config.sessionTtlMs);
  const userAgent = req.headers["user-agent"] || "Unknown User Agent";
  const ipAddress = req.ip || req.socket.remoteAddress || "Unknown IP";
  const name = getSessionName(req);

  db.createSession(session, name, userAgent, ipAddress);

  setCookie(res, "admin_session", session, { maxAge: config.sessionTtlMs });
  res.redirect("/admin");
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (token) {
    const dbSession = db.getSessionByToken(token);
    if (dbSession) {
      db.revokeSession(dbSession.id);
    }
  }
  clearCookie(res, "admin_session");
  res.redirect("/admin");
});

app.get("/admin/sessions", requireAdmin, (req, res) => {
  const cookies = parseCookies(req);
  const currentSessionToken = cookies.admin_session;
  const sessions = db.getActiveSessions();

  res.send(
    renderSessions({
      sessions,
      currentSessionToken,
      timezone: config.timezone,
      message: adminMessage(req),
    })
  );
});

app.post("/admin/sessions/:id/rename", requireAdmin, (req, res) => {
  const sessionId = Number(req.params.id);
  const session = db.getSessionById(sessionId);

  if (!session || session.revoked_at) {
    res.redirect(`/admin/sessions?msg=${encodeURIComponent("Session not found.")}`);
    return;
  }

  const name = String(req.body.name || "").trim() || "Untitled Session";
  db.renameSession(sessionId, name);
  res.redirect(`/admin/sessions?msg=${encodeURIComponent("Session renamed successfully.")}`);
});

app.post("/admin/sessions/:id/revoke", requireAdmin, (req, res) => {
  const sessionId = Number(req.params.id);
  const session = db.getSessionById(sessionId);

  if (!session || session.revoked_at) {
    res.redirect(`/admin/sessions?msg=${encodeURIComponent("Session not found.")}`);
    return;
  }

  db.revokeSession(sessionId);

  const cookies = parseCookies(req);
  if (session.token === cookies.admin_session) {
    clearCookie(res, "admin_session");
    res.redirect("/admin");
    return;
  }

  res.redirect(`/admin/sessions?msg=${encodeURIComponent("Session revoked successfully.")}`);
});

app.post("/admin/keys", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim() || "Untitled Key";
  db.createAddonKey(name, generateOpaqueToken());
  redirectToAdmin(res, "Addon key created.");
});

app.get("/admin/keys/:id", requireAdmin, async (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  await renderKeyAdmin(req, res, key);
});

app.post("/admin/keys/:id/rename", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);
  const name = String(req.body.name || "").trim() || "Untitled Key";

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  db.renameKey(keyId, name);
  res.redirect(`/admin/keys/${keyId}?msg=${encodeURIComponent("Key renamed successfully.")}`);
});

app.post("/admin/keys/:id/pause", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  db.pauseKey(keyId);
  res.redirect(`/admin/keys/${keyId}?msg=${encodeURIComponent("Key paused.")}`);
});

app.post("/admin/keys/:id/resume", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  db.resumeKey(keyId);
  res.redirect(`/admin/keys/${keyId}?msg=${encodeURIComponent("Key resumed.")}`);
});

app.post("/admin/keys/:id/revoke", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);
  const confirmName = String(req.body.confirmName || "").trim();

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  if (confirmName !== key.name) {
    redirectToAdmin(res, `Revocation blocked. Type the exact key name: ${key.name}`);
    return;
  }

  db.revokeKey(keyId);
  redirectToAdmin(res, "Addon key revoked.");
});

app.get("/static/favicon.svg", (_req, res) => {
  res.type("image/svg+xml").send(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#171717"/>
      <path d="M10 8V16C10 19.3137 12.6863 22 16 22C19.3137 22 22 19.3137 22 16V8H18V16C18 17.1046 17.1046 18 16 18C14.8954 18 14 17.1046 14 16V8H10Z" fill="#7ea2ff"/>
      <rect x="10" y="8" width="4" height="3" fill="#f2f2f2"/>
      <rect x="18" y="8" width="4" height="3" fill="#f2f2f2"/>
    </svg>
  `);
});

app.get("/static/logo.svg", (_req, res) => {
  res.type("image/svg+xml").send(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="48" fill="#171717"/>
      <path d="M80 64V128C80 154.51 101.49 176 128 176C154.51 176 176 154.51 176 128V64H144V128C144 136.837 136.837 144 128 144C119.163 144 112 136.837 112 128V64H80Z" fill="#7ea2ff"/>
      <rect x="80" y="64" width="32" height="24" fill="#f2f2f2"/>
      <rect x="144" y="64" width="32" height="24" fill="#f2f2f2"/>
    </svg>
  `);
});

app.get("/static/background.svg", (_req, res) => {
  res.type("image/svg+xml").send(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
      <defs>
        <linearGradient id="a" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="#101010" offset="0"/>
          <stop stop-color="#171717" offset="1"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#a)"/>
      <circle cx="1250" cy="180" r="220" fill="rgba(126,162,255,0.08)"/>
      <circle cx="350" cy="700" r="260" fill="rgba(242,242,242,0.03)"/>
    </svg>
  `);
});

app.get("/:key/manifest.json", (req, res) => {
  const key = validateAddonKey(db, req.params.key);
  if (!key) {
    res.status(403).json({ err: "Invalid addon key." });
    return;
  }
  res.json(addonInterface.manifest);
});

async function handleAddonResource(req, res, resource, extraFromPath = false) {
  const key = validateAddonKey(db, req.params.key);
  if (!key) {
    res.status(403).json({ err: "Invalid addon key." });
    return;
  }

  const extra = { ...req.query };
  if (extraFromPath && req.params.extra) {
    for (const [rawKey, rawValue] of new URLSearchParams(req.params.extra)) {
      extra[rawKey] = rawValue;
    }
  }

  try {
    console.log(`[addon] ${resource} ${req.params.type} id=${req.params.id} query=${JSON.stringify(req.query)}`);
    const response = await addonInterface.get(
      resource,
      req.params.type,
      req.params.id,
      extra,
      {
        baseUrl: getBaseUrl(req),
        keyToken: key.token,
      },
    );
    if (resource === "stream") {
      console.log(`[addon] stream result count=${Array.isArray(response.streams) ? response.streams.length : 0}`);
    } else if (resource === "meta") {
      console.log(`[addon] meta found=${Boolean(response.meta)}`);
    }
    res.json(response);
  } catch (error) {
    console.error(`[addon] ${resource} error: ${error.message}`);
    res.status(500).json({ err: error.message || "handler error" });
  }
}

app.get("/:key/meta/:type/:id.json", (req, res) => handleAddonResource(req, res, "meta", false));
app.get("/:key/meta/:type/:id/:extra.json", (req, res) => handleAddonResource(req, res, "meta", true));
app.get("/:key/stream/:type/:id.json", (req, res) => handleAddonResource(req, res, "stream", false));
app.get("/:key/stream/:type/:id/:extra.json", (req, res) => handleAddonResource(req, res, "stream", true));

app.get("/play/:token", async (req, res) => {
  try {
    const payload = verifyPlaybackToken(req.params.token, config.sessionSecret);
    if (!payload) {
      console.error(`[play] invalid token ip=${req.ip}`);
      res.status(403).send("Invalid playback token.");
      return;
    }

    const key = db.getKeyByToken(payload.keyToken);
    if (!key || key.revoked_at) {
      console.error(`[play] inactive key ip=${req.ip}`);
      res.status(403).send("Addon key is no longer active.");
      return;
    }

    if (!payload.stream || !payload.stream.magnetUri) {
      console.error(`[play] missing stream payload key=${key.name} ip=${req.ip}`);
      res.status(404).send("Stream source not found.");
      return;
    }

    if (key.paused_at) {
      console.error(`[play] key paused key=${JSON.stringify(key.name)} ip=${JSON.stringify(req.ip)}`);
      sendBlockedPlaybackVideo(req, res, key);
      return;
    }

    const rawHashMatch = String(payload.stream.magnetUri).match(/btih:([a-zA-Z0-9]+)/i);
    const infoHash = rawHashMatch ? rawHashMatch[1].toLowerCase() : "";
    console.log(
      `[play] request method=${req.method} key=${JSON.stringify(key.name)} ip=${JSON.stringify(req.ip)} infoHash=${JSON.stringify(infoHash)} range=${JSON.stringify(req.headers.range || "")}`,
    );

    if (req.method === "HEAD") {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, max-age=60");
      console.log(`[play] head ok infoHash=${JSON.stringify(infoHash)}`);
      res.status(200).end();
      return;
    }

    db.logWatchHistory({
      keyId: key.id,
      playbackTokenHash: hashPlaybackToken(req.params.token),
      mediaType: payload.stream.mediaType,
      mediaTitle: payload.stream.mediaTitle || payload.stream.releaseName || "Unknown media",
      releaseName: payload.stream.releaseName,
      season: payload.stream.season,
      episode: payload.stream.episode,
      fileName: payload.stream.fileName,
      infoHash: payload.stream.infoHash || infoHash,
    });

    db.updateKeyLastActive(key.id);

    await torrentService.streamSource(payload.stream, req, res);
    console.log(`[play] stream finished infoHash=${JSON.stringify(infoHash)}`);
  } catch (error) {
    console.error(`[play] stream failed error=${JSON.stringify(error.message)}`);
    res.status(500).send(`Stream failed: ${error.message}`);
  }
});
app.head("/play/:token", async (req, res) => {
  try {
    const payload = verifyPlaybackToken(req.params.token, config.sessionSecret);
    if (!payload) {
      console.error(`[play] head invalid token ip=${req.ip}`);
      res.status(403).end();
      return;
    }

    const key = db.getKeyByToken(payload.keyToken);
    if (!key || key.revoked_at || !payload.stream || !payload.stream.magnetUri) {
      console.error(`[play] head missing stream or inactive key ip=${req.ip}`);
      res.status(404).end();
      return;
    }

    if (key.paused_at) {
      sendBlockedPlaybackVideo(req, res, key);
      return;
    }

    const rawHashMatch = String(payload.stream.magnetUri).match(/btih:([a-zA-Z0-9]+)/i);
    const infoHash = rawHashMatch ? rawHashMatch[1].toLowerCase() : "";
    console.log(
      `[play] head request key=${JSON.stringify(key.name)} ip=${JSON.stringify(req.ip)} infoHash=${JSON.stringify(infoHash)}`,
    );
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.status(200).end();
  } catch (_error) {
    res.status(500).end();
  }
});

app.get("/health", async (_req, res) => {
  const bitmagnetStatus = await bitmagnet.getStatus();
  res.json({
    ok: bitmagnetStatus.ok,
    dbPath: config.dbPath,
    keyCount: db.getActiveKeys().length,
    bitmagnet: bitmagnetStatus,
  });
});

const port = config.port;
const server = app.listen(port, () => {
  const warning =
    config.adminPassword === "change-me-now"
      ? "WARNING: ADMIN_PASSWORD is still the default value."
      : "Admin password configured.";
  console.log(`Bitlab listening on http://localhost:${port}`);
  console.log(warning);
});

server.timeout = 0;
server.keepAliveTimeout = 0;
server.requestTimeout = 0;
