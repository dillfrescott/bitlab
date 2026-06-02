const fs = require("node:fs");
const Database = require("better-sqlite3");

function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function openDatabase(config) {
  ensureDir(config.dataDir);
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS addon_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      max_concurrent_streams INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT,
      paused_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS key_watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER NOT NULL REFERENCES addon_keys(id) ON DELETE CASCADE,
      playback_token_hash TEXT NOT NULL UNIQUE,
      media_type TEXT,
      media_title TEXT NOT NULL,
      release_name TEXT,
      season INTEGER,
      episode INTEGER,
      file_name TEXT,
      info_hash TEXT,
      watched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn(db, "addon_keys", "max_concurrent_streams", "max_concurrent_streams INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "addon_keys", "last_active_at", "last_active_at TEXT");
  ensureColumn(db, "addon_keys", "paused_at", "paused_at TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_key_watch_history_key_id ON key_watch_history(key_id, watched_at DESC);
  `);

  const stmts = {
    createKey: db.prepare(`
      INSERT INTO addon_keys (name, token, max_concurrent_streams)
      VALUES (?, ?, ?)
    `),
    revokeKey: db.prepare(`
      UPDATE addon_keys
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `),
    getActiveKeys: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, created_at, last_active_at, paused_at
      FROM addon_keys
      WHERE revoked_at IS NULL
      ORDER BY id DESC
    `),
    getRevokedKeys: db.prepare(`
      SELECT id, name, token, created_at, revoked_at
      FROM addon_keys
      WHERE revoked_at IS NOT NULL
      ORDER BY id DESC
      LIMIT 20
    `),
    getKeyByToken: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, created_at, last_active_at, paused_at, revoked_at
      FROM addon_keys
      WHERE token = ?
    `),
    getKeyById: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, created_at, last_active_at, paused_at, revoked_at
      FROM addon_keys
      WHERE id = ?
    `),
    updateKeyLimit: db.prepare(`
      UPDATE addon_keys
      SET max_concurrent_streams = ?
      WHERE id = ? AND revoked_at IS NULL
    `),
    updateKeyLastActive: db.prepare(`
      UPDATE addon_keys
      SET last_active_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `),
    pauseKey: db.prepare(`
      UPDATE addon_keys
      SET paused_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL AND paused_at IS NULL
    `),
    resumeKey: db.prepare(`
      UPDATE addon_keys
      SET paused_at = NULL
      WHERE id = ? AND revoked_at IS NULL
    `),
    renameKey: db.prepare(`
      UPDATE addon_keys
      SET name = ?
      WHERE id = ? AND revoked_at IS NULL
    `),
    clearWatchHistoryForKey: db.prepare(`
      DELETE FROM key_watch_history
      WHERE key_id = ?
    `),
    deleteOldWatchHistory: db.prepare(`
      DELETE FROM key_watch_history
      WHERE watched_at < datetime('now', '-30 days')
    `),
    insertWatchHistory: db.prepare(`
      INSERT OR IGNORE INTO key_watch_history (
        key_id,
        playback_token_hash,
        media_type,
        media_title,
        release_name,
        season,
        episode,
        file_name,
        info_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getWatchHistoryForKey: db.prepare(`
      SELECT
        id,
        playback_token_hash,
        media_type,
        media_title,
        release_name,
        season,
        episode,
        file_name,
        info_hash,
        watched_at
      FROM key_watch_history
      WHERE key_id = ?
        AND watched_at >= datetime('now', '-30 days')
      ORDER BY watched_at DESC, id DESC
      LIMIT ?
    `),
  };

  function createAddonKey(name, token, maxConcurrentStreams = 1) {
    const result = stmts.createKey.run(name, token, maxConcurrentStreams);
    return Number(result.lastInsertRowid);
  }

  function mapKey(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
    };
  }

  const revokeAddonKey = db.transaction((id) => {
    stmts.clearWatchHistoryForKey.run(id);
    stmts.revokeKey.run(id);
  });

  return {
    raw: db,
    createAddonKey,
    revokeKey(id) {
      revokeAddonKey(id);
    },
    getActiveKeys() {
      return stmts.getActiveKeys.all().map(mapKey);
    },
    getRevokedKeys() {
      return stmts.getRevokedKeys.all();
    },
    getKeyByToken(token) {
      return mapKey(stmts.getKeyByToken.get(token));
    },
    getKeyById(id) {
      return mapKey(stmts.getKeyById.get(id));
    },
    updateKeyLimit(id, maxConcurrentStreams) {
      stmts.updateKeyLimit.run(maxConcurrentStreams, id);
    },
    updateKeyLastActive(id) {
      stmts.updateKeyLastActive.run(id);
    },
    pauseKey(id) {
      stmts.pauseKey.run(id);
    },
    resumeKey(id) {
      stmts.resumeKey.run(id);
    },
    renameKey(id, name) {
      stmts.renameKey.run(name, id);
    },
    logWatchHistory(entry) {
      stmts.insertWatchHistory.run(
        entry.keyId,
        entry.playbackTokenHash,
        entry.mediaType || null,
        entry.mediaTitle,
        entry.releaseName || null,
        Number.isInteger(entry.season) ? entry.season : null,
        Number.isInteger(entry.episode) ? entry.episode : null,
        entry.fileName || null,
        entry.infoHash || null,
      );
    },
    getWatchHistoryForKey(keyId, limit = 100) {
      return stmts.getWatchHistoryForKey.all(keyId, limit);
    },
    deleteOldWatchHistory() {
      return stmts.deleteOldWatchHistory.run();
    },
  };
}

module.exports = {
  openDatabase,
};
