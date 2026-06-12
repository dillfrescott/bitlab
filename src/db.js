const fs = require("node:fs");
const crypto = require("node:crypto");
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
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS addon_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      max_concurrent_streams INTEGER NOT NULL DEFAULT 1,
      bandwidth_used INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bandwidth_limit INTEGER NOT NULL DEFAULT 107374182400, -- 100 GB default
      bandwidth_used INTEGER NOT NULL DEFAULT 0,
      bandwidth_reset_at TEXT NOT NULL,
      is_suspended INTEGER NOT NULL DEFAULT 0,
      max_keys INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Untitled Session',
      user_agent TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    );
  `);

  ensureColumn(db, "addon_keys", "max_concurrent_streams", "max_concurrent_streams INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "addon_keys", "last_active_at", "last_active_at TEXT");
  ensureColumn(db, "addon_keys", "paused_at", "paused_at TEXT");
  ensureColumn(db, "addon_keys", "user_id", "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  ensureColumn(db, "users", "max_keys", "max_keys INTEGER NOT NULL DEFAULT 5");
  ensureColumn(db, "addon_keys", "bandwidth_used", "bandwidth_used INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "user_sessions", "name", "name TEXT NOT NULL DEFAULT 'Untitled Session'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_key_watch_history_key_id ON key_watch_history(key_id, watched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_addon_keys_user_id ON addon_keys(user_id);
  `);

  const stmts = {
    createKey: db.prepare(`
      INSERT INTO addon_keys (name, token, max_concurrent_streams)
      VALUES (?, ?, ?)
    `),
    createKeyWithUser: db.prepare(`
      INSERT INTO addon_keys (name, token, max_concurrent_streams, user_id)
      VALUES (?, ?, ?, ?)
    `),
    revokeKey: db.prepare(`
      UPDATE addon_keys
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `),
    getActiveKeys: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, bandwidth_used, created_at, last_active_at, paused_at, user_id
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
      SELECT id, name, token, max_concurrent_streams, bandwidth_used, created_at, last_active_at, paused_at, revoked_at, user_id
      FROM addon_keys
      WHERE token = ?
    `),
    getKeyById: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, bandwidth_used, created_at, last_active_at, paused_at, revoked_at, user_id
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

  function createAddonKey(name, token, maxConcurrentStreams = 1, userId = null) {
    if (userId !== null) {
      const result = stmts.createKeyWithUser.run(name, token, maxConcurrentStreams, userId);
      return Number(result.lastInsertRowid);
    }
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
    createSession(token, name, userAgent, ipAddress) {
      return db.prepare(`
        INSERT INTO admin_sessions (token, name, user_agent, ip_address)
        VALUES (?, ?, ?, ?)
      `).run(token, name, userAgent, ipAddress);
    },
    getSessionByToken(token) {
      return db.prepare(`
        SELECT id, token, name, user_agent, ip_address, created_at, last_active_at, revoked_at
        FROM admin_sessions
        WHERE token = ?
      `).get(token);
    },
    getSessionById(id) {
      return db.prepare(`
        SELECT id, token, name, user_agent, ip_address, created_at, last_active_at, revoked_at
        FROM admin_sessions
        WHERE id = ?
      `).get(id);
    },
    getActiveSessions() {
      return db.prepare(`
        SELECT id, token, name, user_agent, ip_address, created_at, last_active_at
        FROM admin_sessions
        WHERE revoked_at IS NULL
        ORDER BY last_active_at DESC
      `).all();
    },
    renameSession(id, name) {
      return db.prepare(`
        UPDATE admin_sessions
        SET name = ?
        WHERE id = ? AND revoked_at IS NULL
      `).run(name, id);
    },
    revokeSession(id) {
      return db.prepare(`
        UPDATE admin_sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revoked_at IS NULL
      `).run(id);
    },
    updateSessionLastActive(token) {
      return db.prepare(`
        UPDATE admin_sessions
        SET last_active_at = CURRENT_TIMESTAMP
        WHERE token = ? AND revoked_at IS NULL
      `).run(token);
    },

    // --- USER MANAGEMENT FUNCTIONS ---
    checkAndResetBandwidth(user) {
      const now = new Date();
      let resetDate = new Date(user.bandwidth_reset_at);
      if (isNaN(resetDate.getTime())) {
        resetDate = new Date();
        resetDate.setMonth(resetDate.getMonth() + 1);
      }

      if (now >= resetDate) {
        while (now >= resetDate) {
          resetDate.setMonth(resetDate.getMonth() + 1);
        }
        const newResetAt = resetDate.toISOString();
        db.prepare(`
          UPDATE users
          SET bandwidth_used = 0, bandwidth_reset_at = ?
          WHERE id = ?
        `).run(newResetAt, user.id);
        user.bandwidth_used = 0;
        user.bandwidth_reset_at = newResetAt;
      }
    },

    createUser(username, passwordHash, bandwidthLimitBytes, maxKeys = 5) {
      const resetDate = new Date();
      resetDate.setMonth(resetDate.getMonth() + 1);
      const resetAt = resetDate.toISOString();

      const result = db.prepare(`
        INSERT INTO users (username, password_hash, bandwidth_limit, bandwidth_reset_at, max_keys)
        VALUES (?, ?, ?, ?, ?)
      `).run(username, passwordHash, bandwidthLimitBytes, resetAt, maxKeys);

      return Number(result.lastInsertRowid);
    },

    deleteUser(id) {
      const runTransaction = db.transaction(() => {
        db.prepare(`
          DELETE FROM key_watch_history
          WHERE key_id IN (SELECT id FROM addon_keys WHERE user_id = ?)
        `).run(id);
        db.prepare(`DELETE FROM addon_keys WHERE user_id = ?`).run(id);
        db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
      });
      return runTransaction();
    },

    suspendUser(id) {
      return db.prepare(`
        UPDATE users
        SET is_suspended = 1
        WHERE id = ?
      `).run(id);
    },

    unsuspendUser(id) {
      return db.prepare(`
        UPDATE users
        SET is_suspended = 0
        WHERE id = ?
      `).run(id);
    },

    resetUserBandwidth(id) {
      return db.prepare(`
        UPDATE users
        SET bandwidth_used = 0
        WHERE id = ?
      `).run(id);
    },

    setUserLimits(id, limitBytes, maxKeys) {
      return db.prepare(`
        UPDATE users
        SET bandwidth_limit = ?, max_keys = ?
        WHERE id = ?
      `).run(limitBytes, maxKeys, id);
    },

    setUserPassword(id, passwordHash) {
      return db.prepare(`
        UPDATE users
        SET password_hash = ?
        WHERE id = ?
      `).run(passwordHash, id);
    },

    getUserById(id) {
      const user = db.prepare(`
        SELECT id, username, password_hash, bandwidth_limit, bandwidth_used, bandwidth_reset_at, is_suspended, created_at, max_keys
        FROM users
        WHERE id = ?
      `).get(id);
      if (user) {
        this.checkAndResetBandwidth(user);
      }
      return user;
    },

    getUserByUsername(username) {
      const user = db.prepare(`
        SELECT id, username, password_hash, bandwidth_limit, bandwidth_used, bandwidth_reset_at, is_suspended, created_at, max_keys
        FROM users
        WHERE username = ?
      `).get(username);
      if (user) {
        this.checkAndResetBandwidth(user);
      }
      return user;
    },

    getUserKey(userId) {
      return db.prepare(`
        SELECT id, name, token, max_concurrent_streams, bandwidth_used, created_at, last_active_at, paused_at, revoked_at
        FROM addon_keys
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `).get(userId);
    },

    getUserKeys(userId) {
      return db.prepare(`
        SELECT id, name, token, max_concurrent_streams, bandwidth_used, created_at, last_active_at, paused_at, revoked_at, user_id
        FROM addon_keys
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY id DESC
      `).all(userId);
    },

    createUserKey(userId, name) {
      const token = crypto.randomBytes(24).toString("base64url");
      return db.prepare(`
        INSERT INTO addon_keys (name, token, max_concurrent_streams, user_id)
        VALUES (?, ?, 1, ?)
      `).run(name, token, userId);
    },

    pauseUserKey(keyId, userId) {
      return db.prepare(`
        UPDATE addon_keys
        SET paused_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND paused_at IS NULL
      `).run(keyId, userId);
    },

    resumeUserKey(keyId, userId) {
      return db.prepare(`
        UPDATE addon_keys
        SET paused_at = NULL
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(keyId, userId);
    },

    revokeUserKey(keyId, userId) {
      return db.prepare(`
        UPDATE addon_keys
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(keyId, userId);
    },

    renameUserKey(keyId, userId, name) {
      return db.prepare(`
        UPDATE addon_keys
        SET name = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(name, keyId, userId);
    },

    reRollUserKey(userId) {
      const newToken = crypto.randomBytes(24).toString("base64url");
      return db.prepare(`
        UPDATE addon_keys
        SET token = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(newToken, userId);
    },

    incrementBandwidth(userId, keyId, bytes) {
      const runTransaction = db.transaction(() => {
        db.prepare(`
          UPDATE users
          SET bandwidth_used = bandwidth_used + ?
          WHERE id = ?
        `).run(bytes, userId);

        db.prepare(`
          UPDATE addon_keys
          SET bandwidth_used = bandwidth_used + ?
          WHERE id = ?
        `).run(bytes, keyId);
      });
      return runTransaction();
    },

    incrementUserBandwidth(userId, bytes) {
      return db.prepare(`
        UPDATE users
        SET bandwidth_used = bandwidth_used + ?
        WHERE id = ?
      `).run(bytes, userId);
    },

    getWatchHistoryForUser(userId, limit) {
      return db.prepare(`
        SELECT h.id, h.playback_token_hash, h.media_type, h.media_title, h.release_name, h.season, h.episode, h.file_name, h.info_hash, h.watched_at
        FROM key_watch_history h
        JOIN addon_keys k ON h.key_id = k.id
        WHERE k.user_id = ? AND k.revoked_at IS NULL
          AND h.watched_at >= datetime('now', '-30 days')
        ORDER BY h.watched_at DESC, h.id DESC
        LIMIT ?
      `).all(userId, limit);
    },

    getAllUsers() {
      const users = db.prepare(`
        SELECT id, username, bandwidth_limit, bandwidth_used, bandwidth_reset_at, is_suspended, created_at, max_keys
        FROM users
        ORDER BY id DESC
      `).all();
      
      for (const user of users) {
        this.checkAndResetBandwidth(user);
      }
      return users;
    },

    createUserSession(token, userId, name, userAgent, ipAddress) {
      return db.prepare(`
        INSERT INTO user_sessions (token, user_id, name, user_agent, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, userId, name, userAgent, ipAddress);
    },

    getUserSessionByToken(token) {
      return db.prepare(`
        SELECT id, token, user_id, name, user_agent, ip_address, created_at, last_active_at, revoked_at
        FROM user_sessions
        WHERE token = ?
      `).get(token);
    },

    getUserSessionById(id) {
      return db.prepare(`
        SELECT id, token, user_id, name, user_agent, ip_address, created_at, last_active_at, revoked_at
        FROM user_sessions
        WHERE id = ?
      `).get(id);
    },

    getActiveUserSessions(userId) {
      return db.prepare(`
        SELECT id, token, name, user_agent, ip_address, created_at, last_active_at
        FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY last_active_at DESC
      `).all(userId);
    },

    renameUserSession(id, userId, name) {
      return db.prepare(`
        UPDATE user_sessions
        SET name = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `).run(name, id, userId);
    },

    revokeUserSession(id, userId = null) {
      if (userId !== null) {
        return db.prepare(`
          UPDATE user_sessions
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        `).run(id, userId);
      } else {
        return db.prepare(`
          UPDATE user_sessions
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE id = ? AND revoked_at IS NULL
        `).run(id);
      }
    },

    updateUserSessionLastActive(token) {
      return db.prepare(`
        UPDATE user_sessions
        SET last_active_at = CURRENT_TIMESTAMP
        WHERE token = ? AND revoked_at IS NULL
      `).run(token);
    }
  };
}

module.exports = {
  openDatabase,
};
