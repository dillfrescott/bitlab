const crypto = require("node:crypto");
const path = require("node:path");

const dataDir = path.resolve(process.cwd(), "data");
const torrentCacheDir = "/tmp/webtorrent";
const defaultTorrentCacheReserveGb = 20;
const defaultTorrentIdleGraceMs = 1000 * 60 * 5;
const defaultTorrentSweepIntervalMs = 60000;
const defaultStreamTrackerSweepMs = 5000;
const defaultStreamTrackerStaleMs = 1000 * 60;
const defaultTorrentTrackerListUrl =
  "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
const defaultTorrentTrackerRefreshMs = 1000 * 60 * 60 * 6;
const defaultTorrentMaxConns = 500;

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTimezone() {
  const timezone = process.env.TIMEZONE || "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (_error) {
    return "UTC";
  }
}

function getConfig() {
  const bitmagnetUrl = process.env.BITMAGNET_URL || "http://bitmagnet:3333";
  const bitmagnetTorznabPath = process.env.BITMAGNET_TORZNAB_PATH || "/torznab/api";
  const torrentCacheReserveGb = parsePositiveNumber(
    process.env.TORRENT_CACHE_RESERVE_GB,
    defaultTorrentCacheReserveGb,
  );
  return {
    port: Number(process.env.PORT || 7000),
    baseUrl: process.env.BASE_URL || "",
    dataDir,
    torrentCacheDir,
    torrentCacheReserveBytes: Math.floor(torrentCacheReserveGb * 1024 * 1024 * 1024),
    torrentIdleGraceMs: Math.max(
      30000,
      Math.floor(parsePositiveNumber(process.env.TORRENT_IDLE_GRACE_MS, defaultTorrentIdleGraceMs)),
    ),
    torrentSweepIntervalMs: Math.max(
      5000,
      Math.floor(parsePositiveNumber(process.env.TORRENT_SWEEP_INTERVAL_MS, defaultTorrentSweepIntervalMs)),
    ),
    torrentTrackerListUrl: String(
      process.env.TORRENT_TRACKER_LIST_URL ?? defaultTorrentTrackerListUrl,
    ).trim(),
    torrentTrackerRefreshMs: Math.max(
      60000,
      Math.floor(
        parsePositiveNumber(process.env.TORRENT_TRACKER_REFRESH_MS, defaultTorrentTrackerRefreshMs),
      ),
    ),
    streamTrackerSweepMs: Math.max(
      1000,
      Math.floor(parsePositiveNumber(process.env.STREAM_TRACKER_SWEEP_MS, defaultStreamTrackerSweepMs)),
    ),
    streamTrackerStaleMs: Math.max(
      5000,
      Math.floor(parsePositiveNumber(process.env.STREAM_TRACKER_STALE_MS, defaultStreamTrackerStaleMs)),
    ),
    dbPath: path.join(dataDir, "app.db"),
    adminPassword: process.env.ADMIN_PASSWORD || "change-me-now",
    sessionSecret:
      process.env.SESSION_SECRET ||
      crypto.createHash("sha256").update("bitmagnet-stremio-lab").digest("hex"),
    sessionTtlMs: 1000 * 60 * 60 * 12,
    streamTokenTtlMs: 1000 * 60 * 60 * 4,
    catalogPageSize: 50,
    metadataTimeoutMs: Number(process.env.METADATA_TIMEOUT_MS || 1000 * 30),
    torrentPort: Number(process.env.TORRENT_PORT || 16555),
    torrentMaxConns: Math.max(
      50,
      Math.floor(parsePositiveNumber(process.env.TORRENT_MAX_CONNS, defaultTorrentMaxConns)),
    ),
    timezone: getTimezone(),
    bitmagnetUrl,
    bitmagnetTorznabPath,
    bitmagnetApiKey: process.env.BITMAGNET_API_KEY || "",
    bitmagnetWebUiUrl: process.env.BITMAGNET_WEBUI_URL || bitmagnetUrl,
  };
}

module.exports = {
  getConfig,
};
