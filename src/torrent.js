const path = require("node:path");
const fs = require("node:fs");
const { extractEpisodeParts } = require("./classify");

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".m4v",
  ".webm",
  ".mpg",
  ".mpeg",
]);

const MIB = 1024 * 1024;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFilesystemStats(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath, { bigint: true });
    const blockSize = Number(stats.bsize);
    return {
      totalBytes: Number(stats.blocks) * blockSize,
      freeBytes: Number(stats.bavail) * blockSize,
    };
  } catch (_error) {
    return null;
  }
}

function getEntrySize(targetPath) {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (_error) {
    return 0;
  }

  if (stats.isDirectory()) {
    let total = 0;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      total += getEntrySize(path.join(targetPath, entry.name));
    }
    return total;
  }

  return stats.size;
}

function listCacheEntries(cachePath) {
  if (!fs.existsSync(cachePath)) {
    return [];
  }

  return fs.readdirSync(cachePath, { withFileTypes: true }).map((entry) => {
    const entryPath = path.join(cachePath, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (_error) {
      return null;
    }

    return {
      name: entry.name,
      path: entryPath,
      mtimeMs: stats.mtimeMs,
      sizeBytes: getEntrySize(entryPath),
    };
  }).filter(Boolean);
}

function removePathIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function removeEmptyDirectories(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return 0;
  }

  let removedCount = 0;

  function walk(dirPath) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_error) {
      return false;
    }

    let hasChildren = false;
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const childEmpty = walk(entryPath);
        if (!childEmpty) {
          hasChildren = true;
        }
        continue;
      }

      hasChildren = true;
    }

    if (dirPath === rootPath) {
      return !hasChildren;
    }

    if (!hasChildren) {
      try {
        fs.rmdirSync(dirPath);
        removedCount += 1;
        return true;
      } catch (_error) {
        return false;
      }
    }

    return false;
  }

  walk(rootPath);
  return removedCount;
}

function guessMimeType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  switch (ext) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
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

function extractInfoHash(magnetUri) {
  const raw = decodeURIComponent(String(magnetUri || ""));
  const match = raw.match(/(?:[?&]xt=urn:btih:)([a-zA-Z0-9]+)/i);
  if (!match) {
    return null;
  }

  const value = match[1].trim();
  if (/^[a-f0-9]{40}$/i.test(value)) {
    return value.toLowerCase();
  }

  return null;
}

function parseTrackerList(rawValue) {
  return Array.from(new Set(
    String(rawValue || "")
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => /^(udp|http|https|ws|wss):\/\//i.test(entry)),
  ));
}

function enrichMagnetUri(magnetUri, trackers) {
  const raw = String(magnetUri || "").trim();
  if (!raw.startsWith("magnet:?")) {
    return raw;
  }
  const query = raw.slice("magnet:?".length);
  const params = new URLSearchParams(query);
  const existingTrackers = new Set(params.getAll("tr").filter(Boolean));
  let enriched = raw;
  for (const tracker of trackers) {
    if (!existingTrackers.has(tracker)) {
      enriched += `${enriched.includes("?") ? "&" : "?"}tr=${encodeURIComponent(tracker)}`;
    }
  }
  return enriched;
}

function createTorrentService(config) {
  const downloadsPath = config.torrentCacheDir;
  ensureDir(downloadsPath);

  let clientPromise = null;
  let prunePromise = null;
  let cacheSweepTimer = null;
  let cacheSweepRunning = false;
  const torrentCache = new Map();
  const inspectionCache = new Map();
  const torrentState = new Map();
  const trackerState = {
    trackers: [],
    loadedAt: 0,
    refreshPromise: null,
  };

  function summarizeObject(value, seen, depth) {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (depth >= 2) {
      if (Array.isArray(value)) {
        return `[Array(${value.length})]`;
      }
      return `[${value.constructor?.name || "Object"}]`;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 8).map((entry) => summarizeValue(entry, seen, depth + 1));
    }

    if ("infoHash" in value || "magnetURI" in value || "magnetUri" in value) {
      return {
        type: value.constructor?.name || "TorrentLike",
        infoHash: value.infoHash || null,
        name: value.name || null,
        progress: Number.isFinite(value.progress) ? Number(value.progress.toFixed(4)) : null,
        peers: Number.isFinite(value.numPeers) ? value.numPeers : null,
        ready: typeof value.ready === "boolean" ? value.ready : null,
      };
    }

    const entries = Object.entries(value).slice(0, 12);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, summarizeValue(entryValue, seen, depth + 1)]),
    );
  }

  function summarizeValue(value, seen = new WeakSet(), depth = 0) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        code: value.code,
      };
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    return summarizeObject(value, seen, depth);
  }

  function stringifyLogValue(value) {
    return JSON.stringify(summarizeValue(value));
  }

  function log(message, details = {}) {
    const serialized = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${stringifyLogValue(value)}`)
      .join(" ");
    console.log(`[torrent] ${message}${serialized ? ` ${serialized}` : ""}`);
  }

  async function refreshTrackers(force = false) {
    const listUrl = String(config.torrentTrackerListUrl || "").trim();
    if (!listUrl) {
      return trackerState.trackers;
    }

    if (!force && trackerState.loadedAt > 0 && Date.now() - trackerState.loadedAt < config.torrentTrackerRefreshMs) {
      return trackerState.trackers;
    }

    if (trackerState.refreshPromise) {
      return trackerState.refreshPromise;
    }

    trackerState.refreshPromise = (async () => {
      try {
        const response = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const body = await response.text();
        const parsed = parseTrackerList(body);
        if (parsed.length === 0) {
          throw new Error("No valid trackers found.");
        }

        trackerState.trackers = parsed;
        trackerState.loadedAt = Date.now();
        log("tracker list refreshed", {
          source: listUrl,
          trackerCount: parsed.length,
        });
      } catch (error) {
        trackerState.loadedAt = Date.now();
        log("tracker list refresh failed, using cached tracker set", {
          source: listUrl,
          trackerCount: trackerState.trackers.length,
          error: error.message,
        });
      } finally {
        trackerState.refreshPromise = null;
      }

      return trackerState.trackers;
    })();

    return trackerState.refreshPromise;
  }

  function pruneEmptyCacheDirectories(reason) {
    const removedCount = removeEmptyDirectories(downloadsPath);
    if (removedCount > 0) {
      log("removed empty cache directories", {
        reason,
        removedCount,
        cachePath: downloadsPath,
      });
    }
  }

  async function pruneCacheIfNeeded(reason) {
    if (prunePromise) {
      return prunePromise;
    }

    prunePromise = Promise.resolve().then(() => {
      const fsStats = getFilesystemStats(downloadsPath);
      if (!fsStats) {
        return;
      }

      const reserveBytes = config.torrentCacheReserveBytes;
      if (fsStats.freeBytes >= reserveBytes) {
        return;
      }

      const activeKeys = new Set(
        Array.from(torrentState.entries())
          .filter(([, state]) => state && (state.activeStreams > 0 || state.cleanupTimer))
          .map(([key]) => String(key || "").toLowerCase()),
      );
      const removableEntries = listCacheEntries(downloadsPath)
        .filter((entry) => !activeKeys.has(entry.name.toLowerCase()))
        .sort((left, right) => left.mtimeMs - right.mtimeMs);

      let freedBytes = 0;
      for (const entry of removableEntries) {
        try {
          fs.rmSync(entry.path, { recursive: true, force: true });
          pruneEmptyCacheDirectories("cache-prune");
          freedBytes += entry.sizeBytes;
          const updatedStats = getFilesystemStats(downloadsPath);
          if (updatedStats && updatedStats.freeBytes >= reserveBytes) {
            log("cache prune complete", {
              reason,
              freedBytes,
              freeBytes: updatedStats.freeBytes,
              reserveBytes,
            });
            return;
          }
        } catch (error) {
          log("cache prune failed", {
            reason,
            path: entry.path,
            error: error.message,
          });
        }
      }

      const remainingStats = getFilesystemStats(downloadsPath);
      log("cache reserve still low", {
        reason,
        freedBytes,
        freeBytes: remainingStats ? remainingStats.freeBytes : null,
        reserveBytes,
        cachePath: downloadsPath,
      });
    }).finally(() => {
      prunePromise = null;
    });

    return prunePromise;
  }

  async function getClient() {
    if (!clientPromise) {
      clientPromise = import("webtorrent").then(({ default: WebTorrent }) => {
        const client = new WebTorrent({
          path: downloadsPath,
          torrentPort: config.torrentPort,
          maxConns: config.torrentMaxConns,
          dht: true,
          tracker: true,
        });

        client.on("error", (error) => {
          log("client error", { error: error.message });
        });

        ensureCacheSweepStarted();
        const fsStats = getFilesystemStats(downloadsPath);
        log("client ready", {
          downloadsPath,
          torrentPort: config.torrentPort,
          maxConns: config.torrentMaxConns,
          reserveBytes: config.torrentCacheReserveBytes,
          sweepIntervalMs: config.torrentSweepIntervalMs,
          totalBytes: fsStats ? fsStats.totalBytes : null,
          freeBytes: fsStats ? fsStats.freeBytes : null,
        });
        return client;
      });
    }
    return clientPromise;
  }

  function getTorrentKey(torrent, fallbackMagnetUri = "") {
    return String(torrent?.infoHash || extractInfoHash(fallbackMagnetUri) || fallbackMagnetUri || "");
  }

  function getTorrentCachePaths(torrent, fallbackMagnetUri = "") {
    const key = getTorrentKey(torrent, fallbackMagnetUri);
    const torrentPath = typeof torrent?.path === "string" ? torrent.path : "";
    const torrentName = typeof torrent?.name === "string" ? torrent.name : "";
    const filePaths = Array.isArray(torrent?.files)
      ? torrent.files
        .map((file) => {
          const filePath = typeof file?.path === "string" ? file.path : "";
          return torrentPath && filePath ? path.join(torrentPath, filePath) : "";
        })
        .filter(Boolean)
      : [];
    const candidates = [
      torrentPath && torrentName ? path.join(torrentPath, torrentName) : "",
      ...filePaths,
      key ? path.join(downloadsPath, key) : "",
    ].filter(Boolean);

    return Array.from(new Set(candidates));
  }

  function getTopLevelCacheEntryPath(targetPath) {
    if (!targetPath) {
      return "";
    }

    const resolvedRoot = path.resolve(downloadsPath);
    const resolvedTarget = path.resolve(targetPath);
    const relativePath = path.relative(resolvedRoot, resolvedTarget);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return "";
    }

    const firstSegment = relativePath.split(path.sep)[0];
    return firstSegment ? path.join(resolvedRoot, firstSegment) : "";
  }

  function getOrCreateTorrentState(torrent, fallbackMagnetUri = "") {
    const key = getTorrentKey(torrent, fallbackMagnetUri);
    if (!torrentState.has(key)) {
      torrentState.set(key, {
        activeStreams: 0,
        cleanupTimer: null,
        lastTouchedAt: Date.now(),
      });
    }
    return { key, state: torrentState.get(key) };
  }

  function markTorrentTouched(torrent, fallbackMagnetUri = "") {
    const { state } = getOrCreateTorrentState(torrent, fallbackMagnetUri);
    state.lastTouchedAt = Date.now();
    return state;
  }

  function cancelTorrentCleanup(torrent, fallbackMagnetUri = "") {
    const { state } = getOrCreateTorrentState(torrent, fallbackMagnetUri);
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }
    state.lastTouchedAt = Date.now();
  }

  async function scheduleTorrentCleanup(torrent, fallbackMagnetUri = "") {
    const client = await getClient();
    const { key, state } = getOrCreateTorrentState(torrent, fallbackMagnetUri);
    if (state.activeStreams > 0 || state.cleanupTimer) {
      return;
    }

    state.cleanupTimer = setTimeout(async () => {
      const current = torrentState.get(key);
      if (!current || current.activeStreams > 0) {
        return;
      }
      const existing = findExistingTorrent(client, fallbackMagnetUri, key);
      if (!existing) {
        torrentState.delete(key);
        return;
      }
      log("removing idle torrent", {
        infoHash: existing.infoHash || key,
        idleMs: config.torrentIdleGraceMs,
      });
      await removeTorrent(client, existing.magnetURI || existing.magnetUri || fallbackMagnetUri, existing);
      pruneEmptyCacheDirectories("idle-torrent-removed");
      await pruneCacheIfNeeded("idle-torrent-removed");
      torrentState.delete(key);
    }, config.torrentIdleGraceMs);
    state.lastTouchedAt = Date.now();
    if (typeof state.cleanupTimer.unref === "function") {
      state.cleanupTimer.unref();
    }
  }

  async function sweepIdleTorrents() {
    if (cacheSweepRunning) {
      return;
    }
    cacheSweepRunning = true;

    try {
    const client = await getClient();
    const torrents = Array.isArray(client?.torrents) ? client.torrents.slice() : [];
    const now = Date.now();
    const protectedEntryPaths = new Set();

    for (const torrent of torrents) {
      const fallbackMagnetUri = torrent.magnetURI || torrent.magnetUri || "";
      const { key, state } = getOrCreateTorrentState(torrent, fallbackMagnetUri);

      if (torrentCache.has(key)) {
        markTorrentTouched(torrent, fallbackMagnetUri);
        continue;
      }

      const idleForMs = now - (state.lastTouchedAt || 0);
      if (state.activeStreams > 0 || idleForMs < config.torrentIdleGraceMs) {
        for (const candidate of getTorrentCachePaths(torrent, fallbackMagnetUri)) {
          const entryPath = getTopLevelCacheEntryPath(candidate);
          if (entryPath) {
            protectedEntryPaths.add(path.resolve(entryPath));
          }
        }
        continue;
      }

      cancelTorrentCleanup(torrent, fallbackMagnetUri);
      log("sweeping idle torrent", {
        infoHash: torrent.infoHash || key,
        idleForMs,
      });
      await removeTorrent(client, fallbackMagnetUri || key, torrent);
      torrentState.delete(key);
    }

    for (const [key, state] of torrentState.entries()) {
      if (state && (state.activeStreams > 0 || now - (state.lastTouchedAt || 0) < config.torrentIdleGraceMs)) {
        const entryPath = getTopLevelCacheEntryPath(path.join(downloadsPath, key));
        if (entryPath) {
          protectedEntryPaths.add(path.resolve(entryPath));
        }
      }
    }

    let removedEntries = 0;
    for (const entry of listCacheEntries(downloadsPath)) {
      const entryPath = path.resolve(entry.path);
      if (protectedEntryPaths.has(entryPath)) {
        continue;
      }
      if (removePathIfExists(entry.path)) {
        removedEntries += 1;
        log("removed stale cache entry", {
          path: entry.path,
          idleForMs: now - entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
        });
      }
    }

    if (removedEntries > 0) {
      pruneEmptyCacheDirectories("cache-sweep");
      await pruneCacheIfNeeded("cache-sweep");
    }
    } finally {
      cacheSweepRunning = false;
    }
  }

  function ensureCacheSweepStarted() {
    if (cacheSweepTimer) {
      return;
    }
    cacheSweepTimer = setInterval(() => {
      sweepIdleTorrents().catch((error) => {
        log("cache sweep failed", {
          error: error.message,
        });
      });
    }, config.torrentSweepIntervalMs);
    if (typeof cacheSweepTimer.unref === "function") {
      cacheSweepTimer.unref();
    }
  }

  ensureCacheSweepStarted();
  setTimeout(() => {
    sweepIdleTorrents().catch((error) => {
      log("initial cache sweep failed", {
        error: error.message,
      });
    });
  }, 0);

  function removeTorrent(client, magnetUri, torrent = null, deleteFiles = false) {
    return new Promise((resolve) => {
      const finish = () => {
        if (deleteFiles) {
          const removedPaths = getTorrentCachePaths(torrent, magnetUri)
            .filter((candidate) => removePathIfExists(candidate));
          if (removedPaths.length > 0) {
            log("removed torrent cache paths", {
              infoHash: torrent?.infoHash || extractInfoHash(magnetUri),
              removedPaths,
            });
          }
        }
        resolve();
      };

      if (typeof client.remove !== "function") {
        finish();
        return;
      }

      try {
        client.remove(magnetUri, { destroyStore: deleteFiles }, finish);
      } catch (_error) {
        client.remove(magnetUri, finish);
      }
    });
  }

  function waitForTorrentReady(torrent) {
    if (!torrent) {
      return Promise.reject(new Error("Torrent not found."));
    }
    if (typeof torrent.once !== "function") {
      return Promise.reject(new Error("Torrent instance is not event-emitting."));
    }
    if (torrent.ready) {
      return Promise.resolve(torrent);
    }

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        torrent.removeListener("ready", onReady);
        reject(error);
      };
      const onReady = () => {
        torrent.removeListener("error", onError);
        resolve(torrent);
      };

      torrent.once("error", onError);
      torrent.once("ready", onReady);
    });
  }

  function findExistingTorrent(client, magnetUri, infoHash) {
    const torrents = Array.isArray(client?.torrents) ? client.torrents : [];
    return torrents.find((torrent) => {
      if (!torrent || typeof torrent.once !== "function") {
        return false;
      }
      if (infoHash && String(torrent.infoHash || "").toLowerCase() === infoHash.toLowerCase()) {
        return true;
      }
      return String(torrent.magnetURI || torrent.magnetUri || "") === magnetUri;
    }) || null;
  }

  function chooseFile(torrent, preferredIndex, season, episode) {
    const videoFiles = torrent.files.filter((file) =>
      VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()),
    );

    if (videoFiles.length > 0 && Number.isInteger(season) && Number.isInteger(episode)) {
      const episodeMatch = videoFiles.find((file) => {
        const parts = extractEpisodeParts(`${torrent.name} ${file.name}`);
        if (!parts) return false;
        if (parts.season === season && parts.episode === episode) return true;
        if (!Number.isInteger(parts.season) && parts.episode === episode) {
           const seasonPattern = new RegExp(`(?:s|season)[ ._-]*0?${season}\\b`, "i");
           if (seasonPattern.test(torrent.name)) {
             return true;
           }
           if (videoFiles.length === 1) {
             return true;
           }
        }
        return false;
      });
      if (episodeMatch) {
        return episodeMatch;
      }
    }

    if (Number.isInteger(preferredIndex) && torrent.files[preferredIndex]) {
      return torrent.files[preferredIndex];
    }

    if (videoFiles.length === 0) {
      return torrent.files.slice().sort((a, b) => b.length - a.length)[0] || null;
    }
    return videoFiles.sort((a, b) => b.length - a.length)[0];
  }

  function suppressTorrentDownloads(torrent) {
    if (!torrent) {
      return;
    }

    if (typeof torrent.deselect === "function" && Array.isArray(torrent.pieces) && torrent.pieces.length > 0) {
      try {
        torrent.deselect(0, torrent.pieces.length - 1, false);
      } catch (_error) {
      }
    }

    for (const file of Array.isArray(torrent.files) ? torrent.files : []) {
      if (typeof file?.deselect === "function") {
        try {
          file.deselect();
        } catch (_error) {
        }
      }
    }
  }

  function prioritizeFile(file, torrent, label) {
    if (!file) {
      return;
    }

    if (typeof file.select === "function") {
      try {
        file.select();
        log("torrent file prioritized", {
          infoHash: torrent?.infoHash || null,
          fileName: file.name,
          fileLength: file.length,
          reason: label,
        });
      } catch (error) {
        log("torrent file priority failed", {
          infoHash: torrent?.infoHash || null,
          fileName: file.name,
          reason: label,
          error: error.message,
        });
      }
    }
  }

  async function getTorrent(magnetUri, options = {}) {
    await pruneCacheIfNeeded("before-add");
    const client = await getClient();
    const trackers = await refreshTrackers();
    const enrichedMagnetUri = enrichMagnetUri(magnetUri, trackers);
    const infoHash = extractInfoHash(enrichedMagnetUri);
    const cacheKey = infoHash || magnetUri;

    const existing = findExistingTorrent(client, enrichedMagnetUri, infoHash);
    if (existing) {
      cancelTorrentCleanup(existing, enrichedMagnetUri);
      markTorrentTouched(existing, enrichedMagnetUri);

      if (!existing.ready && Array.isArray(trackers)) {
        for (const tr of trackers) {
          try {
            if (typeof existing.addTracker === "function") {
              existing.addTracker(tr);
            }
          } catch (_err) {
            // ignore duplicate trackers
          }
        }
      }

      log("reusing existing torrent", {
        infoHash: existing.infoHash || infoHash,
        ready: Boolean(existing.ready),
        progress: existing.progress,
        peers: existing.numPeers,
      });
      return waitForTorrentReady(existing);
    }

    if (torrentCache.has(cacheKey)) {
      log("awaiting pending torrent", { infoHash, cacheKey });
      return torrentCache.get(cacheKey);
    }

    const pending = new Promise((resolve, reject) => {
      let torrent;
      try {
        const pathOptions = infoHash ? { path: path.join(downloadsPath, infoHash) } : {};
        torrent = client.add(enrichedMagnetUri, pathOptions);
      } catch (error) {
        const duplicateMatch = String(error && error.message || "").match(/Cannot add duplicate torrent ([a-f0-9]{40})/i);
        if (duplicateMatch) {
          const duplicate = findExistingTorrent(client, enrichedMagnetUri, duplicateMatch[1].toLowerCase());
          if (duplicate) {
            resolve(waitForTorrentReady(duplicate));
            return;
          }
        }
        log("client.add failed", { infoHash, error: error.message });
        reject(error);
        return;
      }

      let progressLogAt = 0;
      cancelTorrentCleanup(torrent, enrichedMagnetUri);
      markTorrentTouched(torrent, enrichedMagnetUri);

      const queryIndex = enrichedMagnetUri.indexOf("?");
      log("adding torrent", {
        infoHash,
        cacheKey,
        trackerCount: queryIndex !== -1 ? new URLSearchParams(enrichedMagnetUri.slice(queryIndex)).getAll("tr").length : 0,
      });

      torrent.on("warning", (warning) => {
        log("torrent warning", {
          infoHash: torrent.infoHash || infoHash,
          warning: warning.message || String(warning),
        });
      });

      torrent.on("noPeers", (announceType) => {
        log("torrent no peers", {
          infoHash: torrent.infoHash || infoHash,
          announceType,
        });
      });

      torrent.on("wire", (_wire, addr) => {
        log("torrent peer connected", {
          infoHash: torrent.infoHash || infoHash,
          peer: addr,
          peers: torrent.numPeers,
        });
      });

      torrent.on("download", () => {
        const now = Date.now();
        if (now - progressLogAt < 5000) {
          return;
        }
        progressLogAt = now;
        if (torrent.downloaded > 0 && torrent.downloaded % (512 * MIB) < MIB) {
          pruneCacheIfNeeded("download-progress").catch((error) => {
            log("cache prune scheduling failed", {
              infoHash: torrent.infoHash || infoHash,
              error: error.message,
            });
          });
        }
        log("torrent progress", {
          infoHash: torrent.infoHash || infoHash,
          peers: torrent.numPeers,
          progress: Number(torrent.progress || 0).toFixed(4),
          downloaded: torrent.downloaded,
          downloadSpeed: torrent.downloadSpeed,
        });
      });

      const onError = (error) => {
        torrent.removeListener("ready", onReady);
        log("torrent error", {
          infoHash: torrent.infoHash || infoHash,
          error: error.message,
        });
        reject(error);
      };
      const onReady = () => {
        torrent.removeListener("error", onError);
        markTorrentTouched(torrent, enrichedMagnetUri);
        if (options.inspectOnly) {
          suppressTorrentDownloads(torrent);
        }
        log("torrent ready", {
          infoHash: torrent.infoHash || infoHash,
          name: torrent.name,
          peers: torrent.numPeers,
          files: torrent.files.length,
          length: torrent.length,
        });
        resolve(torrent);
      };

      torrent.once("error", onError);
      torrent.once("ready", onReady);
    });

    torrentCache.set(cacheKey, pending);
    pending.finally(() => {
      torrentCache.delete(cacheKey);
    });
    return pending;
  }

  async function inspectMagnet(magnetUri, options = {}) {
    const infoHash = extractInfoHash(magnetUri);
    if (infoHash && inspectionCache.has(infoHash)) {
      const cached = inspectionCache.get(infoHash);
      if (Date.now() - (cached.at || 0) < 1000 * 60 * 60 * 24) {
        log("using cached inspection result", { infoHash });
        return cached.result;
      }
      inspectionCache.delete(infoHash);
    }

    const timeoutMs = options.timeoutMs || config.metadataTimeoutMs || 60000;
    const startAt = Date.now();
    let torrent;
    try {
      torrent = await Promise.race([
        getTorrent(magnetUri, { inspectOnly: true }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Metadata fetch timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      const durationMs = Date.now() - startAt;
      const file = chooseFile(torrent);
      const result = {
        infoHash: torrent.infoHash,
        torrentName: torrent.name,
        fileIndex: file ? torrent.files.indexOf(file) : null,
        fileName: file ? file.name : null,
        sizeBytes: file ? file.length : null,
        files: torrent.files.map((entry, index) => ({
          index,
          name: entry.name,
          sizeBytes: entry.length,
        })),
      };
      log("inspection complete", { infoHash: torrent.infoHash, durationMs });
      if (infoHash && result) {
        inspectionCache.set(infoHash, { result, at: Date.now() });
      }
      return result;
    } finally {
      if (options.removeAfterInspect) {
        const client = await getClient();
        const infoHash = extractInfoHash(magnetUri);
        const target = torrent || findExistingTorrent(client, magnetUri, infoHash);
        if (target) {
          const removeTarget = target.magnetURI || target.magnetUri || target.infoHash || magnetUri;
          await removeTorrent(client, removeTarget, target, true);
          pruneEmptyCacheDirectories("inspect-remove");
          torrentState.delete(getTorrentKey(target, magnetUri));
        }
      }
    }
  }

  async function getTorrentWithTimeout(magnetUri, timeoutMs = config.metadataTimeoutMs || 90000) {
    return Promise.race([
      getTorrent(magnetUri),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Metadata fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }

  async function streamSource(source, req, res) {
    const magnetUri = source.magnetUri || source.magnet_uri;
    const fileIndex =
      Number.isInteger(source.fileIndex) || Number.isInteger(source.file_index)
        ? Number(source.fileIndex ?? source.file_index)
        : null;
    const infoHash = extractInfoHash(magnetUri);

    if (!magnetUri) {
      res.status(400).send("Missing magnet URI.");
      return;
    }

    log("stream request", {
      infoHash,
      fileIndex,
      range: req.headers.range || "",
      userAgent: req.headers["user-agent"] || "",
    });

    await pruneCacheIfNeeded("before-stream");
    const torrent = await getTorrentWithTimeout(magnetUri);
    const file = chooseFile(torrent, fileIndex, source.season, source.episode);

    if (!file) {
      log("stream no playable file", {
        infoHash: torrent.infoHash || infoHash,
        requestedFileIndex: fileIndex,
      });
      res.status(404).send("No playable file found for this torrent.");
      return;
    }

    const totalSize = file.length;
    const range = parseRange(req.headers.range, totalSize);

    prioritizeFile(file, torrent, range ? "range-stream" : "full-stream");

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", guessMimeType(file.name));
    res.setHeader("Cache-Control", "private, max-age=60");

    log("stream selected file", {
      infoHash: torrent.infoHash || infoHash,
      fileName: file.name,
      selectedFileIndex: torrent.files.indexOf(file),
      totalSize,
    });

    if (range) {
      res.status(206);
      res.setHeader("Content-Length", range.end - range.start + 1);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
      log("stream partial response", {
        infoHash: torrent.infoHash || infoHash,
        start: range.start,
        end: range.end,
      });
      pipeStream(
        file.createReadStream({ start: range.start, end: range.end }),
        res,
        {
          infoHash: torrent.infoHash || infoHash,
          magnetUri,
          start: range.start,
          end: range.end,
        },
        torrent,
      );
      return;
    }

    res.status(200);
    res.setHeader("Content-Length", totalSize);
    log("stream full response", {
      infoHash: torrent.infoHash || infoHash,
      totalSize,
    });
    pipeStream(
      file.createReadStream(),
      res,
      {
        infoHash: torrent.infoHash || infoHash,
        magnetUri,
        start: 0,
        end: totalSize - 1,
      },
      torrent,
    );
  }

  function pipeStream(readStream, res, details, torrent = null) {
    let settled = false;
    const magnetUri = details.magnetUri || "";

    const releaseTorrent = () => {
      if (!torrent) {
        return;
      }
      const { state } = getOrCreateTorrentState(torrent, magnetUri);
      if (state.activeStreams > 0) {
        state.activeStreams -= 1;
      }
      scheduleTorrentCleanup(torrent, magnetUri).catch((error) => {
        log("torrent cleanup scheduling failed", {
          infoHash: torrent.infoHash || extractInfoHash(magnetUri),
          error: error.message,
        });
      });
    };

    const cleanup = () => {
      readStream.removeAllListeners("error");
      res.removeListener("close", onClose);
      res.removeListener("finish", onFinish);
      res.removeListener("error", onResponseError);
    };

    const onClose = () => {
      if (settled) {
        return;
      }
      settled = true;
      log("stream client closed", details);
      cleanup();
      releaseTorrent();
      if (typeof readStream.destroy === "function" && !readStream.destroyed) {
        readStream.destroy();
      }
    };

    const onFinish = () => {
      if (settled) {
        return;
      }
      settled = true;
      log("stream response finished", details);
      cleanup();
      releaseTorrent();
    };

    const onResponseError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      log("stream response error", {
        ...details,
        error: error.message,
      });
      cleanup();
      releaseTorrent();
      if (typeof readStream.destroy === "function" && !readStream.destroyed) {
        readStream.destroy(error);
      }
    };

    readStream.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      releaseTorrent();
      const isPrematureClose =
        error && (
          error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
          /closed prematurely/i.test(String(error.message || ""))
        );
      if (isPrematureClose) {
        log("stream read closed prematurely", {
          ...details,
          error: error.message,
        });
        if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
        return;
      }
      log("stream read error", {
        ...details,
        error: error.message,
      });
      if (!res.headersSent) {
        res.status(500).end("Streaming failed.");
        return;
      }
      if (!res.destroyed) {
        res.destroy(error);
      }
    });

    res.on("close", onClose);
    res.on("finish", onFinish);
    res.on("error", onResponseError);
    if (torrent) {
      const state = markTorrentTouched(torrent, magnetUri);
      cancelTorrentCleanup(torrent, magnetUri);
      state.activeStreams += 1;
    }
    readStream.pipe(res);
  }

  return {
    inspectMagnet,
    streamSource,
    streamRelease: streamSource,
  };
}

module.exports = {
  createTorrentService,
};
