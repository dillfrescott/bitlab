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
const {
  renderLogin,
  renderDashboard,
  renderUserDetails,
  renderSessions,
  renderUserLogin,
  renderUserDashboard,
} = require("./views");
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

function sendBlockedPlaybackVideo(req, res, key, reason, needed = 0, user = null) {
  const filePath = getStatusVideoPath(config, {
    kind: reason,
    keyName: key.name,
    limit: key.max_concurrent_streams,
    bandwidthUsed: user ? user.bandwidth_used : undefined,
    bandwidthLimit: user ? user.bandwidth_limit : undefined,
    bandwidthNeeded: needed,
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
    res.status(401).send(renderLogin("Admin session required.", config.nullcaptchaUrl));
    return;
  }

  const dbSession = db.getSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.status(401).send(renderLogin("Session has been revoked or is invalid.", config.nullcaptchaUrl));
    return;
  }

  db.updateSessionLastActive(token);
  next();
}

function requireUser(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.user_session;
  if (!token || !verifySession(token, config.sessionSecret)) {
    res.status(401).send(renderUserLogin("User session required.", config.nullcaptchaUrl));
    return;
  }

  const dbSession = db.getUserSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.status(401).send(renderUserLogin("Session has been revoked or is invalid.", config.nullcaptchaUrl));
    return;
  }

  const user = db.getUserById(dbSession.user_id);
  if (!user) {
    res.status(401).send(renderUserLogin("User no longer exists.", config.nullcaptchaUrl));
    return;
  }

  if (user.is_suspended) {
    res.status(401).send(renderUserLogin("Your account has been suspended.", config.nullcaptchaUrl));
    return;
  }

  db.updateUserSessionLastActive(token);
  req.user = user;
  next();
}

async function verifyNullCaptcha(req) {
  if (config.nullcaptchaUrl) {
    const nullcaptchaResponse = req.body["nullcaptcha-response"] || req.body["nullcaptcha-response"] || "";

    try {
      const verifyUrl = `${config.nullcaptchaUrl.replace(/\/$/, "")}/api/validate`;
      const verifyResponse = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: nullcaptchaResponse,
        }),
      });
      const data = await verifyResponse.json();
      return !!data.success;
    } catch (error) {
      console.error("[nullcaptcha] Verification failed with error:", error);
      return false;
    }
  }
  return true;
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
  const users = db.getAllUsers()
    .map((user) => {
      const keys = db.getUserKeys(user.id);
      let activeStreams = 0;
      for (const k of keys) {
        activeStreams += getActiveStreamCount(k.token);
      }
      return {
        ...user,
        activeStreams,
        keysCount: keys.length,
      };
    })
    .sort((a, b) => {
      const aActive = a.activeStreams > 0;
      const bActive = b.activeStreams > 0;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;

      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bTime - aTime;
    });

  const totalActiveStreams = users.reduce((acc, u) => acc + u.activeStreams, 0);

  res.send(
    renderDashboard({
      baseUrl: getBaseUrl(req),
      users,
      totalActiveStreams,
      bitmagnetStatus: { ok: null },
      message: message || adminMessage(req),
    }),
  );
}

async function renderUserAdmin(req, res, user, message = "") {
  const keys = db.getUserKeys(user.id);
  const historyLimit = getWatchHistoryLimit(req);
  const watchHistory = db.getWatchHistoryForUser(user.id, historyLimit + 1);

  let activeStreams = 0;
  let activePlaybackHashes = [];
  for (const k of keys) {
    activeStreams += getActiveStreamCount(k.token);
    activePlaybackHashes.push(...getActivePlaybackHashes(k.token));
  }

  res.send(
    renderUserDetails({
      baseUrl: getBaseUrl(req),
      user,
      keys,
      activeStreams,
      activePlaybackHashes,
      watchHistory: watchHistory.slice(0, historyLimit),
      watchHistoryHasMore: watchHistory.length > historyLimit,
      watchHistoryLimit: historyLimit,
      watchHistoryStep: WATCH_HISTORY_LIMIT_STEP,
      message: message || adminMessage(req),
      timezone: config.timezone,
    }),
  );
}

// --- USER MAIN DOMAIN ROUTING ---
app.get("/", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.user_session;
  if (!token || !verifySession(token, config.sessionSecret)) {
    res.send(renderUserLogin("", config.nullcaptchaUrl));
    return;
  }

  const dbSession = db.getUserSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.send(renderUserLogin("Session has been revoked.", config.nullcaptchaUrl));
    return;
  }

  const user = db.getUserById(dbSession.user_id);
  if (!user || user.is_suspended) {
    res.send(renderUserLogin("User account suspended or invalid.", config.nullcaptchaUrl));
    return;
  }

  db.updateUserSessionLastActive(token);
  
  const keys = db.getUserKeys(user.id);
  const keysWithStatus = keys.map(k => {
    const activeHashes = getActivePlaybackHashes(k.token);
    let activeStreamTitle = null;
    if (activeHashes.length > 0) {
      // Find latest watch history entry for this key
      const latestHistory = db.getWatchHistoryForKey(k.id, 5);
      const activeEntry = latestHistory.find(h => activeHashes.includes(h.playback_token_hash));
      if (activeEntry) {
        const episodeLabel = Number.isInteger(activeEntry.season) && Number.isInteger(activeEntry.episode)
          ? `S${String(activeEntry.season).padStart(2, "0")}E${String(activeEntry.episode).padStart(2, "0")}`
          : "";
        activeStreamTitle = activeEntry.media_title + (episodeLabel ? ` (${episodeLabel})` : "");
      } else {
        activeStreamTitle = "Active Stream";
      }
    }
    const watchHistory = db.getWatchHistoryForKey(k.id, 10);
    return {
      ...k,
      activeStreamCount: activeHashes.length,
      activeStreamTitle,
      watchHistory
    };
  });

  const sessions = db.getActiveUserSessions(user.id);
  const tab = req.query.tab || "dashboard";
  res.send(renderUserDashboard({
    baseUrl: getBaseUrl(req),
    user,
    keys: keysWithStatus,
    sessions,
    currentSessionToken: token,
    message: req.query.msg || "",
    activeTab: tab,
    timezone: config.timezone,
  }));
});

app.post("/login", async (req, res) => {
  const isHuman = await verifyNullCaptcha(req);
  if (!isHuman) {
    res.status(400).send(renderUserLogin("Null CAPTCHA verification failed. Please try again.", config.nullcaptchaUrl));
    return;
  }

  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const user = db.getUserByUsername(username);
  if (!user) {
    res.status(401).send(renderUserLogin("Invalid username or password.", config.nullcaptchaUrl));
    return;
  }

  if (user.is_suspended) {
    res.status(401).send(renderUserLogin("Your account has been suspended.", config.nullcaptchaUrl));
    return;
  }

  if (!timingSafeCompare(hashPassword(password), user.password_hash)) {
    res.status(401).send(renderUserLogin("Invalid username or password.", config.nullcaptchaUrl));
    return;
  }

  const session = issueSession(config.sessionSecret, config.sessionTtlMs);
  const userAgent = req.headers["user-agent"] || "Unknown User Agent";
  const ipAddress = req.ip || req.socket.remoteAddress || "Unknown IP";
  const name = getSessionName(req);

  db.createUserSession(session, user.id, name, userAgent, ipAddress);

  setCookie(res, "user_session", session, { maxAge: config.sessionTtlMs });
  res.redirect("/");
});

app.post("/logout", requireUser, (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.user_session;
  if (token) {
    const dbSession = db.getUserSessionByToken(token);
    if (dbSession) {
      db.revokeUserSession(dbSession.id);
    }
  }
  clearCookie(res, "user_session");
  res.redirect("/");
});

app.post("/user/keys", requireUser, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    res.redirect("/?msg=" + encodeURIComponent("Key name is required."));
    return;
  }

  const keys = db.getUserKeys(req.user.id);
  if (keys.length >= (req.user.max_keys || 5)) {
    res.redirect("/?msg=" + encodeURIComponent("Key limit reached. Revoke an existing key first."));
    return;
  }

  db.createUserKey(req.user.id, name);
  res.redirect("/?msg=" + encodeURIComponent(`Key "${name}" created successfully.`));
});

app.post("/user/keys/:id/toggle-pause", requireUser, (req, res) => {
  const keyId = Number(req.params.id);
  const keys = db.getUserKeys(req.user.id);
  const key = keys.find(k => k.id === keyId);
  if (!key) {
    res.redirect("/?msg=" + encodeURIComponent("Key not found."));
    return;
  }

  if (key.paused_at) {
    db.resumeUserKey(keyId, req.user.id);
    res.redirect("/?msg=" + encodeURIComponent(`Key "${key.name}" resumed successfully.`));
  } else {
    db.pauseUserKey(keyId, req.user.id);
    res.redirect("/?msg=" + encodeURIComponent(`Key "${key.name}" frozen successfully.`));
  }
});

app.post("/user/keys/:id/revoke", requireUser, (req, res) => {
  const keyId = Number(req.params.id);
  const keys = db.getUserKeys(req.user.id);
  const key = keys.find(k => k.id === keyId);
  if (!key) {
    res.redirect("/?msg=" + encodeURIComponent("Key not found."));
    return;
  }

  db.revokeUserKey(keyId, req.user.id);
  res.redirect("/?msg=" + encodeURIComponent(`Key "${key.name}" revoked successfully.`));
});

app.post("/user/keys/:id/rename", requireUser, (req, res) => {
  const keyId = Number(req.params.id);
  const keys = db.getUserKeys(req.user.id);
  const key = keys.find(k => k.id === keyId);
  if (!key) {
    res.redirect("/?msg=" + encodeURIComponent("Key not found."));
    return;
  }

  const name = String(req.body.name || "").trim();
  if (!name) {
    res.redirect("/?msg=" + encodeURIComponent("Key name is required."));
    return;
  }

  db.renameUserKey(keyId, req.user.id, name);
  res.redirect("/?msg=" + encodeURIComponent(`Key renamed to "${name}" successfully.`));
});

app.post("/user/reset-password", requireUser, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const repeatNewPassword = String(req.body.repeatNewPassword || "");

  if (!timingSafeCompare(hashPassword(currentPassword), req.user.password_hash)) {
    res.redirect("/?tab=security&msg=" + encodeURIComponent("Current password is incorrect."));
    return;
  }

  if (newPassword !== repeatNewPassword) {
    res.redirect("/?tab=security&msg=" + encodeURIComponent("New passwords do not match."));
    return;
  }

  if (newPassword.length < 4) {
    res.redirect("/?tab=security&msg=" + encodeURIComponent("Password must be at least 4 characters long."));
    return;
  }

  db.setUserPassword(req.user.id, hashPassword(newPassword));
  res.redirect("/?tab=security&msg=" + encodeURIComponent("Password changed successfully."));
});

app.post("/user/sessions/:id/rename", requireUser, (req, res) => {
  const sessionId = Number(req.params.id);
  const session = db.getUserSessionById(sessionId);

  if (!session || session.revoked_at || session.user_id !== req.user.id) {
    res.redirect(`/?tab=sessions&msg=${encodeURIComponent("Session not found.")}`);
    return;
  }

  const name = String(req.body.name || "").trim() || "Untitled Session";
  db.renameUserSession(sessionId, req.user.id, name);
  res.redirect(`/?tab=sessions&msg=${encodeURIComponent("Session renamed successfully.")}`);
});

app.post("/user/sessions/:id/revoke", requireUser, (req, res) => {
  const sessionId = Number(req.params.id);
  const session = db.getUserSessionById(sessionId);

  if (!session || session.revoked_at || session.user_id !== req.user.id) {
    res.redirect(`/?tab=sessions&msg=${encodeURIComponent("Session not found.")}`);
    return;
  }

  db.revokeUserSession(sessionId, req.user.id);

  const cookies = parseCookies(req);
  if (session.token === cookies.user_session) {
    clearCookie(res, "user_session");
    res.redirect("/");
    return;
  }

  res.redirect(`/?tab=sessions&msg=${encodeURIComponent("Session revoked successfully.")}`);
});

// --- ADMIN API ENDPOINTS ---
app.get("/admin/api/users/:id", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);
  if (!user) {
    res.status(404).json({ err: "User not found" });
    return;
  }

  const keys = db.getUserKeys(userId);
  const historyLimit = getWatchHistoryLimit(req);
  const watchHistory = db.getWatchHistoryForUser(userId, historyLimit);

  let activeStreams = 0;
  let activePlaybackHashes = [];
  for (const k of keys) {
    activeStreams += getActiveStreamCount(k.token);
    activePlaybackHashes.push(...getActivePlaybackHashes(k.token));
  }

  res.json({
    activeStreams,
    activePlaybackHashes,
    watchHistory,
  });
});

app.get("/admin/api/status", requireAdmin, async (req, res) => {
  const users = db.getAllUsers().map((user) => {
    const keys = db.getUserKeys(user.id);
    let activeStreams = 0;
    for (const k of keys) {
      activeStreams += getActiveStreamCount(k.token);
    }
    return {
      id: user.id,
      username: user.username,
      bandwidth_limit: user.bandwidth_limit,
      bandwidth_used: user.bandwidth_used,
      bandwidth_reset_at: user.bandwidth_reset_at,
      is_suspended: user.is_suspended,
      created_at: user.created_at,
      max_keys: user.max_keys,
      activeStreams,
      keysCount: keys.length,
    };
  });

  const totalActiveStreams = users.reduce((acc, u) => acc + u.activeStreams, 0);
  const postgresStats = await getPostgresStats(config);

  res.json({
    bitmagnet: await bitmagnet.getStatus(),
    totalActiveStreams,
    users,
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

// --- STATIC AND STREAM PLAYBACK ROUTING ---
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

    if (key.user_id) {
      const user = db.getUserById(key.user_id);
      if (user) {
        db.checkAndResetBandwidth(user);
        if (user.is_suspended) {
          console.error(`[play] user suspended user=${user.username} ip=${req.ip}`);
          sendBlockedPlaybackVideo(req, res, key, "suspended");
          return;
        }

        const needed = (payload.stream && payload.stream.sizeBytes) ? payload.stream.sizeBytes : 0;
        const remaining = Math.max(0, user.bandwidth_limit - user.bandwidth_used);

        if (user.bandwidth_used >= user.bandwidth_limit) {
          console.error(`[play] bandwidth limit exceeded user=${user.username} ip=${req.ip}`);
          sendBlockedPlaybackVideo(req, res, key, "bandwidth", needed, user);
          return;
        }

        if (needed > 0 && remaining < needed) {
          console.error(`[play] insufficient bandwidth size=${needed} remaining=${remaining} user=${user.username} ip=${req.ip}`);
          sendBlockedPlaybackVideo(req, res, key, "insufficient_bandwidth", needed, user);
          return;
        }
      }
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

    const activeStreamCount = getActiveStreamCount(key.token);
    if (!isPlaybackTracked(key.token, req.params.token) && activeStreamCount >= 1) {
      console.error(
        `[play] concurrency blocked key=${JSON.stringify(key.name)} active=${activeStreamCount} limit=1 ip=${JSON.stringify(req.ip)}`,
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

    // Track bandwidth usage on write/end
    let bytesSent = 0;
    let recordedBytes = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, encoding, callback) {
      if (chunk && typeof chunk !== "function") {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      }
      return originalWrite.apply(this, arguments);
    };

    res.end = function (chunk, encoding, callback) {
      if (chunk && typeof chunk !== "function") {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      }
      const diff = bytesSent - recordedBytes;
      if (diff > 0 && key.user_id) {
        db.incrementBandwidth(key.user_id, key.id, diff);
        recordedBytes = bytesSent;
      }
      return originalEnd.apply(this, arguments);
    };

    const recordBandwidthOnClose = () => {
      const diff = bytesSent - recordedBytes;
      if (diff > 0 && key.user_id) {
        db.incrementBandwidth(key.user_id, key.id, diff);
        recordedBytes = bytesSent;
      }
    };

    res.on("close", recordBandwidthOnClose);
    res.on("finish", recordBandwidthOnClose);

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
    if (!res.headersSent) {
      res.status(500).send(`Stream failed: ${error.message}`);
    }
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

    if (key.user_id) {
      const user = db.getUserById(key.user_id);
      if (user) {
        db.checkAndResetBandwidth(user);
        if (user.is_suspended) {
          sendBlockedPlaybackVideo(req, res, key, "suspended");
          return;
        }

        const needed = (payload.stream && payload.stream.sizeBytes) ? payload.stream.sizeBytes : 0;
        const remaining = Math.max(0, user.bandwidth_limit - user.bandwidth_used);

        if (user.bandwidth_used >= user.bandwidth_limit) {
          sendBlockedPlaybackVideo(req, res, key, "bandwidth", needed, user);
          return;
        }

        if (needed > 0 && remaining < needed) {
          sendBlockedPlaybackVideo(req, res, key, "insufficient_bandwidth", needed, user);
          return;
        }
      }
    }

    if (key.paused_at) {
      sendBlockedPlaybackVideo(req, res, key, "paused");
      return;
    }

    const activeStreamCount = getActiveStreamCount(key.token);
    if (!isPlaybackTracked(key.token, req.params.token) && activeStreamCount >= 1) {
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

// --- ADMIN ACCESS ROUTING ---
app.get("/admin", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token || !verifySession(token, config.sessionSecret)) {
    res.send(renderLogin("", config.nullcaptchaUrl));
    return;
  }

  const dbSession = db.getSessionByToken(token);
  if (!dbSession || dbSession.revoked_at) {
    res.send(renderLogin("Session has been revoked.", config.nullcaptchaUrl));
    return;
  }

  db.updateSessionLastActive(token);
  renderAdmin(req, res);
});

function getSessionName(req) {
  const ua = req.headers["user-agent"] || "";
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
  const isHuman = await verifyNullCaptcha(req);
  if (!isHuman) {
    res.status(400).send(renderLogin("Null CAPTCHA verification failed. Please try again.", config.nullcaptchaUrl));
    return;
  }

  const provided = String(req.body.password || "");
  if (!timingSafeCompare(hashPassword(provided), hashPassword(config.adminPassword))) {
    res.status(401).send(renderLogin("Invalid password.", config.nullcaptchaUrl));
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

// --- ADMIN USER MANAGEMENT ROUTING ---
app.post("/admin/users", requireAdmin, (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const bandwidthLimitGb = Number(req.body.bandwidthLimitGb);
  const maxKeys = Number(req.body.maxKeys || 5);

  if (!username || !password || isNaN(bandwidthLimitGb) || bandwidthLimitGb < 1 || isNaN(maxKeys) || maxKeys < 1) {
    redirectToAdmin(res, "Invalid input data.");
    return;
  }

  const existing = db.getUserByUsername(username);
  if (existing) {
    redirectToAdmin(res, "Username already exists.");
    return;
  }

  const limitBytes = bandwidthLimitGb * 1024 * 1024 * 1024;
  db.createUser(username, hashPassword(password), limitBytes, maxKeys);
  redirectToAdmin(res, `User ${username} created successfully.`);
});

app.get("/admin/users/:id", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  await renderUserAdmin(req, res, user);
});

app.post("/admin/users/:id/quota", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);
  const bandwidthLimitGb = Number(req.body.bandwidthLimitGb);
  const maxKeys = Number(req.body.maxKeys || 5);

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  if (isNaN(bandwidthLimitGb) || bandwidthLimitGb < 1) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Limit must be at least 1 GB.")}`);
    return;
  }
  if (isNaN(maxKeys) || maxKeys < 1) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Max keys must be at least 1.")}`);
    return;
  }

  const limitBytes = bandwidthLimitGb * 1024 * 1024 * 1024;
  db.setUserLimits(userId, limitBytes, maxKeys);
  res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Quota updated successfully.")}`);
});

app.post("/admin/users/:id/reset-bandwidth", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  db.resetUserBandwidth(userId);
  
  const referer = req.headers.referer || "";
  if (referer.includes(`/admin/users/${userId}`)) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Bandwidth usage reset to 0.")}`);
  } else {
    res.redirect(`/admin?msg=${encodeURIComponent(`Bandwidth usage reset for ${user.username}.`)}`);
  }
});

app.post("/admin/users/:id/password", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);
  const password = String(req.body.password || "");

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  if (password.length < 4) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Password must be at least 4 characters long.")}`);
    return;
  }

  db.setUserPassword(userId, hashPassword(password));
  res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent("Password set successfully.")}`);
});

app.post("/admin/users/:id/toggle-status", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  const nextSuspendedState = !user.is_suspended;
  if (user.is_suspended) {
    db.unsuspendUser(userId);
  } else {
    db.suspendUser(userId);
    db.raw.prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId);
  }

  const referer = req.headers.referer || "";
  const statusStr = nextSuspendedState ? "suspended" : "activated";
  if (referer.includes(`/admin/users/${userId}`)) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent(`User account ${statusStr}.`)}`);
  } else {
    res.redirect(`/admin?msg=${encodeURIComponent(`User account ${statusStr} for ${user.username}.`)}`);
  }
});

app.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);
  const confirmUsername = String(req.body.confirmUsername || "").trim();

  if (!user) {
    redirectToAdmin(res, "User not found.");
    return;
  }

  if (confirmUsername !== user.username) {
    res.redirect(`/admin/users/${userId}?msg=${encodeURIComponent(`Deletion blocked. Type exact username: ${user.username}`)}`);
    return;
  }

  db.deleteUser(userId);
  redirectToAdmin(res, `User ${user.username} deleted.`);
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
