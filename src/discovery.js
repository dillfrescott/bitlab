const {
  normalizeKey,
  extractEpisodeParts,
  extractSeasonParts,
} = require("./classify");

const SEARCH_RECOMMENDATION_MAX_QUERIES = 3;

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeTokens(text) {
  return normalizeKey(text)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeTokenOverlap(left, right) {
  if (!left.length || !right.length) {
    return 0;
  }
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      matches += 1;
    }
  }
  return matches / Math.max(left.length, right.length);
}

function parseEpisodeLocal(text) {
  const explicitEpisode = extractEpisodeParts(text);
  if (explicitEpisode) {
    return explicitEpisode;
  }
  const explicitSeason = extractSeasonParts(text);
  return explicitSeason ? { season: explicitSeason.season, episode: null } : null;
}

function searchScore(query, item) {
  const queryKey = normalizeKey(query);
  const itemTitle = String(item?.title || "");
  const titleKey = normalizeKey(itemTitle);
  const queryTokens = normalizeTokens(query);
  const titleTokens = normalizeTokens(itemTitle);
  const titleMatch =
    titleKey === queryKey ? 3 :
      titleKey.includes(queryKey) ? 2.2 :
        queryKey.includes(titleKey) ? 1.6 :
          computeTokenOverlap(queryTokens, titleTokens) * 1.5;
  const releaseCount = Math.log1p(Array.isArray(item?.releases) ? item.releases.length : 0) * 0.5;
  const bestSeeders = Math.log1p(Math.max(
    0,
    ...(Array.isArray(item?.releases) ? item.releases : []).map((release) =>
      Number.isFinite(release?.seeders) ? release.seeders : 0),
  )) * 0.3;
  const year = Number(item?.year) || 0;
  const yearBonus = year > 0 && /\b(19|20)\d{2}\b/.test(query) && String(query).includes(String(year)) ? 0.4 : 0;
  return titleMatch + releaseCount + bestSeeders + yearBonus;
}

async function curateSearchResults(_type, query, groups) {
  const items = Array.isArray(groups) ? groups.filter(Boolean) : [];
  return items.slice().sort((left, right) => searchScore(query, right) - searchScore(query, left));
}

function titleLooksRelated(query, title) {
  const queryTokens = normalizeTokens(query);
  const titleTokens = normalizeTokens(title);
  return computeTokenOverlap(queryTokens, titleTokens) >= 0.34;
}

async function planSearchRecommendations(_type, query, watchHistory = [], priorRounds = []) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { done: true, queries: [] };
  }

  const executed = new Set(
    (Array.isArray(priorRounds) ? priorRounds : [])
      .flatMap((round) => round?.searches || [])
      .map((entry) => String(entry?.query || "").trim())
      .filter(Boolean),
  );

  const candidates = [trimmed];
  for (const entry of (Array.isArray(watchHistory) ? watchHistory : []).slice(-12).reverse()) {
    const title = String(entry?.mediaTitle || "").trim();
    if (title && titleLooksRelated(trimmed, title)) {
      candidates.push(title);
    }
  }
  for (const round of Array.isArray(priorRounds) ? priorRounds : []) {
    for (const item of round?.searches || []) {
      for (const result of item?.results || []) {
        const title = String(result?.title || "").trim();
        if (title && titleLooksRelated(trimmed, title)) {
          candidates.push(title);
        }
      }
    }
  }

  const filtered = unique(candidates.map((value) => value.trim()))
    .filter((value) => !executed.has(value))
    .slice(0, SEARCH_RECOMMENDATION_MAX_QUERIES);

  return {
    done: filtered.length === 0,
    queries: filtered,
  };
}

async function orchestrateSearch(type, query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { items: [], rounds: [], executedQueries: [] };
  }

  const bitmagnet = options.bitmagnet;
  if (!bitmagnet || typeof bitmagnet.searchRaw !== "function") {
    throw new Error("orchestrateSearch requires bitmagnet.searchRaw()");
  }

  const watchHistory = Array.isArray(options.watchHistory) ? options.watchHistory.filter(Boolean) : [];
  const limit = Math.max(1, Number(options.limit || 12));
  const fetchLimit = Math.max(limit, Number(options.fetchLimit || Math.min(limit * 2, 24)));
  const roundsLimit = Math.max(1, Number(options.roundsLimit || 2));
  const perRound = Math.max(1, Number(options.perRound || 3));
  const queryLimit = Math.max(perRound, Number(options.queryLimit || 6));
  const deduped = [];
  const seenIds = new Set();
  const priorRounds = [];
  const executedQueries = new Set();

  for (let round = 0; round < roundsLimit; round += 1) {
    const plan = await planSearchRecommendations(type, trimmed, watchHistory, priorRounds);
    const searchQueries = (Array.isArray(plan?.queries) ? plan.queries : [])
      .filter((candidate) => typeof candidate === "string" && candidate.trim())
      .map((candidate) => candidate.trim())
      .filter((candidate) => !executedQueries.has(candidate))
      .slice(0, perRound);

    if (searchQueries.length === 0) {
      break;
    }

    searchQueries.forEach((candidate) => executedQueries.add(candidate));
    const searches = await Promise.allSettled(
      searchQueries.map((candidate) => bitmagnet.searchRaw(type, candidate, fetchLimit)),
    );

    const roundSummary = [];
    for (let index = 0; index < searches.length; index += 1) {
      const result = searches[index];
      const candidate = searchQueries[index];
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) {
        roundSummary.push({
          query: candidate,
          results: [],
          error: result.status === "rejected" ? String(result.reason?.message || result.reason || "") : "",
        });
        continue;
      }

      const ranked = await curateSearchResults(type, trimmed, result.value);
      roundSummary.push({
        query: candidate,
        results: ranked.slice(0, 5).map((item) => ({
          id: item.id,
          title: item.title,
          year: item.year || null,
          releaseCount: Array.isArray(item.releases) ? item.releases.length : 0,
        })),
      });

      for (const item of ranked) {
        if (!item?.id || seenIds.has(item.id)) {
          continue;
        }
        seenIds.add(item.id);
        deduped.push(item);
      }
    }

    priorRounds.push({
      round: round + 1,
      searches: roundSummary,
    });

    if (plan?.done || executedQueries.size >= queryLimit) {
      break;
    }
  }

  return {
    items: (await curateSearchResults(type, trimmed, deduped)).slice(0, limit),
    rounds: priorRounds,
    executedQueries: Array.from(executedQueries),
  };
}

module.exports = {
  parseEpisodeLocal,
  curateSearchResults,
  orchestrateSearch,
};
