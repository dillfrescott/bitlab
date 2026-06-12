const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const STATUS_VIDEO_DURATION_SECONDS = 6;
const STATUS_VIDEO_VERSION = 4;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "key";
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function buildFilter(lines) {
  const startY = 250;
  const gap = 82;
  const fontSizes = [56, 34, 34];

  return lines
    .filter(Boolean)
    .map((line, index) => {
      const size = fontSizes[index] || 32;
      const y = startY + (index * gap);
      return `drawtext=fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:text='${escapeDrawtext(line)}'`;
    })
    .join(",");
}

function generateVideo(outputPath, lines) {
  ensureDir(path.dirname(outputPath));
  const filter = buildFilter(lines);
  const ext = path.extname(outputPath).toLowerCase();
  const formatArgs = ext === ".ts" ? ["-f", "mpegts"] : ["-movflags", "+faststart"];

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x111215:s=1280x720:r=30:d=${STATUS_VIDEO_DURATION_SECONDS}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=48000`,
      "-vf",
      filter,
      "-t",
      String(STATUS_VIDEO_DURATION_SECONDS),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-pix_fmt",
      "yuv420p",
      ...formatArgs,
      "-shortest",
      outputPath,
    ],
    {
      stdio: "ignore",
    },
  );
}

function getStatusVideoPath(config, options) {
  const cacheDir = path.join(config.dataDir, "status-videos");
  const keySlug = slugify(options.keyName);
  const kind = ["paused", "suspended", "bandwidth", "insufficient_bandwidth", "intro", "limit"].includes(options.kind) ? options.kind : "limit";
  const limitPart = Number.isInteger(options.limit) ? `-${options.limit}` : "";

  const usedGb = options.bandwidthUsed ? Math.round(options.bandwidthUsed / (1024 ** 3)) : 0;
  const limitGb = options.bandwidthLimit ? Math.round(options.bandwidthLimit / (1024 ** 3)) : 0;
  const neededGb = options.bandwidthNeeded ? (options.bandwidthNeeded / (1024 ** 3)).toFixed(2) : "0.00";
  const remainingGb = Math.max(0, limitGb - usedGb);

  let cacheKey = `${kind}-${keySlug}`;
  if (kind === "limit") {
    cacheKey += `${limitPart}`;
  } else if (kind === "bandwidth" || kind === "insufficient_bandwidth" || kind === "intro") {
    cacheKey += `-u${usedGb}-l${limitGb}-n${neededGb}`;
  }

  const ext = options.format === "ts" ? "ts" : "mp4";
  const filePath = path.join(cacheDir, `${cacheKey}-v${STATUS_VIDEO_VERSION}.${ext}`);

  if (!fs.existsSync(filePath)) {
    let lines = [];
    if (kind === "paused") {
      lines = [
        "Streaming paused",
        `Key: ${options.keyName}`,
        "This key has been paused by the admin.",
      ];
    } else if (kind === "suspended") {
      lines = [
        "Account suspended",
        `User: ${options.keyName}`,
        "Your account has been suspended by the admin.",
      ];
    } else if (kind === "bandwidth") {
      const percent = Math.min(100, Math.max(0, Math.round((remainingGb / limitGb) * 100))) || 0;
      const barLength = 10;
      const filledLength = Math.round((percent / 100) * barLength);
      const emptyLength = barLength - filledLength;
      const bar = "#".repeat(filledLength) + "-".repeat(emptyLength);

      lines = [
        "Bandwidth Limit Reached",
        `Remaining: ${remainingGb}/${limitGb} GB [${bar}]`,
        "Please contact the administrator to upgrade your plan.",
      ];
    } else if (kind === "insufficient_bandwidth") {
      const percent = Math.min(100, Math.max(0, Math.round((remainingGb / limitGb) * 100))) || 0;
      const barLength = 10;
      const filledLength = Math.round((percent / 100) * barLength);
      const emptyLength = barLength - filledLength;
      const bar = "#".repeat(filledLength) + "-".repeat(emptyLength);

      lines = [
        "Insufficient Bandwidth",
        `Remaining: ${remainingGb}/${limitGb} GB [${bar}]`,
        `This video requires ${neededGb} GB to stream.`,
      ];
    } else if (kind === "intro") {
      const percent = Math.min(100, Math.max(0, Math.round((remainingGb / limitGb) * 100))) || 0;
      const barLength = 10;
      const filledLength = Math.round((percent / 100) * barLength);
      const emptyLength = barLength - filledLength;
      const bar = "#".repeat(filledLength) + "-".repeat(emptyLength);

      lines = [
        "Preparing Your Stream...",
        `Quota: ${remainingGb}/${limitGb} GB Left [${bar}]`,
        `Estimated usage: ${neededGb} GB`,
      ];
    } else {
      lines = [
        "Streaming limit reached",
        `Key: ${options.keyName}`,
        `This key is limited to ${options.limit} concurrent stream(s).`,
      ];
    }
    generateVideo(filePath, lines);
  }

  return filePath;
}

module.exports = {
  getStatusVideoPath,
};
