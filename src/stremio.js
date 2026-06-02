const { addonBuilder } = require("stremio-addon-sdk");
const { createPlaybackToken } = require("./auth");
const {
  isVideoFile,
  normalizeKey,
  buildTitleSearchAliases,
  inferReleaseQuality,
  buildSeriesReleaseLabel,
} = require("./classify");
const {
  parseEpisodeLocal,
  orchestrateSearch,
} = require("./discovery");

const CACHE_TTL_MS = 1000 * 60 * 30;
const CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";

function validateAddonKey(db, token) {
  const key = db.getKeyByToken(token);
  if (!key || key.revoked_at) {
    return null;
  }
  return key;
}

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
  if (raw.startsWith("bm") && raw.includes(":")) {
    const separatorIndex = raw.indexOf(":");
    return {
      mediaId: raw.slice(0, separatorIndex),
      releaseId: raw.slice(separatorIndex + 1),
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

function buildMediaIndexAliasKeys(type, media, externalIds = null) {
  const keys = [];
  const imdbId = String(externalIds?.imdbId || media?.imdbId || "").replace(/^tt/i, "");
  const tmdbId = String(externalIds?.tmdbId || media?.tmdbId || "");

  if (imdbId) {
    keys.push(`${type}:imdb:${imdbId}`);
  }
  if (tmdbId) {
    keys.push(`${type}:tmdb:${tmdbId}`);
  }
  if (media?.id) {
    keys.push(`${type}:id:${media.id}`);
  }

  return Array.from(new Set(keys.filter(Boolean)));
}

function persistIndexedMedia(db, type, media, externalIds = null) {
  if (!db || !media) {
    return;
  }
  const aliasKeys = buildMediaIndexAliasKeys(type, media, externalIds);
  db.indexResolvedMedia(media, aliasKeys);
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

const SERIES_PACK_INSPECT_TIMEOUT_MS = 20000;

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

  const mediaTitleKey = normalizeKey(media.title);
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

async function mergeSeriesReleases(existingReleases, inspected, fallbackRelease) {
  const expanded = [];

  for (const release of existingReleases) {
    if (Number.isInteger(release.season) && Number.isInteger(release.episode)) {
      expanded.push(release);
    }
  }

  const videoFiles = (inspected.files || []).filter((file) => isVideoFile(file.name));
  if (videoFiles.length === 0) {
    return dedupeReleases(expanded);
  }

  for (let index = 0; index < videoFiles.length; index += 1) {
    const file = videoFiles[index];
    const episodeParts = parseEpisodeLocal(`${inspected.torrentName || fallbackRelease.releaseName} ${file.name}`);
    if (!Number.isInteger(episodeParts?.season)) {
      continue;
    }
    expanded.push({
      ...fallbackRelease,
      releaseName: inspected.torrentName || fallbackRelease.releaseName,
      infoHash: inspected.infoHash || fallbackRelease.infoHash,
      fileIndex: file.index,
      fileName: file.name,
      sizeBytes: file.sizeBytes,
      season: episodeParts.season,
      episode: Number.isInteger(episodeParts.episode) ? episodeParts.episode : null,
    });
  }

  return dedupeReleases(expanded);
}

function hasEpisodeMatch(media, season, episode) {
  return media.releases.some(
    (release) => release.season === season && release.episode === episode,
  );
}

function countEpisodicReleases(releases) {
  return releases.filter(
    (release) => Number.isInteger(release.season) && Number.isInteger(release.episode),
  ).length;
}

function getPendingSeriesPackCount(media) {
  return media.releases.filter(
    (release) =>
      Number.isInteger(release.season) &&
      !Number.isInteger(release.episode) &&
      (release.magnetUri || release.infoHash),
  ).length;
}

function selectPendingSeriesPacks(media, options = {}) {
  const targetSeason = Number.isInteger(options.season) ? options.season : null;
  const targetEpisode = Number.isInteger(options.episode) ? options.episode : null;
  const targetedRequest = targetSeason !== null && targetEpisode !== null;

  let pending = media.releases.filter(
    (release) =>
      Number.isInteger(release.season) &&
      !Number.isInteger(release.episode) &&
      (release.magnetUri || release.infoHash),
  );

  if (targetedRequest) {
    pending = pending.filter((release) => release.season === targetSeason);
  }

  pending.sort((left, right) => {
    const leftSeasonScore = targetedRequest && left.season === targetSeason ? 1 : 0;
    const rightSeasonScore = targetedRequest && right.season === targetSeason ? 1 : 0;
    return rightSeasonScore - leftSeasonScore ||
      getReleaseResolutionRank(right) - getReleaseResolutionRank(left) ||
      ((Number.isFinite(right.seeders) ? right.seeders : 0) - (Number.isFinite(left.seeders) ? left.seeders : 0)) ||
      ((Number.isFinite(right.sizeBytes) ? right.sizeBytes : 0) - (Number.isFinite(left.sizeBytes) ? left.sizeBytes : 0));
  });

  const selected = targetedRequest ? pending.slice(0, 3) : pending.slice(0, 10);
  return selected.map(release => ({
    ...release,
    magnetUri: release.magnetUri || `magnet:?xt=urn:btih:${release.infoHash}`,
  }));
}

async function expandSeriesMedia(media, torrentService, options = {}) {
  if (!torrentService || media.type !== "series") {
    return media;
  }

  const targetSeason = Number.isInteger(options.season) ? options.season : null;
  const targetEpisode = Number.isInteger(options.episode) ? options.episode : null;
  const targetedRequest = targetSeason !== null && targetEpisode !== null;

  const needsExpansion = media.releases.some(
    (release) => Number.isInteger(release.season) && !Number.isInteger(release.episode),
  );
  if (!needsExpansion) {
    return media;
  }

  const pending = selectPendingSeriesPacks(media, options);
  if (pending.length === 0) {
    return media;
  }

  const timeoutMs = targetedRequest ? 15000 : SERIES_PACK_INSPECT_TIMEOUT_MS;
  let releases = media.releases.slice();

  // Create an array of expansion tasks
  const tasks = pending.map(async (release) => {
    try {
      const inspected = await torrentService.inspectMagnet(release.magnetUri, {
        removeAfterInspect: true,
        timeoutMs,
      });
      const expanded = await mergeSeriesReleases(releases, inspected, release);
      return { release, inspected, expanded };
    } catch (error) {
      console.error(
        `[addon] series pack expansion failed title=${JSON.stringify(media.title)} infoHash=${JSON.stringify(release.infoHash || "")} error=${JSON.stringify(error.message)}`,
      );
      return null;
    }
  });

  if (targetedRequest) {
    // For targeted requests, we want to return as soon as we have A match,
    // but we still want to benefit from other parallel results if they finish fast.
    const results = [];
    const internalReleases = new Set(releases.map(getReleaseIdentityKey));
    let foundTarget = false;

    await new Promise((resolve) => {
      let finishedCount = 0;
      let targetMatches = 0;

      tasks.forEach(async (task) => {
        const result = await task;
        finishedCount += 1;

        if (result) {
          results.push(result);
          // Count how many packs specifically have our target
          const hasTarget = result.expanded.some(
            (r) => r.season === targetSeason && r.episode === targetEpisode
          );
          if (hasTarget) {
            targetMatches += 1;
            foundTarget = true;
          }
        }

        if (targetMatches >= 2 || finishedCount === tasks.length) {
          resolve();
        }
      });
    });

    // Merge all results we got before resolving
    for (const result of results) {
      for (const r of result.expanded) {
        const key = getReleaseIdentityKey(r);
        if (!internalReleases.has(key)) {
          internalReleases.add(key);
          releases.push(r);
        }
      }
    }

    if (foundTarget) {
      console.log(
        `[addon] parallel expansion found target title=${JSON.stringify(media.title)} target=S${targetSeason}E${targetEpisode}`,
      );
    }
  } else {
    // For non-targeted requests (warming), wait for all to finish in parallel
    const expansionResults = await Promise.allSettled(tasks);
    for (const result of expansionResults) {
      if (result.status === "fulfilled" && result.value) {
        const { expanded } = result.value;
        const currentKeys = new Set(releases.map(getReleaseIdentityKey));
        for (const r of expanded) {
          const key = getReleaseIdentityKey(r);
          if (!currentKeys.has(key)) {
            currentKeys.add(key);
            releases.push(r);
          }
        }
      }
    }
  }

  return {
    ...media,
    releases: dedupeReleases(releases),
  };
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
    pendingCache.delete(pendingKey);
  });
  return pending;
}

function createSeriesExpansionManager(cache, torrentService) {
  const pendingExpansions = new Map();

  async function ensureExpanded(media, options = {}) {
    if (!media || media.type !== "series") {
      return media;
    }

    const needsExpansion = media.releases.some(
      (release) => Number.isInteger(release.season) && !Number.isInteger(release.episode),
    );
    if (!needsExpansion) {
      return media;
    }

    const targetSeason = Number.isInteger(options.season) ? options.season : null;
    const targetEpisode = Number.isInteger(options.episode) ? options.episode : null;
    if (
      targetSeason !== null &&
      targetEpisode !== null &&
      hasEpisodeMatch(media, targetSeason, targetEpisode)
    ) {
      return media;
    }

    const expansionKey =
      targetSeason !== null && targetEpisode !== null
        ? `${media.id}:${targetSeason}:${targetEpisode}`
        : `${media.id}:all`;

    if (pendingExpansions.has(expansionKey)) {
      return pendingExpansions.get(expansionKey);
    }

    const pending = expandSeriesMedia(media, torrentService, {
      season: targetSeason,
      episode: targetEpisode,
    }).then((expanded) => {
      cacheMediaAliases(cache, expanded);
      return expanded;
    }).finally(() => {
      pendingExpansions.delete(expansionKey);
    });

    pendingExpansions.set(expansionKey, pending);
    return pending;
  }

  function warm(media) {
    if (!media || media.type !== "series") {
      return;
    }
    const pendingPackCount = getPendingSeriesPackCount(media);
    if (pendingPackCount > 3) {
      console.log(
        `[addon] skipping background series expansion title=${JSON.stringify(media.title)} pendingPacks=${pendingPackCount}`,
      );
      return;
    }
    ensureExpanded(media).catch((error) => {
      console.error(
        `[addon] background series expansion failed title=${JSON.stringify(media.title)} error=${JSON.stringify(error.message)}`,
      );
    });
  }

  return {
    ensureExpanded,
    warm,
  };
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

function createAddonInterface({ db, config, bitmagnet, torrentService }) {
  const mediaCache = new Map();
  const pendingMediaLoads = new Map();
  const seriesExpansions = createSeriesExpansionManager(mediaCache, torrentService);

  const builder = new addonBuilder({
    id: "local.bitmagnet-stremio-lab",
    version: "0.4.3",
    name: "Bitlab",
    description: "Searches a live bitmagnet index and streams selected magnets through WebTorrent.",
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
    const media = await loadMedia(bitmagnet, mediaCache, pendingMediaLoads, String(args.id), args.type, {
      keyToken: args.config.keyToken,
    });
    if (!media) {
      return { meta: null };
    }
    const externalIds = parseExternalIds(args.id);
    persistIndexedMedia(db, args.type, media, externalIds);
    seriesExpansions.warm(media);
    return { meta: toMeta(media) };
  });

  builder.defineStreamHandler(async (args) => {
    const { mediaId, releaseId, season, episode } = parseStreamRequestId(args.id, args.type);
    const mediaExternalIds = parseExternalIds(mediaId || args.id);
    console.log(
      `[addon] stream start type=${args.type} id=${JSON.stringify(args.id)} mediaId=${JSON.stringify(mediaId)} season=${JSON.stringify(season)} episode=${JSON.stringify(episode)}`,
    );

    let media = await loadMedia(bitmagnet, mediaCache, pendingMediaLoads, mediaId, args.type, {
      keyToken: args.config.keyToken,
    });
    if (!media) {
      console.log(`[addon] stream media miss type=${args.type} id=${JSON.stringify(args.id)}`);
      return { streams: [] };
    }
    console.log(
      `[addon] stream media loaded type=${args.type} title=${JSON.stringify(media.title)} releases=${media.releases.length}`,
    );
    persistIndexedMedia(db, args.type, media, mediaExternalIds);
    let attemptedExpansion = false;

    let releases = (Array.isArray(media.releases) ? media.releases : [])
      .filter((release) => {
        if (releaseId) {
          return release.id === releaseId;
        }
        if (args.type === "series" && Number.isInteger(season) && Number.isInteger(episode)) {
          return releaseMatchesEpisodeRequest(release, season, episode);
        }
        return true;
      })
      .filter(hasDisplayableSeeders);

    if (args.type === "series") {
      if (Number.isInteger(season) && Number.isInteger(episode)) {
        if (releases.length === 0) {
          console.log(
            `[addon] stream no direct series matches title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} trying search fallback`,
          );
          const fallbackMedia = await searchEpisodeFallback(bitmagnet, media, season, episode, {
            keyToken: args.config.keyToken,
          });
          if (fallbackMedia) {
            media = fallbackMedia;
            cacheMediaAliases(mediaCache, media);
            persistIndexedMedia(db, args.type, media, mediaExternalIds);
            releases = media.releases
              .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
              .filter(hasDisplayableSeeders);
          }
        }

        if (releases.length === 0) {
          attemptedExpansion = true;
          console.log(
            `[addon] stream attempting series expansion title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
          );
          media = await seriesExpansions.ensureExpanded(media, { season, episode });
          persistIndexedMedia(db, args.type, media, mediaExternalIds);
          releases = media.releases
            .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
            .filter(hasDisplayableSeeders);
        }

        if (releases.length === 0) {
          releases = media.releases
            .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
            .filter((r) => hasDisplayableSeeders(r, { lenient: true }));
          if (releases.length > 0) {
            console.log(`[addon] series stream match title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} using lenient seeder filter count=${releases.length}`);
          }
        }

        if (releases.length <= 1 && getPendingSeriesPackCount(media) > 0 && !attemptedExpansion) {
          attemptedExpansion = true;
          const expandedMedia = await seriesExpansions.ensureExpanded(media, { season, episode });
          if (expandedMedia) {
            media = expandedMedia;
            persistIndexedMedia(db, args.type, media, mediaExternalIds);
            releases = mergeReleaseLists(
              releases,
              media.releases
                .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
                .filter(hasDisplayableSeeders),
            ).filter(hasDisplayableSeeders);
          }
        }
      } else {
        seriesExpansions.warm(media);
      }
    }

    releases = sortReleases(releases);

    if (
      args.type === "series" &&
      Number.isInteger(season) &&
      Number.isInteger(episode) &&
      releases.length <= 1 &&
      !attemptedExpansion
    ) {
      const refreshed = await refreshMedia(bitmagnet, mediaCache, pendingMediaLoads, media, args.type, {
        keyToken: args.config.keyToken,
      });
      if (refreshed) {
        media = await seriesExpansions.ensureExpanded(refreshed, { season, episode });
        persistIndexedMedia(db, args.type, media, mediaExternalIds);
        releases = sortReleases(
          mergeReleaseLists(
            releases,
            media.releases
              .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
              .filter(hasDisplayableSeeders),
          ),
        );
      }
    }

    if (
      args.type === "series" &&
      Number.isInteger(season) &&
      Number.isInteger(episode) &&
      releases.length === 0
    ) {
      const fallbackMedia = await searchEpisodeFallback(bitmagnet, media, season, episode, {
        keyToken: args.config.keyToken,
      });
      if (fallbackMedia) {
        media = fallbackMedia;
        cacheMediaAliases(mediaCache, media);
        persistIndexedMedia(db, args.type, media, mediaExternalIds);
        releases = sortReleases(
          media.releases
            .filter((release) => releaseMatchesEpisodeRequest(release, season, episode))
            .filter(hasDisplayableSeeders),
        );
      }
    }

    if (args.type === "series" && Number.isInteger(season) && Number.isInteger(episode)) {
      console.log(
        `[addon] series stream match title=${JSON.stringify(media.title)} request=S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} matched=${releases.length} totalReleases=${media.releases.length}`,
      );
    }

    const streams = releases.flatMap((release) => {
      const token = createPlaybackToken({
        keyToken: args.config.keyToken,
        stream: {
          mediaType: media.type,
          mediaTitle: media.title,
          releaseName: release.releaseName,
          season: Number.isInteger(season)
            ? season
            : (Number.isInteger(release.season) ? release.season : undefined),
          episode: Number.isInteger(episode)
            ? episode
            : (Number.isInteger(release.episode) ? release.episode : undefined),
          fileName: release.fileName || undefined,
          infoHash: release.infoHash || undefined,
          magnetUri: release.magnetUri,
          fileIndex: Number.isInteger(release.fileIndex) ? release.fileIndex : undefined,
          sizeBytes: Number.isFinite(release.sizeBytes) ? release.sizeBytes : undefined,
        },
        secret: config.sessionSecret,
        ttlMs: config.streamTokenTtlMs,
      });

      return [{
        name: "[Bit]",
        title: formatStreamTitle(release, {
          mediaType: media.type,
          mediaTitle: media.title,
          season,
          episode,
        }),
        url: `${args.config.baseUrl}/play/${token}`,
        behaviorHints: {
          notWebReady: true,
        },
      }];
    });

    return { streams };
  });

  return builder.getInterface();
}

module.exports = {
  createAddonInterface,
  validateAddonKey,
};
