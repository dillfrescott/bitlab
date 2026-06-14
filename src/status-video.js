const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const STATUS_VIDEO_DURATION_SECONDS = 10;
const STATUS_VIDEO_VERSION = 3;

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
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x00a651:s=1280x720:r=30:d=${STATUS_VIDEO_DURATION_SECONDS}`,
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
      "-movflags",
      "+faststart",
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
  const kind = options.kind === "paused" ? options.kind : "limit";
  const limitPart = Number.isInteger(options.limit) ? `-${options.limit}` : "";
  const filePath = path.join(cacheDir, `${kind}-${keySlug}${limitPart}-v${STATUS_VIDEO_VERSION}.mp4`);

  if (!fs.existsSync(filePath)) {
    const lines =
      kind === "paused"
        ? [
            "Streaming paused",
            `Key: ${options.keyName}`,
            "This key has been paused by the admin.",
          ]
        : [
            "Streaming limit reached",
            `Key: ${options.keyName}`,
            `This key is limited to ${options.limit} concurrent stream(s).`,
          ];
    generateVideo(filePath, lines);
  }

  return filePath;
}

module.exports = {
  getStatusVideoPath,
};
