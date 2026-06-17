const path = require("node:path");
const http = require("node:http");
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

// Aggressive-but-safe polling cadence. TorrServer usually returns file_stats
// within a few hundred ms for already-known swarms; tight intervals reduce the
// time-to-first-byte on the hot path while still bounding CPU use.
const POLL_INTERVAL_FAST_MS = 150;
const POLL_INTERVAL_NORMAL_MS = 500;
const FAST_POLL_DURATION_MS = 4000;

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

// Resolve the chosen file for a torrent. When a season/episode is requested we
// ONLY accept a file whose parsed episode markers match BOTH season AND
// episode, OR match the episode with an unambiguous season context derived
// from the torrent name. This deliberately rejects weak "episode-only" hits
// when the torrent name provides a conflicting season, which keeps users from
// being served the wrong episode from a multi-season pack.
function chooseFile(torrent, preferredIndex, season, episode) {
  const videoFiles = torrent.files.filter((file) =>
    VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()),
  );

  if (videoFiles.length > 0 && Number.isInteger(season) && Number.isInteger(episode)) {
    const torrentName = String(torrent.name || "");
    const torrentSeasonParts = extractEpisodeParts(torrentName);
    const torrentNameHasSeason = Number.isInteger(torrentSeasonParts?.season);
    const torrentNameSeason = torrentNameHasSeason ? torrentSeasonParts.season : null;

    // Strong match first: file explicitly encodes season AND episode that match.
    const strongMatch = videoFiles.find((file) => {
      const parts = extractEpisodeParts(`${torrentName} ${file.name}`);
      if (!parts) return false;
      return parts.season === season && parts.episode === episode;
    });
    if (strongMatch) {
      return strongMatch;
    }

    // File-only match: the file encodes just the episode (no season) and the
    // torrent name anchors the season we want. We refuse to infer season from
    // "S1" packs when the torrent name itself does not confirm season 1 —
    // otherwise a multi-season pack would happily return S01E05 when the user
    // asked for S02E05.
    const fileOnlyMatch = videoFiles.find((file) => {
      const parts = extractEpisodeParts(`${torrentName} ${file.name}`);
      if (!parts) return false;
      if (Number.isInteger(parts.season) && parts.season !== season) {
        return false;
      }
      if (!Number.isInteger(parts.season) && parts.episode === episode) {
        if (torrentNameSeason === season) {
          return true;
        }
        // Single-video packs cannot be ambiguous, accept them.
        if (videoFiles.length === 1) {
          return true;
        }
      }
      return false;
    });
    if (fileOnlyMatch) {
      return fileOnlyMatch;
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

function torrentHasFileStats(data) {
  return Boolean(data && Array.isArray(data.file_stats) && data.file_stats.length > 0);
}

function createTorrentService(config) {
  const inspectionCache = new Map();
  // Magnet hashes that have been added to TorrServer and are considered warm.
  // Keeping these in TorrServer's cache means the eventual /play request can
  // skip the add+resolve round trip entirely and go straight to /stream.
  const warmedHashes = new Map();
  const WARMED_TTL_MS = 1000 * 60 * 30;

  function log(message, details = {}) {
    const serialized = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`[torrent] ${message}${serialized ? ` ${serialized}` : ""}`);
  }

  async function addTorrent(magnetUri) {
    let hash = extractInfoHash(magnetUri);

    try {
      const addRes = await fetch(`${config.torrserverUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          link: magnetUri,
          save_to_db: false,
        }),
      });

      if (!addRes.ok) {
        throw new Error(`Failed to add torrent to TorrServer: HTTP ${addRes.status}`);
      }

      const addData = await addRes.json();
      const addTorrentData = Array.isArray(addData) ? addData[0] : addData;
      if (addTorrentData && addTorrentData.hash) {
        hash = addTorrentData.hash;
      }
    } catch (error) {
      log("error adding torrent to TorrServer", { error: error.message });
      if (!hash) {
        throw error;
      }
    }

    if (!hash) {
      throw new Error("Could not determine torrent hash");
    }
    return hash;
  }

  async function fetchTorrentData(hash) {
    try {
      const getRes = await fetch(`${config.torrserverUrl}/torrents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get",
          hash: hash,
        }),
      });

      if (getRes.ok) {
        const getData = await getRes.json();
        const torrentData = Array.isArray(getData) ? getData[0] : getData;
        if (torrentHasFileStats(torrentData)) {
          return torrentData;
        }
      }
    } catch (error) {
      log("error polling torrent status", { hash, error: error.message });
    }
    return null;
  }

  async function addAndResolveTorrent(magnetUri, timeoutMs) {
    const defaultTimeout = config.metadataTimeoutMs || 60000;
    const resolvedTimeout = Math.max(1000, Number(timeoutMs || defaultTimeout));

    const hash = await addTorrent(magnetUri);

    // Fast path: if TorrServer already knows about this hash (warmed), the
    // first "get" almost always returns file_stats. Try once immediately
    // before entering the polling loop so we skip the sleep on the hot path.
    const immediate = await fetchTorrentData(hash);
    if (immediate) {
      return immediate;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < resolvedTimeout) {
      const elapsed = Date.now() - startTime;
      const interval = elapsed < FAST_POLL_DURATION_MS
        ? POLL_INTERVAL_FAST_MS
        : POLL_INTERVAL_NORMAL_MS;

      await new Promise((resolve) => setTimeout(resolve, interval));

      const data = await fetchTorrentData(hash);
      if (data) {
        return data;
      }
    }

    throw new Error(`Metadata fetch timed out after ${resolvedTimeout}ms`);
  }

  // Pre-warm TorrServer with a magnet so that when the user actually hits
  // /play the metadata is already resolved and we can hand back the stream
  // URL on the very first poll. This is fire-and-forget; failures are logged
  // but never bubble up to the caller.
  async function warmMagnet(magnetUri, options = {}) {
    const infoHash = extractInfoHash(magnetUri);
    if (!infoHash) return;

    const cached = warmedHashes.get(infoHash);
    if (cached && Date.now() - cached.at < WARMED_TTL_MS) {
      return;
    }

    const timeoutMs = Math.max(2000, Number(options.timeoutMs || 15000));
    try {
      const torrTorrent = await addAndResolveTorrent(magnetUri, timeoutMs);
      const hash = torrTorrent.hash || infoHash;
      warmedHashes.set(infoHash, { at: Date.now() });
      warmedHashes.set(hash, { at: Date.now() });
      log("warmed magnet", { infoHash: hash, fileCount: torrTorrent.file_stats?.length || 0 });
    } catch (error) {
      log("warm magnet failed", { infoHash, error: error.message });
    }
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
    let torrTorrent;
    try {
      torrTorrent = await addAndResolveTorrent(magnetUri, timeoutMs);
      const durationMs = Date.now() - startAt;

      const files = torrTorrent.file_stats.map((file) => ({
        index: file.id,
        name: path.basename(file.path),
        path: file.path,
        length: file.length,
      }));

      const file = chooseFile(
        { name: torrTorrent.title || torrTorrent.name || "", files },
        null,
        null,
        null,
      );

      const result = {
        infoHash: torrTorrent.hash,
        torrentName: torrTorrent.title || torrTorrent.name || "",
        fileIndex: file ? file.index : null,
        fileName: file ? file.name : null,
        sizeBytes: file ? file.length : null,
        files: files.map((entry) => ({
          index: entry.index,
          name: entry.name,
          sizeBytes: entry.length,
        })),
      };

      log("inspection complete", { infoHash: torrTorrent.hash, durationMs });
      if (torrTorrent.hash && result) {
        inspectionCache.set(torrTorrent.hash, { result, at: Date.now() });
        // Keep the torrent in TorrServer's cache so the eventual play request
        // doesn't have to re-add it. The previous "removeAfterInspect" path
        // threw away exactly the metadata we'll want a moment later.
        warmedHashes.set(torrTorrent.hash, { at: Date.now() });
      }
      return result;
    } finally {
      const hash = torrTorrent?.hash || infoHash;
      if (options.removeAfterInspect && hash) {
        try {
          await fetch(`${config.torrserverUrl}/torrents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "rem",
              hash: hash,
            }),
          });
          log("removed inspect-only torrent from TorrServer", { hash });
          warmedHashes.delete(hash);
        } catch (error) {
          log("failed to remove inspect-only torrent from TorrServer", { hash, error: error.message });
        }
      }
    }
  }

  async function streamSource(source, req, res) {
    const magnetUri = source.magnetUri || source.magnet_uri;
    const fileIndex =
      Number.isInteger(source.fileIndex) || Number.isInteger(source.file_index)
        ? Number(source.fileIndex ?? source.file_index)
        : null;

    if (!magnetUri) {
      res.status(400).send("Missing magnet URI.");
      return;
    }

    const infoHash = extractInfoHash(magnetUri);
    log("stream request", {
      infoHash,
      fileIndex,
      range: req.headers.range || "",
      userAgent: req.headers["user-agent"] || "",
    });

    try {
      // Reuse a warmed torrent if we already resolved its metadata; this
      // avoids a second add+resolve round trip when the user actually clicks
      // play on a release we pre-warmed during the meta/stream phase.
      const warmedInfo = infoHash ? warmedHashes.get(infoHash) : null;
      let torrTorrent;
      if (warmedInfo && Date.now() - warmedInfo.at < WARMED_TTL_MS) {
        const cached = await fetchTorrentData(infoHash);
        if (cached) {
          torrTorrent = cached;
          log("stream reused warmed torrent", { infoHash });
        }
      }

      if (!torrTorrent) {
        torrTorrent = await addAndResolveTorrent(magnetUri);
      }
      const hash = torrTorrent.hash;

      const files = torrTorrent.file_stats.map((file) => ({
        index: file.id,
        name: path.basename(file.path),
        path: file.path,
        length: file.length,
      }));

      const file = chooseFile(
        { name: torrTorrent.title || torrTorrent.name || "", files },
        fileIndex,
        source.season,
        source.episode,
      );

      if (!file) {
        log("stream no playable file", {
          infoHash: hash,
          requestedFileIndex: fileIndex,
        });
        res.status(404).send("No playable file found for this torrent.");
        return;
      }

      const selectedFileIndex = file.index;
      log("stream selected file", {
        infoHash: hash,
        fileName: file.name,
        selectedFileIndex,
        totalSize: file.length,
      });

      warmedHashes.set(hash, { at: Date.now() });
      if (infoHash) warmedHashes.set(infoHash, { at: Date.now() });

      const streamUrl = `${config.torrserverUrl}/stream?link=${hash}&index=${selectedFileIndex}&play`;

      const parsedUrl = new URL(streamUrl);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: parsedUrl.host,
        },
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (error) => {
        log("proxy stream error", { infoHash: hash, error: error.message });
        if (!res.headersSent) {
          res.status(500).send("Streaming failed.");
        } else if (!res.destroyed) {
          res.destroy(error);
        }
      });

      req.pipe(proxyReq);

      res.on("close", () => {
        log("stream connection closed by client", { infoHash: hash });
        proxyReq.destroy();
      });

    } catch (error) {
      log("stream startup failed", { infoHash, error: error.message });
      if (!res.headersSent) {
        res.status(500).send(`Streaming failed: ${error.message}`);
      }
    }
  }

  return {
    inspectMagnet,
    streamSource,
    warmMagnet,
  };
}

module.exports = {
  createTorrentService,
};