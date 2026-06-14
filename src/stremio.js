const { addonBuilder } = require("stremio-addon-sdk");
const {
  normalizeKey,
  buildTitleSearchAliases,
  inferReleaseQuality,
  buildSeriesReleaseLabel,
} = require("./classify");
const {
  orchestrateSearch,
} = require("./discovery");
const { getTrackers } = require("./trackers");

const CACHE_TTL_MS = 1000 * 60 * 30;
const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";

function pruneCache(cache) {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function cacheMedia(cache, media) {
  if (!media?.id) return;
  const existingEntry = getCachedMedia(cache, media.id);
  const value = existingEntry ? mergeMediaObjects(existingEntry, media) : media;
  cache.set(media.id, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function mergeMediaObjects(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;

  const mergedReleases = mergeReleaseLists(existing.releases || [], candidate.releases || []);

  return {
    ...existing,
    ...candidate,
    id: existing.id || candidate.id,
    imdbId: existing.imdbId || candidate.imdbId,
    tmdbId: existing.tmdbId || candidate.tmdbId,
    releases: mergedReleases,
  };
}

function cacheMediaAliases(cache, media) {
  if (!media) return;
  cacheMedia(cache, media);
  if (media.imdbId) {
    const aliasMedia = { ...media, id: `tt${String(media.imdbId).replace(/^tt/i, "")}` };
    cacheMedia(cache, aliasMedia);
  }
  if (media.tmdbId) {
    const tmdbId = String(media.tmdbId);
    cacheMedia(cache, { ...media, id: `tmdb:${tmdbId}` });
    cacheMedia(cache, { ...media, id: `tmdb${tmdbId}` });
  }
}

function getCachedMedia(cache, id) {
  pruneCache(cache);
  const entry = cache.get(id);
  return entry ? entry.value : null;
}

function invalidateCachedMedia(cache, media) {
  if (!media) return;
  if (media.id) cache.delete(media.id);
  if (media.imdbId) cache.delete(`tt${String(media.imdbId).replace(/^tt/i, "")}`);
  if (media.tmdbId) {
    const tmdbId = String(media.tmdbId);
    cache.delete(`tmdb:${tmdbId}`);
    cache.delete(`tmdb${tmdbId}`);
  }
}

function normalizeRecommendationTitle(title) {
  return normalizeKey(String(title || "")).replace(/\b(s\d{1,2}e\d{1,3}|season \d{1,2}|episode \d{1,3})\b/g, "").replace(/\s+/g, " ").trim();
}

function buildSeriesVideoId(mediaId, release) {
  if (!Number.isInteger(release.season) || !Number.isInteger(release.episode)) {
    return null;
  }
  return `${mediaId}:${release.season}:${release.episode}`;
}

function listSeriesVideos(item) {
  const videos = [];
  const seen = new Set();

  for (const release of item.releases) {
    const videoId = buildSeriesVideoId(item.id, release);
    if (!videoId || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    videos.push({
      id: videoId,
      title: release.fileName || release.releaseName || buildSeriesReleaseLabel(item.title, release),
      season: release.season,
      episode: release.episode,
      released: item.year ? `${item.year}-01-01T00:00:00.000Z` : undefined,
    });
  }

  return videos;
}

function toMeta(item) {
  const videos = item.type === "series" ? listSeriesVideos(item) : undefined;

  const topRelease = item.releases[0];
  return {
    id: item.id,
    type: item.type,
    name: item.title,
    description: `bitmagnet result with ${item.releases.length} release(s).`,
    releaseInfo: item.year ? String(item.year) : undefined,
    runtime: undefined,
    videos,
    imdb_id: item.imdbId ? `tt${item.imdbId}` : undefined,
    behaviorHints: {
      defaultVideoId: item.type === "movie" && topRelease ? `${item.id}:${topRelease.id}` : undefined,
    },
  };
}

function getReleaseResolutionRank(release) {
  const quality = inferReleaseQuality(release);
  switch (quality) {
    case "4K":
    case "2160P":
      return 4;
    case "1080P":
      return 3;
    case "720P":
      return 2;
    case "480P":
      return 1;
    default:
      return 0;
  }
}

function formatStreamTitle(release, options = {}) {
  const quality = inferReleaseQuality(release);
  const sizeGiB =
    release.sizeBytes && Number.isFinite(release.sizeBytes)
      ? `${(release.sizeBytes / (1024 ** 3)).toFixed(2)} GiB`
      : null;
  const seeders = Number.isFinite(release.seeders) ? release.seeders : 0;
  const lines = [];

  lines.push(options.mediaTitle || release.fileName || release.releaseName || "Unknown Release");

  const details = [quality, `Seeders: ${seeders}`];
  if (sizeGiB) {
    details.push(sizeGiB);
  }
  lines.push(details.join(" | "));

  if (options.mediaType === "series") {
    const s = Number.isInteger(options.season) ? options.season : release.season;
    const e = Number.isInteger(options.episode) ? options.episode : release.episode;
    if (Number.isInteger(s) || Number.isInteger(e)) {
      const parts = [];
      if (Number.isInteger(s)) parts.push(`Season ${s}`);
      if (Number.isInteger(e)) parts.push(`Episode ${e}`);
      lines.push(parts.join(" | "));
    }
  }

  return lines.filter(Boolean).join("\n");
}

function sortReleases(releases) {
  return releases.slice().sort((left, right) =>
    getReleaseResolutionRank(right) - getReleaseResolutionRank(left) ||
    ((Number.isFinite(right.seeders) ? right.seeders : 0) - (Number.isFinite(left.seeders) ? left.seeders : 0)) ||
    ((Number.isFinite(right.sizeBytes) ? right.sizeBytes : 0) - (Number.isFinite(left.sizeBytes) ? left.sizeBytes : 0)));
}

function hasDisplayableSeeders(release, options = {}) {
  // Always show a release if it has a resolvable infoHash — even with 0 seeders.
  // Local bitmagnet indexes often report 0 seeders for torrents that are still
  // reachable via DHT or PEX, so suppressing them causes infinite loading.
  const infoHash = release?.infoHash ||
    String(release?.magnetUri || "").match(/btih:([a-fA-F0-9]+)/i)?.[1];
  if (infoHash) {
    return true;
  }
  const seeders = (Number.isFinite(release?.seeders) ? release.seeders : 0);
  if (options.lenient) {
    return seeders >= 0;
  }
  return seeders >= 1;
}


function getReleaseIdentityKey(release) {
  const rawId = release.infoHash || release.magnetUri || release.releaseName || "";
  const sourceId = String(rawId).toLowerCase();
  const season = Number.isInteger(release.season) ? release.season : -1;
  const episode = Number.isInteger(release.episode) ? release.episode : -1;

  if (season !== -1 || episode !== -1) {
    return `${sourceId}:${season}:${episode}`;
  }

  return sourceId;
}

function mergeReleases(existing, candidate) {
  const merged = { ...existing };

  const existingSeeders = Number.isFinite(existing.seeders) ? existing.seeders : 0;
  const candidateSeeders = Number.isFinite(candidate.seeders) ? candidate.seeders : 0;
  merged.seeders = Math.max(existingSeeders, candidateSeeders);

  if (!Number.isInteger(merged.fileIndex) && Number.isInteger(candidate.fileIndex)) {
    merged.fileIndex = candidate.fileIndex;
  }
  if (!merged.fileName && candidate.fileName) {
    merged.fileName = candidate.fileName;
  }
  if ((!merged.sizeBytes || merged.sizeBytes <= 0) && candidate.sizeBytes > 0) {
    merged.sizeBytes = candidate.sizeBytes;
  }


  if (!merged.id && candidate.id) merged.id = candidate.id;
  if (!merged.infoHash && candidate.infoHash) merged.infoHash = candidate.infoHash;
  if (!merged.magnetUri && candidate.magnetUri) merged.magnetUri = candidate.magnetUri;

  return merged;
}

function dedupeReleases(releases) {
  const deduped = new Map();

  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release) {
      continue;
    }
    const key = getReleaseIdentityKey(release);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeReleases(existing, release) : release);
  }

  return Array.from(deduped.values());
}

function releaseMatchesEpisodeRequest(release, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) {
    return true;
  }

  if (Number.isInteger(release.season) && Number.isInteger(release.episode)) {
    if (release.season === season && release.episode === episode) {
      return true;
    }
  }

  if (Number.isInteger(release.season) && release.season === season && !Number.isInteger(release.episode)) {
    return true;
  }

  if (!Number.isInteger(release.season) && Number.isInteger(release.episode)) {
    if (release.episode === episode) {
      return true;
    }
  }

  return false;
}

function buildEpisodeSearchQueries(title, season, episode) {
  const paddedSeason = String(season).padStart(2, "0");
  const paddedEpisode = String(episode).padStart(2, "0");
  const baseTitles = Array.from(new Set(
    buildTitleSearchAliases(title).flatMap((candidate) => {
      const cleanedTitle = String(candidate || "")
        .replace(/[:'".,!?()[\]{}_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return [
        String(candidate || "").trim(),
        cleanedTitle,
        cleanedTitle.replace(/\bjourney s\b/gi, "journeys").trim(),
      ].filter(Boolean);
    }),
  ));
  const episodeTokens = [
    `S${paddedSeason}E${paddedEpisode}`,
    `${season}x${paddedEpisode}`,
    `Season ${paddedSeason}`,
    `Season ${season}`,
  ];

  const queries = [];
  for (const baseTitle of baseTitles) {
    for (const episodeToken of episodeTokens) {
      queries.push(`${baseTitle} ${episodeToken}`.trim());
    }
    queries.push(baseTitle);
  }

  return Array.from(new Set(queries));
}

function parseStreamRequestId(id, type) {
  const raw = String(id || "");
  if (type === "series") {
    const episodeMatch = raw.match(/^(.*):(\d{1,3}):(\d{1,3})$/);
    if (episodeMatch) {
      return {
        mediaId: episodeMatch[1],
        releaseId: "",
        season: Number(episodeMatch[2]),
        episode: Number(episodeMatch[3]),
      };
    }
    return {
      mediaId: "",
      releaseId: "",
      season: null,
      episode: null,
    };
  }
  // For movies, Stremio sends the defaultVideoId as the stream id.
  // defaultVideoId is built as `${mediaId}:${releaseId}`, so we need to
  // split on the LAST colon-separated segment that looks like a release UUID
  // (not a tmdb: prefix or tt-style id). A release ID from bitmagnet is a
  // non-numeric, non-imdb segment after the media identifier.
  //
  // Supported patterns:
  //   bm<uuid>:<releaseId>          → split at first colon
  //   tt<digits>:<releaseId>        → split at first colon
  //   tmdb:<digits>:<releaseId>     → split at second colon (skip the tmdb: prefix)
  //   <mediaId>                     → no release, use as-is
  if (raw.startsWith("bm") && raw.includes(":")) {
    const separatorIndex = raw.indexOf(":");
    return {
      mediaId: raw.slice(0, separatorIndex),
      releaseId: raw.slice(separatorIndex + 1),
      season: null,
      episode: null,
    };
  }
  if (/^tt\d+:.+$/i.test(raw)) {
    const separatorIndex = raw.indexOf(":");
    return {
      mediaId: raw.slice(0, separatorIndex),
      releaseId: raw.slice(separatorIndex + 1),
      season: null,
      episode: null,
    };
  }
  // tmdb:<digits>:<releaseId> — skip the tmdb: prefix, split on the next colon
  const tmdbWithRelease = raw.match(/^(tmdb:\d+):(.+)$/i);
  if (tmdbWithRelease) {
    return {
      mediaId: tmdbWithRelease[1],
      releaseId: tmdbWithRelease[2],
      season: null,
      episode: null,
    };
  }
  return {
    mediaId: raw,
    releaseId: "",
    season: null,
    episode: null,
  };
}

function parseExternalIds(id) {
  const raw = String(id || "");
  if (/^tt\d+$/i.test(raw)) {
    return { imdbId: raw.replace(/^tt/i, "") };
  }
  const imdbMatch = raw.match(/^imdb:(tt\d+)$/i);
  if (imdbMatch) {
    return { imdbId: imdbMatch[1].replace(/^tt/i, "") };
  }
  const tmdbMatch = raw.match(/^tmdb:(?:movie|series):(\d+)$/i) || raw.match(/^tmdb[:]?(\d+)$/i);
  if (tmdbMatch) {
    return { tmdbId: tmdbMatch[1] };
  }
  return null;
}

function extractMetadataYear(meta) {
  const yearCandidates = [
    meta?.year,
    meta?.releaseInfo,
    meta?.released,
  ].filter(Boolean);

  for (const candidate of yearCandidates) {
    const match = String(candidate).match(/\b(19\d{2}|20\d{2})\b/);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

async function fetchCinemetaFallback(type, id) {
  const url = `${CINEMETA_BASE_URL}/meta/${type}/${encodeURIComponent(String(id || ""))}.json`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.log(`[addon] cinemeta fallback miss type=${type} id=${JSON.stringify(id)} http=${response.status}`);
      return null;
    }

    const payload = await response.json();
    const meta = payload?.meta;
    const title = String(meta?.name || "").trim();
    if (!title) {
      return null;
    }

    return {
      title,
      year: extractMetadataYear(meta),
      poster: typeof meta?.poster === "string" ? meta.poster : null,
      background: typeof meta?.background === "string" ? meta.background : null,
    };
  } catch (error) {
    console.log(`[addon] cinemeta fallback failed type=${type} id=${JSON.stringify(id)} error=${JSON.stringify(error.message)}`);
    return null;
  }
}

function dedupeMediaGroups(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  const dedupedMap = new Map();
  for (const item of values) {
    if (!item?.id) {
      continue;
    }
    if (dedupedMap.has(item.id)) {
      const existing = dedupedMap.get(item.id);
      existing.releases = dedupeReleases([...(existing.releases || []), ...(item.releases || [])]);
    } else {
      dedupedMap.set(item.id, { ...item, releases: Array.isArray(item.releases) ? [...item.releases] : [] });
    }
  }
  return Array.from(dedupedMap.values());
}

async function runFallbackSearch(bitmagnet, type, query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return [];
  }

  const limit = Math.max(1, Number(options.limit || 20));
  const keyToken = options.keyToken || "_global";
  const watchHistory = Array.isArray(options.watchHistory) ? options.watchHistory : [];
  const searches = await Promise.allSettled([
    orchestrateSearch(type, trimmed, {
      bitmagnet,
      keyToken,
      watchHistory,
      limit,
      fetchLimit: Math.min(Math.max(limit * 2, 12), 24),
      roundsLimit: Math.max(1, Number(options.roundsLimit || 2)),
      perRound: Math.max(1, Number(options.perRound || 3)),
      queryLimit: Math.max(1, Number(options.queryLimit || 6)),
    }),
    typeof bitmagnet.searchWithFiles === "function"
      ? bitmagnet.searchWithFiles(type, trimmed, limit)
      : Promise.resolve([]),
  ]);

  const merged = [];
  const orchestrated = searches[0];
  if (orchestrated?.status === "fulfilled" && Array.isArray(orchestrated.value?.items)) {
    merged.push(...orchestrated.value.items);
  }
  const withFiles = searches[1];
  if (withFiles?.status === "fulfilled" && Array.isArray(withFiles.value)) {
    merged.push(...withFiles.value);
  }
  return dedupeMediaGroups(merged);
}

async function findTitleFallbackMedia(bitmagnet, type, id, options = {}) {
  const metadata = await fetchCinemetaFallback(type, id);
  if (!metadata?.title) {
    return null;
  }

  const searchResults = await runFallbackSearch(bitmagnet, type, metadata.title, {
    keyToken: options.keyToken,
    watchHistory: Array.isArray(options.watchHistory) ? options.watchHistory : [],
    limit: 20,
  });

  const fallbackMatches = chooseSearchFallback(searchResults, metadata);
  const fallbackMedia = mergeFallbackMedia(fallbackMatches, {
    preferredTitle: metadata.title,
  });


  if (fallbackMedia) {
    console.log(
      `[addon] external-id title fallback type=${type} id=${JSON.stringify(id)} query=${JSON.stringify(metadata.title)} groups=${fallbackMatches.length} matched=${JSON.stringify(fallbackMedia.title)} releases=${fallbackMedia.releases.length}`,
    );
    return fallbackMedia;
  }

  console.log(
    `[addon] external-id title fallback miss type=${type} id=${JSON.stringify(id)} query=${JSON.stringify(metadata.title)} results=${searchResults.length}`,
  );
  return null;
}

function chooseSearchFallback(items, metadata) {
  const titleKey = normalizeKey(metadata?.title || "");
  if (!titleKey) {
    return [];
  }

  const titleTokens = titleKey.split(" ").filter((token) => token.length >= 4);
  const exact = [];
  const fuzzy = [];
  const scored = [];

  for (const item of items) {
    const itemKey = normalizeKey(item?.title || "");
    if (!itemKey) {
      continue;
    }

    const yearMatches =
      !Number.isInteger(metadata?.year) ||
      !Number.isInteger(item?.year) ||
      Math.abs(metadata.year - item.year) <= 1;

    if (itemKey === titleKey && yearMatches) {
      exact.push(item);
      continue;
    }

    const isShortTitle = titleKey.split(" ").filter((t) => t.length >= 4).length <= 2;
    if (isShortTitle) {
      if (titleKey.includes(itemKey) && itemKey.length >= titleKey.length * 0.7) {
        fuzzy.push(item);
      }
      continue;
    }

    if ((itemKey.includes(titleKey) || titleKey.includes(itemKey)) && yearMatches) {
      fuzzy.push(item);
      continue;
    }

    const overlap = titleTokens.filter((token) => itemKey.includes(token)).length;
    if (overlap >= 2 && yearMatches) {
      scored.push({ item, overlap });
    }
  }

  const combined = [
    ...exact,
    ...fuzzy,
    ...scored.sort((a, b) => b.overlap - a.overlap).map((s) => s.item),
  ];

  const deduped = [];
  const seenIds = new Set();
  for (const item of combined) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      deduped.push(item);
    }
  }

  return deduped.slice(0, 10);
}

function choosePrimaryMediaGroup(groups, options = {}) {
  const items = Array.isArray(groups) ? groups.filter(Boolean) : [];
  if (items.length === 0) {
    return null;
  }

  const preferredTitleKey = normalizeRecommendationTitle(options.preferredTitle || "");
  if (preferredTitleKey) {
    const exactTitleMatches = items.filter((item) => normalizeRecommendationTitle(item?.title) === preferredTitleKey);
    if (exactTitleMatches.length > 0) {
      return exactTitleMatches
        .slice()
        .sort((left, right) =>
          String(left.title || "").length - String(right.title || "").length ||
          right.releases.length - left.releases.length ||
          left.title.localeCompare(right.title))[0];
    }
  }

  if (options.preferFirst) {
    return items[0];
  }

  return items
    .slice()
    .sort((left, right) => right.releases.length - left.releases.length || left.title.localeCompare(right.title))[0];
}

function mergeFallbackMedia(items, options = {}) {
  const groups = Array.isArray(items) ? items.filter(Boolean) : [];
  if (groups.length === 0) {
    return null;
  }

  const primary = choosePrimaryMediaGroup(groups, {
    preferredTitle: options.preferredTitle,
  });

  const releases = [];
  for (const group of groups) {
    for (const release of group.releases || []) {
      releases.push(release);
    }
  }

  const mergedReleases = dedupeReleases(releases).sort((left, right) =>
    getReleaseResolutionRank(right) - getReleaseResolutionRank(left) ||
    ((Number.isFinite(right.seeders) ? right.seeders : 0) - (Number.isFinite(left.seeders) ? left.seeders : 0)) ||
    ((Number.isFinite(right.sizeBytes) ? right.sizeBytes : 0) - (Number.isFinite(left.sizeBytes) ? left.sizeBytes : 0)));

  return {
    ...primary,
    releases: mergedReleases,
  };
}

function mergeMediaCollections(items) {
  const groups = Array.isArray(items) ? items.filter(Boolean) : [];
  if (groups.length === 0) {
    return null;
  }

  const primary = choosePrimaryMediaGroup(groups, {
    preferFirst: true,
  });

  const releases = [];
  for (const group of groups) {
    for (const release of group.releases || []) {
      releases.push(release);
    }
  }

  const mergedReleases = dedupeReleases(releases).sort((left, right) =>
    getReleaseResolutionRank(right) - getReleaseResolutionRank(left) ||
    ((Number.isFinite(right.seeders) ? right.seeders : 0) - (Number.isFinite(left.seeders) ? left.seeders : 0)) ||
    ((Number.isFinite(right.sizeBytes) ? right.sizeBytes : 0) - (Number.isFinite(left.sizeBytes) ? left.sizeBytes : 0)));

  return {
    ...primary,
    releases: mergedReleases,
  };
}

function mergeReleaseLists(left, right) {
  return mergeMediaCollections([
    { title: "", releases: Array.isArray(left) ? left : [] },
    { title: "", releases: Array.isArray(right) ? right : [] },
  ])?.releases || [];
}

const SEARCH_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const searchResultCache = new Map();

async function runCachedFallbackSearch(bitmagnet, type, query, options = {}) {
  const cacheKey = `${type}:${query}:${options.keyToken || "_global"}`;
  const cached = searchResultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    console.log(`[addon] search cache hit query=${JSON.stringify(query)}`);
    return cached.results;
  }

  const results = await runFallbackSearch(bitmagnet, type, query, options);
  searchResultCache.set(cacheKey, { results, at: Date.now() });
  return results;
}

async function searchEpisodeFallback(bitmagnet, media, season, episode, options = {}) {
  if (!media?.title || !Number.isInteger(season) || !Number.isInteger(episode)) {
    return null;
  }

  const queries = buildEpisodeSearchQueries(media.title, season, episode);
  if (media.imdbId) {
    queries.push(`tt${String(media.imdbId).replace(/^tt/i, "")}`);
  }
  const titleKey = normalizeKey(media.title);
  const titleTokens = titleKey.split(" ").filter((t) => t.length >= 3);

  const allResults = await Promise.all(
    queries.map((query) =>
      runCachedFallbackSearch(bitmagnet, "series", query, {
        keyToken: options.keyToken,
        watchHistory: Array.isArray(options.watchHistory) ? options.watchHistory : [],
        limit: 20,
      }).then((searchResults) => ({ query, searchResults })),
    ),
  );

  let mergedMedia = null;
  let foundExactMatch = false;

  for (const { query, searchResults } of allResults) {
    const titleRelevantGroups = searchResults.filter((group) => {
      const groupKey = normalizeKey(group?.title || "");
      if (titleTokens.length <= 2) {
        return titleKey.includes(groupKey) && groupKey.length >= titleKey.length * 0.7;
      }
      const matchingTokens = titleTokens.filter((token) => groupKey.includes(token));
      return matchingTokens.length >= 2;
    });

    const filteredGroups = titleRelevantGroups
      .map((group) => {
        const matchingReleases = (group.releases || []).filter((release) =>
          releaseMatchesEpisodeRequest(release, season, episode) ||
          (release.season === season && !Number.isInteger(release.episode))
        );
        return {
          ...group,
          releases: matchingReleases,
        };
      })
      .filter((group) => group.releases.length > 0);

    console.log(
      `[addon] episode fallback search title=${JSON.stringify(media.title)} query=${JSON.stringify(query)} titleMatch=${titleRelevantGroups.length} filtered=${filteredGroups.length}`,
    );

    if (filteredGroups.length === 0) {
      continue;
    }

    mergedMedia = mergeMediaCollections([mergedMedia || media, ...filteredGroups]);

    if (mergedMedia?.releases?.some((release) => releaseMatchesEpisodeRequest(release, season, episode))) {
      foundExactMatch = true;
      break;
    }
  }

  return foundExactMatch ? mergedMedia : (mergedMedia || null);
}



async function loadMedia(bitmagnet, cache, pendingCache, id, type, options = {}) {
  const cached = getCachedMedia(cache, id);
  if (cached) {
    console.log(
      `[addon] media cache hit type=${type} id=${JSON.stringify(id)} releases=${Array.isArray(cached.releases) ? cached.releases.length : 0}`,
    );
    return cached;
  }

  const pendingKey = `${type}:${String(id || "")}`;
  if (pendingCache.has(pendingKey)) {
    console.log(`[addon] media pending hit type=${type} id=${JSON.stringify(id)}`);
    return pendingCache.get(pendingKey);
  }

  const pending = (async () => {
    if (String(id || "").startsWith("bm")) {
      const media = await bitmagnet.resolveByGroupId(type, id);
      if (!media) {
        console.log(`[addon] group-id media miss type=${type} id=${JSON.stringify(id)}`);
        return null;
      }
      cacheMediaAliases(cache, media);
      console.log(
        `[addon] group-id media loaded type=${type} id=${JSON.stringify(id)} title=${JSON.stringify(media.title)} releases=${media.releases.length}`,
      );
      return media;
    }

    const externalIds = parseExternalIds(id);
    if (!externalIds) {
      console.log(`[addon] unsupported media id type=${type} id=${JSON.stringify(id)}`);
      return null;
    }

    let media;
    let fallbackMedia;

    if (type === "series") {
      [media, fallbackMedia] = await Promise.all([
        bitmagnet.resolveByExternalId(type, externalIds),
        findTitleFallbackMedia(bitmagnet, type, id, {
          keyToken: options.keyToken,
        }),
      ]);
    } else {
      media = await bitmagnet.resolveByExternalId(type, externalIds);
      if (!media) {
        fallbackMedia = await findTitleFallbackMedia(bitmagnet, type, id, {
          keyToken: options.keyToken,
        });
      }
    }

    if (media || fallbackMedia) {
      const resolvedMedia = mergeMediaCollections([media, fallbackMedia].filter(Boolean)) || media || fallbackMedia;
      cacheMediaAliases(cache, resolvedMedia);
      console.log(
        `[addon] external-id media loaded type=${type} id=${JSON.stringify(id)} title=${JSON.stringify(resolvedMedia.title)} imdb=${JSON.stringify(resolvedMedia.imdbId || "")} tmdb=${JSON.stringify(resolvedMedia.tmdbId || "")} releases=${resolvedMedia.releases.length} from=${media ? "exact" : ""}${media && fallbackMedia ? "+" : ""}${fallbackMedia ? "fallback" : ""}`,
      );
      return resolvedMedia;
    }

    console.log(
      `[addon] external-id media miss type=${type} id=${JSON.stringify(id)} imdb=${JSON.stringify(externalIds.imdbId || "")} tmdb=${JSON.stringify(externalIds.tmdbId || "")}`,
    );
    return null;
  })();

  pendingCache.set(pendingKey, pending);
  pending.finally(() => {
    if (pendingCache.get(pendingKey) === pending) {
      pendingCache.delete(pendingKey);
    }
  });
  return pending;
}

async function refreshMedia(bitmagnet, cache, pendingCache, media, type, options = {}) {
  invalidateCachedMedia(cache, media);
  const refreshId =
    media?.imdbId ? `tt${media.imdbId}` :
    media?.tmdbId ? `tmdb:${media.tmdbId}` :
    media?.id;

  if (!refreshId) {
    return media;
  }

  console.log(
    `[addon] refreshing media type=${type} id=${JSON.stringify(refreshId)} title=${JSON.stringify(media.title || "")}`,
  );
  return loadMedia(bitmagnet, cache, pendingCache, String(refreshId), type, options);
}

/**
 * Build a Torrentio-style magnet stream object for Stremio.
 * Stremio's own torrent engine handles the download.
 */
function buildMagnetStream(release, media, options = {}) {
  const { season, episode } = options;

  // Build the magnet URI
  const infoHash = release.infoHash
    ? release.infoHash.toLowerCase()
    : String(release.magnetUri || "").match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();

  if (!infoHash) {
    return null;
  }

  const magnetUri = release.magnetUri || `magnet:?xt=urn:btih:${infoHash}`;

  // Extract tracker URLs from the magnet URI and format them as Stremio sources.
  // This tells Stremio exactly which trackers to use for peer discovery,
  // making the client-side P2P intent unambiguous instead of relying on DHT alone.
  let sourcesList = [];
  try {
    const trackers = Array.from(new URL(magnetUri).searchParams.getAll("tr"))
      .map((tr) => `tracker:${tr}`)
      .filter(Boolean);
    if (trackers.length > 0) {
      sourcesList.push(...trackers);
    }
  } catch (_err) {
    // Ignore malformed magnet URIs — Stremio will still use DHT
  }

  // Inject public trackers to ensure Stremio's torrent engine can start download immediately
  try {
    const publicTrackers = getTrackers().map((tr) => `tracker:${tr}`);
    sourcesList.push(...publicTrackers);
  } catch (_err) {
    // Fail-safe
  }

  const sources = [...new Set(sourcesList)];

  const title = formatStreamTitle(release, {
    mediaType: media.type,
    mediaTitle: media.title,
    season,
    episode,
  });

  const stream = {
    name: "[Bitlab]",
    title,
    infoHash,
    ...(sources.length > 0 ? { sources } : {}),
    behaviorHints: {
      bingeGroup: `bitlab-${infoHash}`,
    },
  };

  // If we have a specific file index, tell Stremio which file to play
  if (Number.isInteger(release.fileIndex)) {
    stream.fileIdx = release.fileIndex;
  }

  return stream;
}

function createAddonInterface({ config, bitmagnet }) {
  const mediaCache = new Map();
  const pendingMediaLoads = new Map();

  const builder = new addonBuilder({
    id: "local.bitmagnet-stremio-lab",
    version: "0.5.0",
    name: "Bitlab",
    description: "Searches a live bitmagnet index and streams via magnet links through Stremio.",
    resources: ["meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["bm", "tt", "tmdb", "imdb"],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  });

  builder.defineMetaHandler(async (args) => {
    const media = await loadMedia(bitmagnet, mediaCache, pendingMediaLoads, String(args.id), args.type);
    if (!media) {
      return { meta: null };
    }
    return { meta: toMeta(media) };
  });

  builder.defineStreamHandler(async (args) => {
    const { mediaId, releaseId, season, episode } = parseStreamRequestId(args.id, args.type);
    console.log(
      `[addon] stream start type=${args.type} id=${JSON.stringify(args.id)} mediaId=${JSON.stringify(mediaId)} season=${JSON.stringify(season)} episode=${JSON.stringify(episode)}`,
    );

    let media = await loadMedia(bitmagnet, mediaCache, pendingMediaLoads, mediaId, args.type);
    if (!media) {
      console.log(`[addon] stream media miss type=${args.type} id=${JSON.stringify(args.id)}`);
      return { streams: [] };
    }
    console.log(
      `[addon] stream media loaded type=${args.type} title=${JSON.stringify(media.title)} releases=${media.releases.length}`,
    );

    let releases = (Array.isArray(media.releases) ? media.releases : [])
      .filter((release) => {
        if (releaseId) {
          return release.id === releaseId;
        }
        if (args.type === "series" && Number.isInteger(season) && Number.isInteger(episode)) {
          return releaseMatchesEpisodeRequest(release, season, episode);
        }
        return true;
      });

    // When a specific release was requested by ID, skip the seeder filter —
    // the user explicitly chose this torrent so we should always return it.
    if (!releaseId) {
      releases = releases.filter(hasDisplayableSeeders);
    } else if (releases.length === 0) {
      console.log(`[addon] stream releaseId miss type=${args.type} releaseId=${JSON.stringify(releaseId)} — falling back to all releases`);
      releases = (Array.isArray(media.releases) ? media.releases : []).filter(hasDisplayableSeeders);
    }

    // For movies: if the primary filter produced nothing, try a lenient filter
    // then a full refresh — mirrors the series fallback strategy.
    if (args.type === "movie" && !releaseId && releases.length === 0) {
      releases = (Array.isArray(media.releases) ? media.releases : [])
        .filter((r) => hasDisplayableSeeders(r, { lenient: true }));
      if (releases.length === 0) {
        console.log(`[addon] movie stream no releases — refreshing media type=${args.type} title=${JSON.stringify(media.title)}`);
        const refreshed = await refreshMedia(bitmagnet, mediaCache, pendingMediaLoads, media, args.type);
        if (refreshed) {
          media = refreshed;
          releases = sortReleases(
            (Array.isArray(media.releases) ? media.releases : [])
              .filter((r) => hasDisplayableSeeders(r, { lenient: true })),
          );
        }
      }
    }

    if (args.type === "series") {
      if (Number.isInteger(season) && Number.isInteger(episode)) {
        if (releases.length === 0) {
          console.log(
            `[addon] stream no direct series matches title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} trying search fallback`,
          );
          const fallbackMedia = await searchEpisodeFallback(bitmagnet, media, season, episode);
          if (fallbackMedia) {
            media = fallbackMedia;
            cacheMediaAliases(mediaCache, media);
            releases = media.releases
              .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
              .filter(hasDisplayableSeeders);
          }
        }

        if (releases.length === 0) {
          releases = media.releases
            .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
            .filter((r) => hasDisplayableSeeders(r, { lenient: true }));
          if (releases.length > 0) {
            console.log(`[addon] series stream match title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} using lenient seeder filter count=${releases.length}`);
          }
        }

        if (releases.length === 0) {
          const refreshed = await refreshMedia(bitmagnet, mediaCache, pendingMediaLoads, media, args.type);
          if (refreshed) {
            media = refreshed;
            releases = sortReleases(
              media.releases
                .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
                .filter(hasDisplayableSeeders),
            );
          }
        }

        if (releases.length === 0) {
          const fallbackMedia = await searchEpisodeFallback(bitmagnet, media, season, episode);
          if (fallbackMedia) {
            media = fallbackMedia;
            cacheMediaAliases(mediaCache, media);
            releases = sortReleases(
              media.releases
                .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
                .filter(hasDisplayableSeeders),
            );
          }
        }
      }
    }

    releases = sortReleases(releases);

    if (args.type === "series" && Number.isInteger(season) && Number.isInteger(episode)) {
      console.log(
        `[addon] series stream match title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} matched=${releases.length} totalReleases=${media.releases.length}`,
      );
    }

    const streams = releases
      .map((release) => buildMagnetStream(release, media, { season, episode }))
      .filter(Boolean);

    console.log(`[addon] stream result count=${streams.length}`);
    return { streams };
  });

  return builder.getInterface();
}

module.exports = {
  createAddonInterface,
};
