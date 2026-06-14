const express = require("express");
const { getConfig } = require("./config");
const { createAddonInterface } = require("./stremio");
const { createBitmagnetService } = require("./bitmagnet");
const { renderLandingPage } = require("./views");

const config = getConfig();
const bitmagnet = createBitmagnetService(config);
const addonInterface = createAddonInterface({ config, bitmagnet });
const app = express();

app.set("trust proxy", true);
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});
app.use(express.json({ limit: "2mb" }));

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const requestBaseUrl = `${protocol}://${req.get("host")}`;

  if (config.baseUrl) {
    try {
      const configured = new URL(config.baseUrl);
      const requestUrl = new URL(requestBaseUrl);
      const configuredHost = configured.hostname.toLowerCase();
      const requestHost = requestUrl.hostname.toLowerCase();
      const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
      if (!(loopbackHosts.has(configuredHost) && !loopbackHosts.has(requestHost))) {
        return config.baseUrl.replace(/\/$/, "");
      }
    } catch (_error) {
      return config.baseUrl.replace(/\/$/, "");
    }
  }
  return requestBaseUrl;
}

// ─── Static assets ────────────────────────────────────────────────────────────

app.get("/static/favicon.svg", (_req, res) => {
  res.type("image/svg+xml").send(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#171717"/>
      <path d="M10 8V16C10 19.3137 12.6863 22 16 22C19.3137 22 22 19.3137 22 16V8H18V16C18 17.1046 17.1046 18 16 18C14.8954 18 14 17.1046 14 16V8H10Z" fill="#7ea2ff"/>
      <rect x="10" y="8" width="4" height="3" fill="#f2f2f2"/>
      <rect x="18" y="8" width="4" height="3" fill="#f2f2f2"/>
    </svg>
  `);
});

// ─── Landing page ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const baseUrl = getBaseUrl(req);
  const addonUrl = `${baseUrl}/manifest.json`;
  res.send(renderLandingPage({ addonUrl }));
});

// ─── Addon manifest (public, no key) ─────────────────────────────────────────

app.get("/manifest.json", (req, res) => {
  res.json(addonInterface.manifest);
});

// ─── Addon resource handlers ──────────────────────────────────────────────────

async function handleAddonResource(req, res, resource, extraFromPath = false) {
  const extra = { ...req.query };
  if (extraFromPath && req.params.extra) {
    for (const [rawKey, rawValue] of new URLSearchParams(req.params.extra)) {
      extra[rawKey] = rawValue;
    }
  }

  try {
    console.log(`[addon] ${resource} ${req.params.type} id=${req.params.id}`);
    const response = await addonInterface.get(
      resource,
      req.params.type,
      req.params.id,
      extra,
      {
        baseUrl: getBaseUrl(req),
      },
    );
    if (resource === "stream") {
      console.log(`[addon] stream result count=${Array.isArray(response.streams) ? response.streams.length : 0}`);
    } else if (resource === "meta") {
      console.log(`[addon] meta found=${Boolean(response.meta)}`);
    }
    res.json(response);
  } catch (error) {
    console.error(`[addon] ${resource} error: ${error.message}`);
    res.status(500).json({ err: error.message || "handler error" });
  }
}

app.get("/meta/:type/:id.json", (req, res) => handleAddonResource(req, res, "meta", false));
app.get("/meta/:type/:id/:extra.json", (req, res) => handleAddonResource(req, res, "meta", true));
app.get("/stream/:type/:id.json", (req, res) => handleAddonResource(req, res, "stream", false));
app.get("/stream/:type/:id/:extra.json", (req, res) => handleAddonResource(req, res, "stream", true));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const bitmagnetStatus = await bitmagnet.getStatus();
  res.json({
    ok: bitmagnetStatus.ok,
    bitmagnet: bitmagnetStatus,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = config.port;
app.listen(port, () => {
  console.log(`Bitlab listening on http://localhost:${port}`);
  console.log(`Addon manifest: http://localhost:${port}/manifest.json`);
});
