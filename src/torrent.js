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

function createTorrentService(config) {
  const inspectionCache = new Map();

  function log(message, details = {}) {
    const serialized = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(`[torrent] ${message}${serialized ? ` ${serialized}` : ""}`);
  }

  async function addAndResolveTorrent(magnetUri, timeoutMs) {
    const defaultTimeout = config.metadataTimeoutMs || 60000;
    const resolvedTimeout = timeoutMs || defaultTimeout;

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

    const startTime = Date.now();
    while (Date.now() - startTime < resolvedTimeout) {
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
          if (torrentData && torrentData.file_stats && torrentData.file_stats.length > 0) {
            return torrentData;
          }
        }
      } catch (error) {
        log("error polling torrent status", { hash, error: error.message });
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Metadata fetch timed out after ${resolvedTimeout}ms`);
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
      const torrTorrent = await addAndResolveTorrent(magnetUri);
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
    streamRelease: streamSource,
  };
}

module.exports = {
  createTorrentService,
};
