const path = require("node:path");

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig() {
  const bitmagnetUrl = process.env.BITMAGNET_URL || "http://bitmagnet:3333";
  const bitmagnetTorznabPath = process.env.BITMAGNET_TORZNAB_PATH || "/torznab/api";
  return {
    port: Number(process.env.PORT || 7000),
    baseUrl: process.env.BASE_URL || "",
    catalogPageSize: 50,
    metadataTimeoutMs: Number(process.env.METADATA_TIMEOUT_MS || 1000 * 30),
    bitmagnetUrl,
    bitmagnetTorznabPath,
    bitmagnetApiKey: process.env.BITMAGNET_API_KEY || "",
  };
}

module.exports = {
  getConfig,
};
