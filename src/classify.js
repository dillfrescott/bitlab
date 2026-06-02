const path = require("node:path");

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".m4v",
  ".webm",
  ".mpg",
  ".mpeg",
]);

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(fileName || "").toLowerCase());
}

function extractEpisodeParts(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const s01e01 = raw.match(/s(\d{1,2})[ ._-]*e(\d{1,3})/i);
  if (s01e01) {
    return { season: parseInt(s01e01[1], 10), episode: parseInt(s01e01[2], 10) };
  }

  const s01_01 = raw.match(/s(\d{1,2})[ ._-]*(?:-|e|\.)[ ._-]*(\d{1,3})(?:\b|(?=[ ._([-]))/i);
  if (s01_01) {
    return { season: parseInt(s01_01[1], 10), episode: parseInt(s01_01[2], 10) };
  }

  const nxn = raw.match(/(?:^|[ \[\]()_-])(\d{1,2})x(\d{1,3})(?:$|[ \[\]()_-])/i);
  if (nxn) {
    return { season: parseInt(nxn[1], 10), episode: parseInt(nxn[2], 10) };
  }

  const ep = raw.match(/(?<!season[ ._-]*)(?:episode|[ ._-])[ ._-]*(\d{1,4})(?:\b|(?=[ ._([-]))/i);
  if (ep) {
    if (/^s\d{1,2}$/i.test(ep[0].trim())) {
      return null;
    }

    const num = parseInt(ep[1], 10);
    if (num > 1900 && num < 2100) {
      if (/episode/i.test(ep[0])) {
         return { season: null, episode: num };
      }
    } else {
      return { season: null, episode: num };
    }
  }

  return null;
}

function extractSeasonParts(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const s1 = raw.match(/season[ ._-]*(\d{1,2})/i);
  if (s1) {
    return { season: parseInt(s1[1], 10) };
  }

  const s01 = raw.match(/\bs(\d{1,2})\b/i);
  if (s01) {
    return { season: parseInt(s01[1], 10) };
  }

  return null;
}

function extractTitleAndYear(raw, stopOnEpisode) {
  let title = String(raw || "").trim();
  let year = null;

  title = title.replace(/^(\[[^\]]+\]|\([^)]+\))\s*/, "").trim();

  const yearMatch = title.match(/[ .(\[]+(19\d{2}|20\d{2})[ .)(\]]*/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    title = title.substring(0, yearMatch.index).trim();
  }

  if (stopOnEpisode) {
    const episodeMarker = title.match(/[ .(\[]+(s\d{1,2}|season[ ._-]*\d{1,2}|\d{1,2}x\d{1,3}|-[ ._-]*\d{1,3})[ .)(\]]*/i);
    if (episodeMarker) {
      title = title.substring(0, episodeMarker.index).trim();
    }

    const leadingEpisodeMarker = title.match(/^(s\d{1,2}|season[ ._-]*\d{1,2}|\d{1,2}x\d{1,3})[ .)(\]]*/i);
    if (leadingEpisodeMarker) {
       title = title.substring(leadingEpisodeMarker[0].length).trim();
    }
  }

  title = title.replace(/[._-]/g, " ").replace(/\s+/g, " ").trim();

  return { title, year };
}

function normalizeKey(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function buildTitleSearchAliases(rawTitle) {
  const original = String(rawTitle || "").trim();
  if (!original) {
    return [];
  }

  const aliases = new Set([original]);
  const normalizedWhitespace = original.replace(/\s+/g, " ").trim();
  aliases.add(normalizedWhitespace);

  return Array.from(aliases)
    .map((value) => value.trim())
    .filter(Boolean);
}


function inferReleaseQuality(release) {
  const source = `${release.releaseName || ""} ${release.fileName || ""}`.toLowerCase();
  const patterns = [/\b2160p\b/i, /\b1080p\b/i, /\b720p\b/i, /\b480p\b/i];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[0].toUpperCase();
  }
  return /\b4k\b/i.test(source) ? "4K" : "Unknown";
}

function buildSeriesReleaseLabel(mediaTitle, release) {
  const title = String(mediaTitle || "").trim();
  const parts = [];

  if (title) {
    parts.push(title);
  }

  if (Number.isInteger(release?.season) && Number.isInteger(release?.episode)) {
    parts.push(`S${String(release.season).padStart(2, "0")}E${String(release.episode).padStart(2, "0")}`);
  } else if (Number.isInteger(release?.season)) {
    parts.push(`Season ${release.season}`);
  }

  const quality = inferReleaseQuality(release);
  if (quality !== "Unknown") {
    parts.push(quality);
  }

  return parts.join(" | ") || String(release?.fileName || release?.releaseName || "Episode").trim();
}

module.exports = {
  extractEpisodeParts,
  extractSeasonParts,
  extractTitleAndYear,
  normalizeKey,
  buildTitleSearchAliases,
  inferReleaseQuality,
  buildSeriesReleaseLabel,
  isVideoFile,
};
