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
      allow_4k INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
      title TEXT NOT NULL,
      normalized_key TEXT,
      year INTEGER,
      description TEXT,
      poster TEXT,
      background TEXT,
      runtime_minutes INTEGER,
      genres_json TEXT,
      public_domain INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS torrent_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      release_name TEXT NOT NULL,
      magnet_uri TEXT NOT NULL,
      info_hash TEXT,
      file_index INTEGER,
      file_name TEXT,
      size_bytes INTEGER,
      season INTEGER,
      episode INTEGER,
      classification TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crawl_candidates (
      info_hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      classification TEXT,
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      release_count INTEGER NOT NULL DEFAULT 0,
      media_id INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS indexed_media (
      media_key TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
      title TEXT NOT NULL,
      year INTEGER,
      imdb_id TEXT,
      tmdb_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indexed_media_aliases (
      alias_key TEXT PRIMARY KEY,
      media_key TEXT NOT NULL REFERENCES indexed_media(media_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indexed_episode_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_key TEXT NOT NULL REFERENCES indexed_media(media_key) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      release_name TEXT NOT NULL,
      magnet_uri TEXT NOT NULL,
      info_hash TEXT,
      file_index INTEGER,
      file_name TEXT,
      size_bytes INTEGER,
      seeders INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

  `);

  ensureColumn(db, "addon_keys", "max_concurrent_streams", "max_concurrent_streams INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "addon_keys", "allow_4k", "allow_4k INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "addon_keys", "last_active_at", "last_active_at TEXT");
  ensureColumn(db, "addon_keys", "paused_at", "paused_at TEXT");
  ensureColumn(db, "media_items", "normalized_key", "normalized_key TEXT");
  ensureColumn(db, "media_items", "imdb_id", "imdb_id TEXT");
  ensureColumn(db, "media_items", "tmdb_id", "tmdb_id TEXT");
  ensureColumn(db, "torrent_releases", "seeders", "seeders INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "torrent_releases", "classification", "classification TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_key_watch_history_key_id ON key_watch_history(key_id, watched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_type_title ON media_items(type, title);
    CREATE INDEX IF NOT EXISTS idx_media_type_key_year ON media_items(type, normalized_key, year);
    CREATE INDEX IF NOT EXISTS idx_release_media_id ON torrent_releases(media_id);
    CREATE INDEX IF NOT EXISTS idx_release_info_hash ON torrent_releases(info_hash);
    CREATE INDEX IF NOT EXISTS idx_crawl_status_seen ON crawl_candidates(status, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_indexed_alias_media_key ON indexed_media_aliases(media_key);
    CREATE INDEX IF NOT EXISTS idx_indexed_episode_lookup ON indexed_episode_releases(media_key, season, episode);
  `);

  const stmts = {
    createKey: db.prepare(`
      INSERT INTO addon_keys (name, token, max_concurrent_streams, allow_4k)
      VALUES (?, ?, ?, ?)
    `),
    revokeKey: db.prepare(`
      UPDATE addon_keys
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `),
    getActiveKeys: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, allow_4k, created_at, last_active_at, paused_at
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
      SELECT id, name, token, max_concurrent_streams, allow_4k, created_at, last_active_at, paused_at, revoked_at
      FROM addon_keys
      WHERE token = ?
    `),
    getKeyById: db.prepare(`
      SELECT id, name, token, max_concurrent_streams, allow_4k, created_at, last_active_at, paused_at, revoked_at
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
    updateKey4kAccess: db.prepare(`
      UPDATE addon_keys
      SET allow_4k = ?
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
    noteDiscovery: db.prepare(`
      INSERT INTO crawl_candidates (info_hash, source, status)
      VALUES (?, ?, 'queued')
      ON CONFLICT(info_hash) DO UPDATE SET
        source = excluded.source,
        last_seen_at = CURRENT_TIMESTAMP,
        status = CASE
          WHEN crawl_candidates.status IN ('accepted', 'rejected', 'processing') THEN crawl_candidates.status
          ELSE 'queued'
        END
    `),
    selectQueuedCandidate: db.prepare(`
      SELECT *
      FROM crawl_candidates
      WHERE status = 'queued'
      ORDER BY last_seen_at DESC
      LIMIT 1
    `),
    markClaimed: db.prepare(`
      UPDATE crawl_candidates
      SET status = 'processing',
          claimed_at = CURRENT_TIMESTAMP,
          attempt_count = attempt_count + 1
      WHERE info_hash = ?
    `),
    markAccepted: db.prepare(`
      UPDATE crawl_candidates
      SET status = 'accepted',
          classification = ?,
          media_id = ?,
          release_count = ?,
          last_error = NULL,
          last_seen_at = CURRENT_TIMESTAMP
      WHERE info_hash = ?
    `),
    markRejected: db.prepare(`
      UPDATE crawl_candidates
      SET status = 'rejected',
          last_error = ?,
          last_seen_at = CURRENT_TIMESTAMP
      WHERE info_hash = ?
    `),
    markError: db.prepare(`
      UPDATE crawl_candidates
      SET status = 'error',
          last_error = ?,
          last_seen_at = CURRENT_TIMESTAMP
      WHERE info_hash = ?
    `),
    listRecentCandidates: db.prepare(`
      SELECT *
      FROM crawl_candidates
      ORDER BY last_seen_at DESC
      LIMIT 80
    `),
    getCrawlerStats: db.prepare(`
      SELECT
        COUNT(*) AS total_seen,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored,
        (SELECT COUNT(*) FROM media_items) AS indexed_media,
        (SELECT COUNT(*) FROM torrent_releases) AS indexed_releases
      FROM crawl_candidates
    `),
    listMedia: db.prepare(`
      SELECT
        m.*,
        COUNT(r.id) AS release_count
      FROM media_items m
      LEFT JOIN torrent_releases r ON r.media_id = m.id
      GROUP BY m.id
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT 120
    `),
    listMediaBatch: db.prepare(`
      SELECT
        m.*,
        COUNT(r.id) AS release_count
      FROM media_items m
      LEFT JOIN torrent_releases r ON r.media_id = m.id
      GROUP BY m.id
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `),
    searchMedia: db.prepare(`
      SELECT *
      FROM media_items
      WHERE type = ?
        AND (? = '' OR title LIKE ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `),
    getReleasesForMedia: db.prepare(`
      SELECT *
      FROM torrent_releases
      WHERE media_id = ?
      ORDER BY season ASC, episode ASC, size_bytes DESC, id DESC
    `),
    upsertIndexedMedia: db.prepare(`
      INSERT INTO indexed_media (
        media_key, type, title, year, imdb_id, tmdb_id, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(media_key) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        year = excluded.year,
        imdb_id = excluded.imdb_id,
        tmdb_id = excluded.tmdb_id,
        updated_at = CURRENT_TIMESTAMP
    `),
    clearIndexedAliases: db.prepare(`
      DELETE FROM indexed_media_aliases
      WHERE media_key = ?
    `),
    insertIndexedAlias: db.prepare(`
      INSERT OR REPLACE INTO indexed_media_aliases (alias_key, media_key)
      VALUES (?, ?)
    `),
    clearIndexedEpisodeReleases: db.prepare(`
      DELETE FROM indexed_episode_releases
      WHERE media_key = ?
    `),
    insertIndexedEpisodeRelease: db.prepare(`
      INSERT INTO indexed_episode_releases (
        media_key, season, episode, release_name, magnet_uri, info_hash,
        file_index, file_name, size_bytes, seeders
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };

  function createAddonKey(name, token, maxConcurrentStreams = 1, allow4k = false) {
    const result = stmts.createKey.run(name, token, maxConcurrentStreams, allow4k ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  function mapKey(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      allow_4k: Boolean(row.allow_4k),
    };
  }

  function mapMedia(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      public_domain: Boolean(row.public_domain),
      genres: row.genres_json ? JSON.parse(row.genres_json) : [],
    };
  }

  const claimNextCandidate = db.transaction(() => {
    const candidate = stmts.selectQueuedCandidate.get();
    if (!candidate) {
      return null;
    }
    stmts.markClaimed.run(candidate.info_hash);
    return {
      ...candidate,
      status: "processing",
      attempt_count: candidate.attempt_count + 1,
    };
  });

  const revokeAddonKey = db.transaction((id) => {
    stmts.clearWatchHistoryForKey.run(id);
    stmts.revokeKey.run(id);
  });

  const indexResolvedMedia = db.transaction((media, aliases = []) => {
    if (!media || !media.id) {
      return 0;
    }

    stmts.upsertIndexedMedia.run(
      media.id,
      media.type,
      media.title,
      media.year || null,
      media.imdbId || null,
      media.tmdbId || null,
    );

    stmts.clearIndexedAliases.run(media.id);
    for (const aliasKey of Array.from(new Set(aliases.filter(Boolean)))) {
      stmts.insertIndexedAlias.run(aliasKey, media.id);
    }

    stmts.clearIndexedEpisodeReleases.run(media.id);

    let inserted = 0;
    const dedupe = new Set();
    for (const release of media.releases || []) {
      if (!Number.isInteger(release.season) || !Number.isInteger(release.episode)) {
        continue;
      }
      if (!release.magnetUri) {
        continue;
      }
      const key = `${release.infoHash || ""}:${release.fileIndex ?? -1}:${release.season}:${release.episode}:${release.releaseName || ""}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      stmts.insertIndexedEpisodeRelease.run(
        media.id,
        release.season,
        release.episode,
        release.releaseName || media.title,
        release.magnetUri,
        release.infoHash || null,
        Number.isInteger(release.fileIndex) ? release.fileIndex : null,
        release.fileName || null,
        Number.isFinite(release.sizeBytes) ? release.sizeBytes : null,
        Number.isFinite(release.seeders) ? release.seeders : 0,
      );
      inserted += 1;
    }

    return inserted;
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
    updateKey4kAccess(id, allow4k) {
      stmts.updateKey4kAccess.run(allow4k ? 1 : 0, id);
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
    noteDiscovery(infoHash, source) {
      stmts.noteDiscovery.run(infoHash, source);
    },
    claimNextCandidate,
    markCandidateAccepted(infoHash, classification, mediaId, releaseCount) {
      stmts.markAccepted.run(classification, mediaId, releaseCount, infoHash);
    },
    markCandidateRejected(infoHash, reason) {
      stmts.markRejected.run(reason, infoHash);
    },
    markCandidateError(infoHash, errorMessage) {
      stmts.markError.run(errorMessage, infoHash);
    },
    listRecentCandidates() {
      return stmts.listRecentCandidates.all();
    },
    getCrawlerStats() {
      const row = stmts.getCrawlerStats.get() || {};
      return {
        totalSeen: row.total_seen || 0,
        queued: row.queued || 0,
        processing: row.processing || 0,
        accepted: row.accepted || 0,
        rejected: row.rejected || 0,
        errored: row.errored || 0,
        indexedMedia: row.indexed_media || 0,
        indexedReleases: row.indexed_releases || 0,
      };
    },
    listMedia() {
      return stmts.listMedia.all().map(mapMedia);
    },
    listMediaBatch(limit = 120, offset = 0) {
      return stmts.listMediaBatch.all(limit, offset).map(mapMedia);
    },
    searchMedia(type, query, limit) {
      const like = `%${query}%`;
      return stmts.searchMedia.all(type, query, like, limit).map(mapMedia);
    },
    getReleasesForMedia(mediaId) {
      return stmts.getReleasesForMedia.all(mediaId);
    },
    indexResolvedMedia(media, aliases = []) {
      return indexResolvedMedia(media, aliases);
    },
  };
}

module.exports = {
  openDatabase,
};
