# AGENTS.md

## What this is

Bitlab is a Stremio addon that searches a live bitmagnet torrent index and streams selected magnets through WebTorrent. It includes an admin panel for managing addon keys and monitoring streams.

## Tech stack

- **Node.js CommonJS** (`"type": "commonjs"` in package.json). All `require()` / `module.exports`.
- **Express 5** (`express@^5.2.1`) — note: Express 5, not 4. Route error handling and async behavior differ.
- **better-sqlite3** — synchronous SQLite bindings, WAL mode enabled at startup.
- **WebTorrent** — dynamically imported via `import("webtorrent")` (ESM-only package loaded at runtime).
- **stremio-addon-sdk** — addon manifest and handler registration via `addonBuilder`.
- **ffmpeg** — required at runtime for generating status videos (blocked/paused/limit messages). Must be on PATH.

## Commands

```bash
npm start          # Run the server (node src/index.js)
npm run check      # Syntax check only (node --check src/index.js)
```

There are **no test, lint, typecheck, or build scripts**. The `check` command only verifies syntax — it does not run any logic.

## Architecture

```
src/index.js        ← Entry point. Express app, admin routes, playback routes, stream tracking.
src/config.js       ← All config from env vars. Single getConfig() call, no validation library.
src/db.js           ← SQLite schema + all prepared statements. Migrations via ensureColumn().
src/stremio.js      ← Stremio addon builder, meta/stream handlers, media caching, search orchestration.
src/bitmagnet.js    ← Bitmagnet Torznab + GraphQL API client. Groups results by media identity.
src/torrent.js      ← WebTorrent client lifecycle, cache management, streaming to HTTP responses.
src/auth.js         ← HMAC-based session and playback tokens. No external auth library.
src/classify.js     ← Title normalization, episode parsing, release quality inference, 4K detection.
src/discovery.js    ← Search result curation, scoring, and recommendation logic.
src/views.js        ← Server-side HTML rendering (no template engine). Inline CSS/JS.
src/status-video.js ← ffmpeg video generation for blocked-stream status pages.
```

## Key architectural details

- **No build step.** Run `src/index.js` directly. The `Dockerfile` copies source as-is.
- **Database auto-migrates** on startup. `ensureColumn()` in `db.js` adds missing columns with ALTER TABLE. Schema changes are additive only — there is no migration framework.
- **SQLite path** defaults to `./data/app.db` (relative to CWD). The `data/` directory is created automatically.
- **WebTorrent cache** lives at `/tmp/webtorrent` by default. A background sweep removes idle torrents based on `TORRENT_IDLE_GRACE_MS`.
- **Playback tokens** are HMAC-signed JWTs (custom, not a library). They embed stream metadata and expire after `STREAM_TOKEN_TTL_MS` (default 4h).
- **Stream tracking** is in-memory (`activeStreamsByKey` Map). Not persisted. Server restart clears all active stream state.
- **Stremio addon ID** is `local.bitmagnet-stremio-lab`, version `0.4.3`.
- **Bitmagnet has two search paths**: Torznab XML API (primary) and GraphQL API (for file-level metadata). Both are used and merged.
- **Series pack expansion**: When a series release lacks per-episode files, the addon inspects the torrent metadata to extract individual episodes. This is slow (120s timeout) and happens on-demand.
- **Media IDs**: `bm` prefix = base64url-encoded group identity, `tt`/`tmdb`/`imdb` = external ID lookups.
- **Watch history** auto-deletes entries older than 30 days. Cleanup runs daily.

## Environment variables

All config is loaded from env vars in `src/config.js`. Copy `.env.example` to `.env`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | Yes | `change-me-now` | Admin panel login |
| `SESSION_SECRET` | Yes | derived from hash | Session + playback token signing |
| `PORT` | No | `7000` | Server listen port |
| `BASE_URL` | No | auto-detected | Public URL for addon links |
| `BITMAGNET_URL` | No | `http://bitmagnet:3333` | Bitmagnet API endpoint |
| `BITMAGNET_WEBUI_URL` | No | same as BITMAGNET_URL | Display-only link in admin |
| `TORRENT_CACHE_RESERVE_GB` | No | `20` | Min free space before cache prune |
| `TORRENT_IDLE_GRACE_MS` | No | `120000` | Idle time before torrent removal |
| `TIMEZONE` | No | `UTC` | Display timezone for timestamps |
| `TMDB_API_KEY` | Yes (compose) | — | For bitmagnet metadata enrichment |

## Docker / Compose

The `compose.yaml` defines 4 services:
1. **frontend** — this app (port 7000)
2. **bitmagnet** — torrent indexer (worker mode: http_server, queue_server, dht_crawler)
3. **bitmagnet-auth** — nginx reverse proxy adding basic auth to bitmagnet's API (port 3333)
4. **postgres** — bitmagnet's database (PostgreSQL 18)

Data volumes: `./data/frontend` for app DB, `./cache` for WebTorrent, `/mnt/drive/postgres` for Postgres.

## Gotchas

- **Express 5 async errors**: Unhandled promise rejections in route handlers will crash the process. The addon handlers wrap errors manually.
- **WebTorrent is ESM-only**: It is loaded with dynamic `import()` in `torrent.js`. The rest of the codebase is CommonJS.
- **better-sqlite3 is synchronous**: All DB calls block the event loop. Keep queries fast.
- **No `node_modules` lockfile committed**: Only `package.json`. Run `npm install` before starting locally.
- **ffmpeg must be installed**: The Dockerfile installs it via apt. Locally, you need it on PATH for status video generation.
- **The `data/` directory is gitignored**: Created at runtime. Contains the SQLite DB and generated status videos.
- **Bitmagnet must be running**: The app will start but all search/stream operations will fail if bitmagnet is unreachable.
- **No hot reload**: Changes require restarting the process.
- **Inline HTML views**: All admin UI is rendered as template literals in `src/views.js`. No separate template files.
- **Password hashing**: Uses plain SHA-256 (not bcrypt/argon). This is intentional for simplicity — the admin password comparison uses `hashPassword()` from `auth.js`.
- **Group IDs** (`bm` prefix): These are base64url-encoded JSON containing type, normalized title, year, and optional external IDs. They are not opaque — decoding reveals the search parameters.
