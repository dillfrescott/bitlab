const crypto = require("node:crypto");

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function timingSafeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function issueSession(secret, ttlMs) {
  const payload = JSON.stringify({
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(12).toString("hex"),
  });
  const body = base64UrlEncode(payload);
  return `${body}.${signPayload(body, secret)}`;
}

function verifySession(token, secret) {
  if (!token || !token.includes(".")) {
    return false;
  }

  const [body, signature] = token.split(".");
  const expected = signPayload(body, secret);
  if (!timingSafeCompare(signature, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    return Number(payload.exp) > Date.now();
  } catch (_error) {
    return false;
  }
}

function createPlaybackToken({ keyToken, stream, secret, ttlMs }) {
  const payload = JSON.stringify({
    keyToken,
    stream,
    exp: Date.now() + ttlMs,
  });
  const body = base64UrlEncode(payload);
  return `${body}.${signPayload(body, secret)}`;
}

function verifyPlaybackToken(token, secret) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [body, signature] = token.split(".");
  const expected = signPayload(body, secret);
  if (!timingSafeCompare(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (Number(payload.exp) <= Date.now()) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function hashPassword(password) {
  const salt = "bitmagnet-stremio-salt-128374981";
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

function generateOpaqueToken() {
  return crypto.randomBytes(24).toString("base64url");
}

module.exports = {
  issueSession,
  verifySession,
  createPlaybackToken,
  verifyPlaybackToken,
  hashPassword,
  generateOpaqueToken,
  timingSafeCompare,
};
