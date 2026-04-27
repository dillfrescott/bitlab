const { extractTitleAndYear, normalizeKey } = require("./classify");
const { parseEpisodeLocal, curateSearchResults } = require("./discovery");
const crypto = require("node:crypto");

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
    },
  };
}

const TORZNAB_CATEGORIES = {
  movie: ["2000", "2010", "2020", "2030", "2040", "2045", "2050", "2060", "2999"],
  series: ["5000", "5010", "5020", "5030", "5040", "5045", "5050", "5060", "5070", "5080", "5090", "5999"],
};

function escapeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? escapeXml(match[1].trim()) : "";
}

function extractAttrs(block) {
  const attrs = {};
  const regex = /<torznab:attr\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*\/?>/gi;
  let match = regex.exec(block);
  while (match) {
    attrs[match[1].toLowerCase()] = escapeXml(match[2]);
    match = regex.exec(block);
  }
  return attrs;
}

function extractEnclosureUrl(block) {
  const match = block.match(/<enclosure\b[^>]*url="([^"]+)"/i);
  return match ? escapeXml(match[1]) : "";
}

function inferInfoHash(attrs, text) {
  if (attrs.infohash) {
    return attrs.infohash.toLowerCase();
  }
  const magnetMatch = String(text || "").match(/btih:([a-fA-F0-9]{40})/);
  if (magnetMatch) {
    return magnetMatch[1].toLowerCase();
  }
  const rawHashMatch = String(text || "").match(/\b([a-fA-F0-9]{40})\b/);
  if (rawHashMatch) {
    return rawHashMatch[1].toLowerCase();
  }
  return "";
}

function pickMagnetUri(fields, infoHash) {
  const candidates = [fields.enclosure, fields.link, fields.guid, fields.magneturl];
  const magnetUri = candidates.find((candidate) => String(candidate || "").startsWith("magnet:?"));
  if (magnetUri) {
    return magnetUri;
  }
  return infoHash ? `magnet:?xt=urn:btih:${infoHash}` : "";
}

function parseItems(xmlText) {
  const blocks = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return blocks
    .map((block) => {
      const attrs = extractAttrs(block);
      const fields = {
        title: extractTag(block, "title"),
        guid: extractTag(block, "guid"),
        link: extractTag(block, "link"),
        enclosure: extractEnclosureUrl(block),
        size: Number(extractTag(block, "size") || attrs.size || 0),
        seeders: Number(attrs.seeders || 0),
        peers: Number(attrs.peers || 0),
        downloads: Number(attrs.downloadvolumefactor || 0),
        magneturl: attrs.magneturl || "",
        imdb: attrs.imdbid || attrs.imdb || "",
        tmdb: attrs.tmdbid || attrs.tmdb || "",
      };
      const infoHash = inferInfoHash(attrs, fields.enclosure || fields.link || fields.guid || fields.title);
      const magnetUri = pickMagnetUri(fields, infoHash);

      if (!fields.title || !magnetUri) {
        return null;
      }

      return {
        title: fields.title,
        infoHash,
        magnetUri,
        sizeBytes: Number.isFinite(fields.size) ? fields.size : 0,
        seeders: Number.isFinite(fields.seeders) ? fields.seeders : 0,
        peers: Number.isFinite(fields.peers) ? fields.peers : 0,
        imdbId: fields.imdb || "",
        tmdbId: fields.tmdb || "",
      };
    })
    .filter(Boolean);
}

function parseMagnetInfoHash(magnetUri) {
  const match = String(magnetUri || "").match(/btih:([a-zA-Z0-9]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function normalizeExternalId(value, prefix) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (prefix === "imdb") {
    return trimmed.replace(/^tt/i, "");
  }
  if (prefix === "tmdb") {
    const match = trimmed.match(/(\d+)/);
    return match ? match[1] : "";
  }
  return trimmed;
}

function buildGroupIdentityKey(type, normalizedKey, year, externalIds = {}) {
  const imdbId = normalizeExternalId(externalIds.imdbId, "imdb");
  const tmdbId = normalizeExternalId(externalIds.tmdbId, "tmdb");
  if (imdbId) {
    return `${type}:imdb:${imdbId}`;
  }
  if (tmdbId) {
    return `${type}:tmdb:${tmdbId}`;
  }
  return `${type}:${normalizedKey}:${year || 0}`;
}

function buildGroupId(type, normalizedKey, year, externalIds = {}) {
  const payload = JSON.stringify({
    type,
    normalizedKey,
    year: year || 0,
    imdbId: normalizeExternalId(externalIds.imdbId, "imdb"),
    tmdbId: normalizeExternalId(externalIds.tmdbId, "tmdb"),
  });
  return `bm${Buffer.from(payload).toString("base64url")}`;
}

function decodeGroupId(id) {
  const raw = String(id || "");
  if (!raw.startsWith("bm")) {
    return null;
  }

  try {
    const decoded = Buffer.from(raw.slice(2), "base64url").toString("utf8");
    const payload = JSON.parse(decoded);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const type = payload.type === "movie" || payload.type === "series" ? payload.type : null;
    const normalizedKey = normalizeKey(payload.normalizedKey || "");
    const year = Number(payload.year) || 0;
    const imdbId = normalizeExternalId(payload.imdbId, "imdb");
    const tmdbId = normalizeExternalId(payload.tmdbId, "tmdb");
    if (!type || !normalizedKey) {
      return null;
    }
    return {
      type,
      normalizedKey,
      year,
      imdbId,
      tmdbId,
    };
  } catch (_error) {
    return null;
  }
}

function buildReleaseId(release) {
  const value = release.infoHash || release.magnetUri || release.releaseName;
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

async function buildSeriesRelease(item) {
  const explicitEpisode =
    Number.isInteger(item.season) && Number.isInteger(item.episode)
      ? { season: item.season, episode: item.episode }
      : null;
  const explicitSeason =
    Number.isInteger(item.season)
      ? { season: item.season }
      : null;

  let episodeParts = explicitEpisode;
  if (!episodeParts) {
    episodeParts = parseEpisodeLocal(item.title);
  }
  if (!episodeParts && item.releaseName && item.releaseName !== item.title) {
    episodeParts = parseEpisodeLocal(item.releaseName);
  }

  const seasonParts = episodeParts || explicitSeason || null;
  return {
    id: buildReleaseId(item),
    releaseName: item.releaseName || item.title,
    magnetUri: item.magnetUri,
    infoHash: item.infoHash,
    sizeBytes: item.sizeBytes,
    season: seasonParts?.season ?? null,
    episode: episodeParts?.episode ?? null,
    seeders: item.seeders,
    fileIndex: Number.isInteger(item.fileIndex) ? item.fileIndex : undefined,
    fileName: item.fileName || undefined,
  };
}

function buildMovieRelease(item) {
  return {
    id: buildReleaseId(item),
    releaseName: item.releaseName || item.title,
    magnetUri: item.magnetUri,
    infoHash: item.infoHash,
    sizeBytes: item.sizeBytes,
    season: null,
    episode: null,
    seeders: item.seeders,
    fileIndex: Number.isInteger(item.fileIndex) ? item.fileIndex : undefined,
    fileName: item.fileName || undefined,
  };
}

async function parseGraphqlReleases(type, payload) {
  const items = payload?.data?.torrentContent?.search?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const releases = [];

    if (type === "series") {
    for (const item of items) {
      const title = String(item?.title || "").trim();
      const magnetUri = String(item?.torrent?.magnetUri || "").trim();
      const infoHash = parseMagnetInfoHash(magnetUri);
      if (!title || !magnetUri) continue;

      const seeders = Number(item?.torrent?.seeders || 0);
      if (seeders <= 0 && !infoHash) continue;

      const torrentFiles = Array.isArray(item?.torrent?.files) ? item.torrent.files : [];
      const videoFiles = torrentFiles
        .filter((file) => isVideoFile(file?.path || ""))
        .map((file) => ({
          index: Number(file?.index),
          name: String(file?.path || "").split(/[\\/]/).pop() || String(file?.path || ""),
          path: String(file?.path || ""),
          sizeBytes: Number(file?.size || 0),
        }));

            const fallbackSize = Number(item?.torrent?.size || 0);
      let extractedImdbId = "";
      let extractedTmdbId = "";
      if (item.content) {
        if (item.content.source === "imdb") extractedImdbId = item.content.id;
        if (item.content.source === "tmdb") extractedTmdbId = item.content.id;
        if (Array.isArray(item.content.attributes)) {
          for (const attr of item.content.attributes) {
            if (attr.source === "imdb" && (attr.key === "id" || attr.key === "imdb_id")) {
              extractedImdbId = attr.value;
            }
            if (attr.source === "tmdb" && (attr.key === "id" || attr.key === "tmdb_id")) {
              extractedTmdbId = attr.value;
            }
          }
        }
      }
      const imdbId = normalizeExternalId(extractedImdbId, "imdb");
      const tmdbId = normalizeExternalId(extractedTmdbId, "tmdb");

      const titleEp = parseEpisodeLocal(title) || { season: null, episode: null };
      const torrentName = String(item?.torrent?.name || "").trim();
      const torrentNameEp = parseEpisodeLocal(torrentName);

      const seasonForFiles =torrentNameEp?.season ?? titleEp.season;

      const videoFilesWithEp = videoFiles.map((file) => {
        const fileEp = parseEpisodeLocal(`${torrentName || title} ${file.path}`);
        return {
          ...file,
          episodeParts: {
            season: fileEp?.season ?? seasonForFiles,
            episode: fileEp?.episode ?? null,
          }
        };
      }).filter(f => f.episodeParts && (f.episodeParts.season !== null || f.episodeParts.episode !== null));

      if (videoFilesWithEp.length > 0) {
        const dedupe = new Set();
        for (const file of videoFilesWithEp) {
          const release = {
            title,
            magnetUri,
            infoHash,
            sizeBytes: file.sizeBytes || fallbackSize,
            seeders,
            releaseName: torrentName || title,
            fileIndex: Number.isInteger(file.index) ? file.index : undefined,
            fileName: file.name,
            season: file.episodeParts.season,
            episode: file.episodeParts.episode,
            imdbId,
            tmdbId,
          };
          const key = `${release.infoHash}:${release.fileIndex ?? -1}:${release.season}:${release.episode}`;
          if (!dedupe.has(key)) {
            dedupe.add(key);
            releases.push(release);
          }
        }
      } else {
        releases.push({
          title,
          magnetUri,
          infoHash,
          sizeBytes: fallbackSize,
          seeders,
          releaseName: String(item?.torrent?.name || title).trim(),
          season: titleEp.season,
          episode: titleEp.episode,
          imdbId,
          tmdbId,
        });
      }
    }
  } else {
    for (const item of items) {
      const title = String(item?.title || "").trim();
      const magnetUri = String(item?.torrent?.magnetUri || "").trim();
      const infoHash = parseMagnetInfoHash(magnetUri);
      if (!title || !magnetUri) continue;
      const seeders = Number(item?.torrent?.seeders || 0);
      if (seeders <= 0 && !infoHash) continue;

      const torrentFiles = Array.isArray(item?.torrent?.files) ? item.torrent.files : [];
      const videoFiles = torrentFiles
        .filter((file) => isVideoFile(file?.path || ""))
        .map((file) => ({
          index: Number(file?.index),
          sizeBytes: Number(file?.size || 0),
        }));

            const fallbackSize = Number(item?.torrent?.size || 0);
      const largestVideoFile = videoFiles.slice().sort((left, right) => right.sizeBytes - left.sizeBytes)[0];

            releases.push({
        title,
        magnetUri,
        infoHash,
        sizeBytes: largestVideoFile?.sizeBytes || fallbackSize,
        seeders,
        releaseName: String(item?.torrent?.name || title).trim(),
        fileIndex: Number.isInteger(largestVideoFile?.index) ? largestVideoFile.index : undefined,
        season: null,
        episode: null,
        imdbId: normalizeExternalId((function() {
          let id = "";
          if (item.content) {
            if (item.content.source === "imdb") id = item.content.id;
            if (Array.isArray(item.content.attributes)) {
              for (const attr of item.content.attributes) {
                if (attr.source === "imdb" && (attr.key === "id" || attr.key === "imdb_id")) id = attr.value;
              }
            }
          }
          return id;
        })(), "imdb"),
        tmdbId: normalizeExternalId((function() {
          let id = "";
          if (item.content) {
            if (item.content.source === "tmdb") id = item.content.id;
            if (Array.isArray(item.content.attributes)) {
              for (const attr of item.content.attributes) {
                if (attr.source === "tmdb" && (attr.key === "id" || attr.key === "tmdb_id")) id = attr.value;
              }
            }
          }
          return id;
        })(), "tmdb"),
      });
    }
  }

  return releases;
}

async function groupGraphqlResults(type, items, options = {}) {
  const groups = new Map();

  for (const item of items) {
    const extracted = extractTitleAndYear(item.title, type === "series");
    const title = extracted.title || item.title;
    const normalizedTitle = normalizeKey(title);
    if (!normalizedTitle) {
      continue;
    }

    const imdbId = normalizeExternalId(item.imdbId, "imdb");
    const tmdbId = normalizeExternalId(item.tmdbId, "tmdb");
    const groupKey = buildGroupIdentityKey(type, normalizedTitle, extracted.year, { imdbId, tmdbId });
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: buildGroupId(type, normalizedTitle, extracted.year, { imdbId, tmdbId }),
        type,
        title,
        normalizedKey: normalizedTitle,
        year: extracted.year || null,
        imdbId,
        tmdbId,
        releases: [],
      });
    }

    const group = groups.get(groupKey);
    if (!group.imdbId) group.imdbId = imdbId;
    if (!group.tmdbId) group.tmdbId = tmdbId;

    const release = type === "series" ? await buildSeriesRelease(item) : buildMovieRelease(item);
    const existing = group.releases.find(
      (r) =>
        r.infoHash === release.infoHash &&
        (r.fileIndex ?? -1) === (release.fileIndex ?? -1) &&
        (r.season ?? -1) === (release.season ?? -1) &&
        (r.episode ?? -1) === (release.episode ?? -1),
    );

    if (existing) {
      existing.seeders = Math.max(existing.seeders || 0, release.seeders || 0);
      if (!existing.fileName && release.fileName) existing.fileName = release.fileName;
      if (!Number.isInteger(existing.fileIndex) && Number.isInteger(release.fileIndex)) {
        existing.fileIndex = release.fileIndex;
      }
    } else {
      group.releases.push(release);
    }
  }

    return Array.from(groups.values())
    .map((group) => ({
      ...group,
      releases: group.releases.sort((left, right) => {
        if (group.type === "series") {
          const leftSeason = Number.isFinite(left.season) ? left.season : Number.MAX_SAFE_INTEGER;
          const rightSeason = Number.isFinite(right.season) ? right.season : Number.MAX_SAFE_INTEGER;
          const leftEpisode = Number.isFinite(left.episode) ? left.episode : Number.MAX_SAFE_INTEGER;
          const rightEpisode = Number.isFinite(right.episode) ? right.episode : Number.MAX_SAFE_INTEGER;
          return leftSeason - rightSeason || leftEpisode - rightEpisode || right.seeders - left.seeders;
        }
        return right.seeders - left.seeders || right.sizeBytes - left.sizeBytes;
      }).slice(0, options.retainAllReleases ? Infinity : 24),
    }))
    .sort((left, right) => right.releases.length - left.releases.length || left.title.localeCompare(right.title));
}


function mergeGroupCollection(groups) {
  const items = Array.isArray(groups) ? groups.filter(Boolean) : [];
  if (items.length === 0) {
    return null;
  }

  const primary = items
    .slice()
    .sort((left, right) => right.releases.length - left.releases.length || left.title.localeCompare(right.title))[0];

  const releases = [];
  const dedupe = new Set();
  for (const group of items) {
    for (const release of group.releases || []) {
      const key = `${release.infoHash || ""}:${release.fileIndex ?? -1}:${release.season ?? -1}:${release.episode ?? -1}:${release.releaseName}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      releases.push(release);
    }
  }

  return {
    ...primary,
    releases: releases.sort((left, right) => {
      const leftSeason = Number.isFinite(left.season) ? left.season : Number.MAX_SAFE_INTEGER;
      const rightSeason = Number.isFinite(right.season) ? right.season : Number.MAX_SAFE_INTEGER;
      const leftEpisode = Number.isFinite(left.episode) ? left.episode : Number.MAX_SAFE_INTEGER;
      const rightEpisode = Number.isFinite(right.episode) ? right.episode : Number.MAX_SAFE_INTEGER;
      return leftSeason - rightSeason || leftEpisode - rightEpisode || right.seeders - left.seeders;
    }),
  };
}

async function groupResults(type, items, options = {}) {
  const groups = new Map();

  for (const item of items) {
    if (type === "series") {
      const extracted = extractTitleAndYear(item.title, true);
      if (!extracted.title) {
        continue;
      }

      const normalizedTitle = normalizeKey(extracted.title);
      if (!normalizedTitle) {
        continue;
      }

      const imdbId = normalizeExternalId(item.imdbId, "imdb");
      const tmdbId = normalizeExternalId(item.tmdbId, "tmdb");
      const groupKey = buildGroupIdentityKey(type, normalizedTitle, extracted.year, { imdbId, tmdbId });
      const release = await buildSeriesRelease(item);

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          id: buildGroupId(type, normalizedTitle, extracted.year, { imdbId, tmdbId }),
          type,
          title: extracted.title,
          normalizedKey: normalizedTitle,
          year: extracted.year || null,
          imdbId,
          tmdbId,
          releases: [],
        });
      }

      const group = groups.get(groupKey);
      if (!group.imdbId) {
        group.imdbId = imdbId;
      }
      if (!group.tmdbId) {
        group.tmdbId = tmdbId;
      }
      const existing = group.releases.find(
        (r) =>
          r.infoHash === release.infoHash &&
          (r.season ?? -1) === (release.season ?? -1) &&
          (r.episode ?? -1) === (release.episode ?? -1) &&
          (r.fileIndex ?? -1) === (release.fileIndex ?? -1),
      );
      if (existing) {
        existing.seeders = Math.max(existing.seeders || 0, release.seeders || 0);
        if (!existing.fileName && release.fileName) existing.fileName = release.fileName;
        if (!Number.isInteger(existing.fileIndex) && Number.isInteger(release.fileIndex)) {
          existing.fileIndex = release.fileIndex;
        }
      } else {
        group.releases.push(release);
      }
      continue;
    }

    const extracted = extractTitleAndYear(item.title, false);
    const title = extracted.title || item.title;
    const normalizedTitle = normalizeKey(title);
    if (!normalizedTitle) {
      continue;
    }

    const imdbId = normalizeExternalId(item.imdbId, "imdb");
    const tmdbId = normalizeExternalId(item.tmdbId, "tmdb");
    const groupKey = buildGroupIdentityKey(type, normalizedTitle, extracted.year, { imdbId, tmdbId });
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: buildGroupId(type, normalizedTitle, extracted.year, { imdbId, tmdbId }),
        type,
        title,
        normalizedKey: normalizedTitle,
        year: extracted.year || null,
        imdbId,
        tmdbId,
        releases: [],
      });
    }

    const group = groups.get(groupKey);
    if (!group.imdbId) {
      group.imdbId = imdbId;
    }
    if (!group.tmdbId) {
      group.tmdbId = tmdbId;
    }

    group.releases.push({
      id: buildReleaseId(item),
      releaseName: item.title,
      magnetUri: item.magnetUri,
      infoHash: item.infoHash,
      sizeBytes: item.sizeBytes,
      season: null,
      episode: null,
      seeders: item.seeders,
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      releases: group.releases
        .sort((left, right) => {
          if (group.type === "series") {
            const leftSeason = Number.isFinite(left.season) ? left.season : Number.MAX_SAFE_INTEGER;
            const rightSeason = Number.isFinite(right.season) ? right.season : Number.MAX_SAFE_INTEGER;
            const leftEpisode = Number.isFinite(left.episode) ? left.episode : Number.MAX_SAFE_INTEGER;
            const rightEpisode = Number.isFinite(right.episode) ? right.episode : Number.MAX_SAFE_INTEGER;
            return leftSeason - rightSeason || leftEpisode - rightEpisode || right.seeders - left.seeders;
          }
          return right.seeders - left.seeders || right.sizeBytes - left.sizeBytes;
        })
        .slice(0, options.retainAllReleases ? Infinity : 12),
    }))
    .sort((left, right) => right.releases.length - left.releases.length || left.title.localeCompare(right.title));
}

function createBitmagnetService(config) {
  const GRAPHQL_SEARCH_QUERY = `
    query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
      torrentContent {
        search(input: $input) {
          items {
            title
            content {
              source
              id
              attributes {
                source
                key
                value
              }
            }
            torrent {
              name
              magnetUri
              size
              seeders
              files {
                path
                size
                index
              }
            }
          }
        }
      }
    }
  `;

  async function fetchWithTimeout(resource, options = {}, label = "bitmagnet-fetch") {
    const timeoutMs = Math.max(5000, Number(config.metadataTimeoutMs || 120000));
    const { signal, clear } = createAbortSignal(timeoutMs);
    try {
      console.log(`[bitmagnet] request start label=${label} timeoutMs=${timeoutMs}`);
      const response = await fetch(resource, {
        ...options,
        signal,
      });
      console.log(`[bitmagnet] request success label=${label} status=${response.status}`);
      return response;
    } catch (error) {
      const detail = error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message;
      console.error(`[bitmagnet] request failed label=${label} error=${JSON.stringify(detail)}`);
      throw error?.name === "AbortError" ? new Error(`${label} timed out after ${timeoutMs}ms`) : error;
    } finally {
      clear();
    }
  }

  function buildTorznabUrl(type, query, limit, externalIds = {}) {
    const url = new URL(config.bitmagnetTorznabPath, config.bitmagnetUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("cat", (TORZNAB_CATEGORIES[type] || []).join(","));

    const hasExternalIds = Boolean(externalIds.imdbId || externalIds.tmdbId);
    if (hasExternalIds) {
      url.searchParams.set("t", type === "series" ? "tvsearch" : "movie");
    } else {
      url.searchParams.set("t", "search");
    }

    if (query) {
      url.searchParams.set("q", query);
    }
    if (externalIds.imdbId) {
      url.searchParams.set("imdbid", normalizeExternalId(externalIds.imdbId, "imdb"));
    }
    if (externalIds.tmdbId) {
      url.searchParams.set("tmdbid", normalizeExternalId(externalIds.tmdbId, "tmdb"));
    }
    if (config.bitmagnetApiKey) {
      url.searchParams.set("apikey", config.bitmagnetApiKey);
    }
    return url;
  }

  async function searchRaw(type, query, limit) {
    const trimmed = String(query || "").trim();
    if (!trimmed) {
      return [];
    }

    const response = await fetchWithTimeout(buildTorznabUrl(type, trimmed, limit), {
      headers: {
        Accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
      },
    }, `torznab-search:${type}:${trimmed}`);

    if (!response.ok) {
      throw new Error(`Bitmagnet search failed with HTTP ${response.status}`);
    }

    const body = await response.text();
    return groupResults(type, parseItems(body));
  }

  async function search(type, query, limit) {
    const trimmed = String(query || "").trim();
    if (!trimmed) {
      return [];
    }

    const grouped = await searchRaw(type, trimmed, limit);
    return (await curateSearchResults(type, trimmed, grouped)).slice(0, limit);
  }

  async function resolveByExternalId(type, ids) {
    const imdbId = normalizeExternalId(ids?.imdbId, "imdb");
    const tmdbId = normalizeExternalId(ids?.tmdbId, "tmdb");
    if (!imdbId && !tmdbId) {
      return null;
    }

    const lookupLimit = 100;
    const torznabResponse = await fetchWithTimeout(buildTorznabUrl(type, "", lookupLimit, { imdbId, tmdbId }), {
      headers: {
        Accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
      },
    }, `torznab-external:${type}:${imdbId || tmdbId}`).catch(() => null);

    let items = [];
    if (torznabResponse && torznabResponse.ok) {
      const body = await torznabResponse.text();
      items = await groupResults(type, parseItems(body), { retainAllReleases: true });
    }

    const graphqlItems = await searchWithFiles(type, imdbId ? `tt${imdbId}` : tmdbId, lookupLimit, { retainAllReleases: true }).catch(() => []);
    const combined = [...items, ...graphqlItems];
    const deduped = [];
    const seenIds = new Set();
    for (const item of combined) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        deduped.push(item);
      }
    }
    items = deduped;

    console.log(
      `[bitmagnet] external-id lookup type=${type} imdb=${JSON.stringify(imdbId || "")} tmdb=${JSON.stringify(tmdbId || "")} groups=${items.length}`,
    );
    if (imdbId) {
      const exactImdb = items.filter((item) => item.imdbId === imdbId);
      if (exactImdb.length > 0) {
        const merged = mergeGroupCollection(exactImdb);
        console.log(
          `[bitmagnet] external-id exact imdb matches=${exactImdb.length} mergedTitle=${JSON.stringify(merged.title)} releases=${merged.releases.length}`,
        );
        return merged;
      }
    }
    if (tmdbId) {
      const exactTmdb = items.filter((item) => item.tmdbId === tmdbId);
      if (exactTmdb.length > 0) {
        const merged = mergeGroupCollection(exactTmdb);
        console.log(
          `[bitmagnet] external-id exact tmdb matches=${exactTmdb.length} mergedTitle=${JSON.stringify(merged.title)} releases=${merged.releases.length}`,
        );
        return merged;
      }
    }
    if (items[0]) {
      console.log(
        `[bitmagnet] external-id fallback title=${JSON.stringify(items[0].title)} releases=${items[0].releases.length} imdb=${JSON.stringify(items[0].imdbId || "")} tmdb=${JSON.stringify(items[0].tmdbId || "")}`,
      );
    }
    return items[0] || null;
  }

  async function resolveByGroupId(type, id) {
    const decoded = decodeGroupId(id);
    if (!decoded || decoded.type !== type) {
      return null;
    }

    if (decoded.imdbId || decoded.tmdbId) {
      return resolveByExternalId(type, decoded);
    }

    const response = await fetchWithTimeout(buildTorznabUrl(type, decoded.normalizedKey, 100), {
      headers: {
        Accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
      },
    }, `torznab-group:${type}:${decoded.normalizedKey}`);

    if (!response.ok) {
      throw new Error(`Bitmagnet group-id lookup failed with HTTP ${response.status}`);
    }

    const body = await response.text();
    const items = await groupResults(type, parseItems(body), { retainAllReleases: true });
    return (
      items.find((item) => item.normalizedKey === decoded.normalizedKey && (item.year || 0) === decoded.year) ||
      null
    );
  }

  async function searchWithFiles(type, query, limit, options = {}) {
    const trimmed = String(query || "").trim();
    if (!trimmed) {
      return [];
    }

    const contentType = type === "series" ? "tv_show" : "movie";
    const response = await fetchWithTimeout(new URL("/graphql", config.bitmagnetUrl), {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: GRAPHQL_SEARCH_QUERY,
        variables: {
          input: {
            queryString: trimmed,
            limit,
            offset: 0,
            cached: true,
            facets: {
              contentType: {
                filter: [contentType],
              },
            },
            orderBy: [
              { field: "seeders", descending: true },
            ],
          },
        },
      }),
    }, `graphql-search:${type}:${trimmed}`);

    if (!response.ok) {
      throw new Error(`Bitmagnet GraphQL search failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    const errors = Array.isArray(payload?.errors) ? payload.errors.map((error) => error?.message).filter(Boolean) : [];
    if (errors.length > 0) {
      throw new Error(`Bitmagnet GraphQL search failed: ${errors.join(", ")}`);
    }

    const grouped = await groupGraphqlResults(type, await parseGraphqlReleases(type, payload), options);
    return (await curateSearchResults(type, trimmed, grouped)).slice(0, limit);
  }

  async function getStatus() {
    const startedAt = new Date().toISOString();
    try {
      const response = await fetchWithTimeout(new URL("/", config.bitmagnetUrl), { redirect: "manual" }, "status");
      return {
        ok: response.status < 500,
        httpStatus: response.status,
        startedAt,
        webUiUrl: config.bitmagnetWebUiUrl,
        torznabUrl: new URL(config.bitmagnetTorznabPath, config.bitmagnetUrl).toString(),
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        startedAt,
        webUiUrl: config.bitmagnetWebUiUrl,
        torznabUrl: new URL(config.bitmagnetTorznabPath, config.bitmagnetUrl).toString(),
        error: error.message,
      };
    }
  }

  return {
    searchRaw,
    search,
    searchWithFiles,
    resolveByExternalId,
    resolveByGroupId,
    getStatus,
  };
}

module.exports = {
  createBitmagnetService,
};
