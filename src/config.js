const crypto = require("node:crypto");
const path = require("node:path");

const dataDir = path.resolve(process.cwd(), "data");

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
  const torrserverUrl = process.env.TORRSERVER_URL || "http://localhost:8090";
  return {
    port: Number(process.env.PORT || 7000),
    baseUrl: process.env.BASE_URL || "",
    dataDir,
    dbPath: path.join(dataDir, "app.db"),
    adminPassword: process.env.ADMIN_PASSWORD || "change-me-now",
    sessionSecret: (function() {
      if (process.env.SESSION_SECRET) {
        return process.env.SESSION_SECRET;
      }
      console.warn("[config] WARNING: SESSION_SECRET environment variable is not set. Generating a random, session-scoped secret key.");
      return crypto.randomBytes(32).toString("hex");
    })(),
    sessionTtlMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    streamTokenTtlMs: 1000 * 60 * 60 * 4,
    metadataTimeoutMs: Number(process.env.METADATA_TIMEOUT_MS || 1000 * 30),
    timezone: getTimezone(),
    bitmagnetUrl,
    bitmagnetTorznabPath,
    bitmagnetApiKey: process.env.BITMAGNET_API_KEY || "",
    bitmagnetWebUiUrl: process.env.BITMAGNET_WEBUI_URL || bitmagnetUrl,
    torrserverUrl,
    postgresHost: process.env.POSTGRES_HOST || "postgres",
    postgresPort: Number(process.env.POSTGRES_PORT || 5432),
    postgresDb: process.env.POSTGRES_DB || "bitmagnet",
    postgresUser: process.env.POSTGRES_USER || "postgres",
    postgresPassword: process.env.POSTGRES_PASSWORD || "postgres",
  };
}

module.exports = {
  getConfig,
};
