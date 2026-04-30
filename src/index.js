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
} = require("./auth");
const { createTorrentService } = require("./torrent");
const { renderLogin, renderDashboard, renderKeyDetails } = require("./views");
const { createAddonInterface, validateAddonKey } = require("./stremio");
const { createBitmagnetService } = require("./bitmagnet");
const { getStatusVideoPath } = require("./status-video");
const { is4kRelease } = require("./classify");

const config = getConfig();
const db = openDatabase(config);
const torrentService = createTorrentService(config);
const bitmagnet = createBitmagnetService(config);
const addonInterface = createAddonInterface({ db, config, bitmagnet, torrentService });
const app = express();
const activeStreamsByKey = new Map();
const STREAM_TRACKER_SWEEP_MS = config.streamTrackerSweepMs;
const STREAM_TRACKER_STALE_MS = config.streamTrackerStaleMs;
let nextTrackedConnectionId = 1;

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

function getPlaybackEntry(keyToken, playbackToken) {
  const key = String(keyToken || "");
  const playback = String(playbackToken || "");
  const streams = activeStreamsByKey.get(key);
  if (!streams) {
    return null;
  }
  const entry = streams.get(playback);
  if (!entry) {
    return null;
  }
  if (typeof entry === "number") {
    const normalized = {
      connections: new Map(),
      sweepTimer: null,
    };
    streams.set(playback, normalized);
    return normalized;
  }
  if (!(entry.connections instanceof Map)) {
    entry.connections = new Map();
  }
  return entry;
}

function clearTrackedStreamTimer(entry) {
  if (entry?.sweepTimer) {
    clearInterval(entry.sweepTimer);
    entry.sweepTimer = null;
  }
}

function isTrackedStreamClosed(connection) {
  const req = connection?.req;
  const res = connection?.res;
  return Boolean(
    req?.aborted ||
      req?.destroyed ||
      res?.destroyed ||
      res?.writableEnded ||
      res?.closed ||
      res?.socket?.destroyed,
  );
}

function touchTrackedStream(connection) {
  const reqSocket = connection?.req?.socket;
  const resSocket = connection?.res?.socket;
  const nextBytesRead = reqSocket?.bytesRead || 0;
  const nextBytesWritten = resSocket?.bytesWritten || 0;
  if (nextBytesRead !== connection.lastBytesRead || nextBytesWritten !== connection.lastBytesWritten) {
    connection.lastActivityAt = Date.now();
    connection.lastBytesRead = nextBytesRead;
    connection.lastBytesWritten = nextBytesWritten;
  }
}

function pruneTrackedPlaybackEntry(streams, keyToken, playbackToken) {
  const entry = getPlaybackEntry(keyToken, playbackToken);
  if (!entry) {
    return false;
  }

  const now = Date.now();
  for (const [connectionId, connection] of entry.connections.entries()) {
    touchTrackedStream(connection);
    const stale = now - connection.lastActivityAt > STREAM_TRACKER_STALE_MS;
    if (stale) {
      if (connection.res && !connection.res.destroyed) {
        console.log(`[play] closing stale connection key=${keyToken} playback=${playbackToken} id=${connectionId}`);
        connection.res.destroy();
      }
      entry.connections.delete(connectionId);
    } else if (isTrackedStreamClosed(connection)) {
      entry.connections.delete(connectionId);
    }
  }

  const expired = !verifyPlaybackToken(playbackToken, config.sessionSecret);
  if (expired || entry.connections.size === 0) {
    clearTrackedStreamTimer(entry);
    streams.delete(playbackToken);
    return false;
  }

  return true;
}

function pruneTrackedStreams(keyToken) {
  const key = String(keyToken || "");
  const streams = activeStreamsByKey.get(key);
  if (!streams) {
    return;
  }

  for (const [playback] of streams.entries()) {
    pruneTrackedPlaybackEntry(streams, key, playback);
  }

  if (streams.size === 0) {
    activeStreamsByKey.delete(key);
  }
}

function getActiveStreamCount(keyToken) {
  pruneTrackedStreams(keyToken);
  const streams = activeStreamsByKey.get(String(keyToken || ""));
  return streams ? streams.size : 0;
}

function getActivePlaybackHashes(keyToken) {
  pruneTrackedStreams(keyToken);
  const streams = activeStreamsByKey.get(String(keyToken || ""));
  if (!streams) return [];
  return Array.from(streams.keys()).map(hashPlaybackToken);
}

function beginTrackedStream(keyToken, playbackToken, req, res) {
  const key = String(keyToken || "");
  const playback = String(playbackToken || "");
  const streams = activeStreamsByKey.get(key) || new Map();
  const existingEntry = getPlaybackEntry(key, playback);
  const entry = existingEntry || {
    connections: new Map(),
    sweepTimer: null,
  };
  const connectionId = nextTrackedConnectionId++;
  const connection = {
    req,
    res,
    startedAt: Date.now(),
    initialBytesRead: req?.socket?.bytesRead || 0,
    initialBytesWritten: res?.socket?.bytesWritten || 0,
    lastActivityAt: Date.now(),
    lastBytesRead: req?.socket?.bytesRead || 0,
    lastBytesWritten: res?.socket?.bytesWritten || 0,
  };
  touchTrackedStream(connection);
  entry.connections.set(connectionId, connection);
  streams.set(playback, entry);
  activeStreamsByKey.set(key, streams);

  if (!entry.sweepTimer) {
    entry.sweepTimer = setInterval(() => {
      const currentStreams = activeStreamsByKey.get(key);
      if (!currentStreams) {
        return;
      }
      const stillTracked = pruneTrackedPlaybackEntry(currentStreams, key, playback);
      if (!stillTracked && currentStreams.size === 0) {
        activeStreamsByKey.delete(key);
      }
    }, STREAM_TRACKER_SWEEP_MS);
    if (typeof entry.sweepTimer.unref === "function") {
      entry.sweepTimer.unref();
    }
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseTrackedStream(key, playback, connectionId);
  };
}

function isPlaybackTracked(keyToken, playbackToken) {
  pruneTrackedStreams(keyToken);
  const key = String(keyToken || "");
  const playback = String(playbackToken || "");
  return activeStreamsByKey.get(key)?.has(playback) || false;
}

function releaseTrackedStream(keyToken, playbackToken, connectionId) {
  const key = String(keyToken || "");
  const playback = String(playbackToken || "");
  const currentStreams = activeStreamsByKey.get(key);
  if (!currentStreams) {
    return;
  }

  const entry = getPlaybackEntry(key, playback);
  if (!entry) {
    return;
  }

  if (connectionId !== undefined) {
    entry.connections.delete(connectionId);
  }

  if (entry.connections.size === 0) {
    clearTrackedStreamTimer(entry);
    currentStreams.delete(playback);
  } else {
    currentStreams.set(playback, entry);
  }

  if (currentStreams.size === 0) {
    activeStreamsByKey.delete(key);
  }
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

function sendBlockedPlaybackVideo(req, res, key, reason) {
  const filePath = getStatusVideoPath(config, {
    kind: reason,
    keyName: key.name,
    limit: key.max_concurrent_streams,
  });
  sendVideoFile(req, res, filePath);
}

function streamIs4k(stream) {
  return is4kRelease(stream);
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
  if (!verifySession(cookies.admin_session, config.sessionSecret)) {
    res.status(401).send(renderLogin("Admin session required."));
    return;
  }
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
    .map((key) => ({
      ...key,
      activeStreams: getActiveStreamCount(key.token),
    }))
    .sort((a, b) => {
      const aActive = a.activeStreams > 0;
      const bActive = b.activeStreams > 0;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;

            const aTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      const bTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;

            return b.id - a.id;
    });

  const totalActiveStreams = activeKeys.reduce((acc, key) => acc + key.activeStreams, 0);

  res.send(
    renderDashboard({
      baseUrl: getBaseUrl(req),
      activeKeys,
      totalActiveStreams,
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
      activeStreams: getActiveStreamCount(key.token),
      activePlaybackHashes: getActivePlaybackHashes(key.token),
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
    activeStreams: getActiveStreamCount(key.token),
    activePlaybackHashes: getActivePlaybackHashes(key.token),
    paused: Boolean(key.paused_at),
    allow4k: Boolean(key.allow_4_k),
    maxConcurrentStreams: key.max_concurrent_streams,
    watchHistory,
  });
});

app.get("/admin/api/status", requireAdmin, async (req, res) => {
  const activeKeys = db.getActiveKeys()
    .map((key) => ({
      id: key.id,
      activeStreams: getActiveStreamCount(key.token),
      paused: Boolean(key.paused_at),
      last_active_at: key.last_active_at,
    }))
    .sort((a, b) => {
      const aActive = a.activeStreams > 0;
      const bActive = b.activeStreams > 0;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;

            const aTime = a.last_active_at || "";
      const bTime = b.last_active_at || "";
      if (aTime !== bTime) return bTime < aTime ? -1 : 1;

            return b.id - a.id;
    });

  const totalActiveStreams = activeKeys.reduce((acc, key) => acc + key.activeStreams, 0);

  res.json({
    bitmagnet: await bitmagnet.getStatus(),
    totalActiveStreams,
    activeKeys,
  });
});

app.get("/admin", (req, res) => {
  const cookies = parseCookies(req);
  if (!verifySession(cookies.admin_session, config.sessionSecret)) {
    res.send(renderLogin(""));
    return;
  }
  renderAdmin(req, res);
});

app.post("/admin/login", (req, res) => {
  const provided = String(req.body.password || "");
  if (hashPassword(provided) !== hashPassword(config.adminPassword)) {
    res.status(401).send(renderLogin("Invalid password."));
    return;
  }

  const session = issueSession(config.sessionSecret, config.sessionTtlMs);
  setCookie(res, "admin_session", session, { maxAge: config.sessionTtlMs });
  res.redirect("/admin");
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  clearCookie(res, "admin_session");
  res.redirect("/admin");
});

app.post("/admin/keys", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim() || "Untitled Key";
  db.createAddonKey(name, generateOpaqueToken(), 1, false);
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

app.post("/admin/keys/:id/settings", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);
  const maxConcurrentStreams = Number(req.body.maxConcurrentStreams);

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  if (!Number.isInteger(maxConcurrentStreams) || maxConcurrentStreams < 1) {
    const historyLimit = getWatchHistoryLimit(req);
    const watchHistory = db.getWatchHistoryForKey(key.id, historyLimit + 1);

    res.status(400).send(
      renderKeyDetails({
        baseUrl: getBaseUrl(req),
        key,
        activeStreams: getActiveStreamCount(key.token),
        watchHistory: watchHistory.slice(0, historyLimit),
        watchHistoryHasMore: watchHistory.length > historyLimit,
        watchHistoryLimit: historyLimit,
        watchHistoryStep: WATCH_HISTORY_LIMIT_STEP,
        message: "Concurrency limit must be a whole number of at least 1.",
        timezone: config.timezone,
      }),
    );
    return;
  }

  db.updateKeyLimit(keyId, maxConcurrentStreams);
  res.redirect(`/admin/keys/${keyId}?msg=${encodeURIComponent("Key settings updated.")}`);
});

app.post("/admin/keys/:id/4k-access", requireAdmin, (req, res) => {
  const keyId = Number(req.params.id);
  const key = db.getKeyById(keyId);

  if (!key || key.revoked_at) {
    redirectToAdmin(res, "Key not found.");
    return;
  }

  const allow4k = req.body.allow4k === "true";
  db.updateKey4kAccess(keyId, allow4k);
  res.redirect(`/admin/keys/${keyId}?msg=${encodeURIComponent("4K access updated.")}`);
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
        allow4k: key.allow_4k,
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
      sendBlockedPlaybackVideo(req, res, key, "paused");
      return;
    }

    if (!key.allow_4k && streamIs4k(payload.stream)) {
      console.error(`[play] 4k blocked key=${JSON.stringify(key.name)} ip=${JSON.stringify(req.ip)}`);
      sendBlockedPlaybackVideo(req, res, key, "4k");
      return;
    }

    const activeStreamCount = getActiveStreamCount(key.token);
    if (!isPlaybackTracked(key.token, req.params.token) && activeStreamCount >= key.max_concurrent_streams) {
      console.error(
        `[play] concurrency blocked key=${JSON.stringify(key.name)} active=${activeStreamCount} limit=${key.max_concurrent_streams} ip=${JSON.stringify(req.ip)}`,
      );
      sendBlockedPlaybackVideo(req, res, key, "limit");
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

    const releaseTrackedStream = beginTrackedStream(key.token, req.params.token, req, res);
    req.on("aborted", releaseTrackedStream);
    req.on("close", releaseTrackedStream);
    res.on("close", releaseTrackedStream);
    res.on("finish", releaseTrackedStream);
    res.on("error", releaseTrackedStream);

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
      sendBlockedPlaybackVideo(req, res, key, "paused");
      return;
    }

    if (!key.allow_4k && streamIs4k(payload.stream)) {
      sendBlockedPlaybackVideo(req, res, key, "4k");
      return;
    }

    const activeStreamCount = getActiveStreamCount(key.token);
    if (!isPlaybackTracked(key.token, req.params.token) && activeStreamCount >= key.max_concurrent_streams) {
      sendBlockedPlaybackVideo(req, res, key, "limit");
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
app.listen(port, () => {
  const warning =
    config.adminPassword === "change-me-now"
      ? "WARNING: ADMIN_PASSWORD is still the default value."
      : "Admin password configured.";
  console.log(`Bitlab listening on http://localhost:${port}`);
  console.log(warning);
});
