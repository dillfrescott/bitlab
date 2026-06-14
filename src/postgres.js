const { Client } = require("pg");
const fs = require("node:fs/promises");

/**
 * Formats bytes into a human-readable format like "23G", "60G", "45.2M".
 * @param {number} bytes 
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || isNaN(bytes)) return "0B";
  if (bytes === 0) return "0B";
  const k = 1024;
  const sizes = ["B", "K", "M", "G", "T", "P"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))}${sizes[i]}`;
}

/**
 * Fetches database size from PostgreSQL.
 * @param {object} config 
 * @returns {Promise<number|null>} database size in bytes, or null if failed
 */
async function getDbSizeBytes(config) {
  const client = new Client({
    host: config.postgresHost,
    port: config.postgresPort,
    database: config.postgresDb,
    user: config.postgresUser,
    password: config.postgresPassword,
    connectionTimeoutMillis: 4000,
  });

  try {
    await client.connect();
    const res = await client.query("SELECT pg_database_size($1) AS size", [config.postgresDb]);
    if (res.rows && res.rows[0]) {
      return parseInt(res.rows[0].size, 10);
    }
  } catch (error) {
    console.error("[postgres] failed to query database size:", error.message);
  } finally {
    await client.end().catch(() => {});
  }
  return null;
}

/**
 * Fetches volume statistics using fs.statfs.
 * @returns {Promise<{ totalBytes: number, freeBytes: number, freePercent: number }|null>}
 */
async function getDiskStats() {
  const paths = [];
  if (process.env.POSTGRES_VOLUME_PATH) {
    paths.push(process.env.POSTGRES_VOLUME_PATH);
  }
  paths.push("/postgres_volume", "/app/data", ".");

  for (const p of paths) {
    try {
      await fs.access(p);
      const stats = await fs.statfs(p);
      const totalBytes = Number(stats.blocks) * stats.bsize;
      const freeBytes = Number(stats.bavail) * stats.bsize;
      const freePercent = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0;
      return {
        totalBytes,
        freeBytes,
        freePercent,
      };
    } catch (err) {
      // Try next path
    }
  }
  return null;
}

/**
 * Main query to get combined postgres stats
 * @param {object} config 
 * @returns {Promise<{ dbSizeFormatted: string, volumeTotalFormatted: string, freePercent: number, hasStats: boolean }>}
 */
async function getPostgresStats(config) {
  const [dbSizeBytes, diskStats] = await Promise.all([
    getDbSizeBytes(config),
    getDiskStats(),
  ]);

  const stats = {
    dbSizeFormatted: dbSizeBytes !== null ? formatBytes(dbSizeBytes) : "N/A",
    volumeTotalFormatted: diskStats ? formatBytes(diskStats.totalBytes) : "N/A",
    freePercent: diskStats ? diskStats.freePercent : 0,
    hasStats: dbSizeBytes !== null || diskStats !== null,
  };

  return stats;
}

module.exports = {
  getPostgresStats,
};
