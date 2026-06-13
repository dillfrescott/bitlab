function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseUtcTimestamp(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(" ", "T");
  const isoValue = /(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(isoValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createTimestampFormatter(timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  return (value) => {
    const parsed = parseUtcTimestamp(value);
    return parsed ? formatter.format(parsed) : String(value || "");
  };
}

function layout({ title, body, extraHead = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: rgba(20, 20, 25, 0.7);
      --line: rgba(255, 255, 255, 0.08);
      --line-strong: rgba(255, 255, 255, 0.16);
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-gradient: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      --accent-glow: rgba(59, 130, 246, 0.15);
      --accent-2: #60a5fa;
      --danger: #ef4444;
      --danger-gradient: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
      --danger-ink: #ffffff;
      --success-bg: rgba(16, 185, 129, 0.08);
      --success-line: rgba(16, 185, 129, 0.25);
      --live: #10b981;
      --shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
      --radius: 12px;
      --radius-sm: 8px;
    }
    * { 
      box-sizing: border-box; 
      scrollbar-width: thin;
      scrollbar-color: var(--line-strong) transparent;
    }
    *::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    *::-webkit-scrollbar-track {
      background: transparent;
    }
    *::-webkit-scrollbar-thumb {
      background: var(--line-strong);
      border-radius: 3px;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: var(--muted);
    }
    @keyframes pulse {
      0% { transform: scale(0.85); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.85); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .live-indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: var(--live);
      border-radius: 50%;
      margin-right: 8px;
      vertical-align: middle;
      animation: pulse 2s infinite;
    }
    .reveal-toggle {
      width: auto;
      display: inline-block;
      padding: 6px 12px;
      font-size: 11px;
      background: var(--line-strong);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      transition: all 0.2s ease;
      box-shadow: none;
    }
    .reveal-toggle:hover {
      background: var(--line-strong);
      border-color: var(--accent-2);
    }
    .reveal-secret[hidden] {
      display: none;
    }
    body {
      margin: 0;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      background: var(--bg) url("/static/background.svg") no-repeat fixed center;
      background-size: cover;
      min-height: 100vh;
      line-height: 1.5;
    }
    a { color: var(--accent-2); text-decoration: none; transition: color 0.2s ease; }
    a:hover { text-decoration: underline; color: var(--text); }
    code {
      background: rgba(10, 10, 12, 0.8);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 2px 6px;
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
    }
    .shell, .login-shell {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 60px;
    }
    .login-shell { max-width: 420px; margin-top: 100px; }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 32px;
      padding: 20px 0;
      border-bottom: 1px solid var(--line);
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: clamp(32px, 5vw, 48px);
      line-height: 1.1;
      letter-spacing: -0.04em;
      font-weight: 800;
      background: linear-gradient(135deg, #ffffff 40%, var(--muted) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero p, .small {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .stack, .list {
      display: grid;
      gap: 20px;
    }
    .list { gap: 16px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 8px;
    }
    .stat, .panel, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .stat {
      position: relative;
      overflow: hidden;
    }
    .stat::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--accent-gradient);
    }
    .stat:hover, .card:hover {
      transform: translateY(-2px);
      border-color: var(--line-strong);
      box-shadow: 0 12px 40px 0 rgba(0, 0, 0, 0.5);
    }
    .stat, .panel { padding: 24px; }
    .card { padding: 20px; }
    .eyebrow {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 10px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .value {
      font-size: 36px;
      font-weight: 700;
      line-height: 1;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    .main-grid {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr);
      gap: 20px;
      align-items: start;
    }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 500; }
    input, button {
      width: 100%;
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      border: 1px solid var(--line);
      background: rgba(10, 10, 12, 0.6);
      color: var(--text);
      font: inherit;
      transition: all 0.2s ease;
    }
    input[type="checkbox"] {
      width: auto;
      padding: 0;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
      user-select: none;
    }
    input:hover {
      border-color: var(--line-strong);
    }
    input:focus, button:focus {
      outline: none;
      border-color: var(--accent-2);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    button {
      cursor: pointer;
      font-weight: 600;
      background: var(--accent-gradient);
      color: #ffffff;
      border: none;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(59, 130, 246, 0.35);
      filter: brightness(1.08);
    }
    button:active {
      transform: translateY(0);
    }
    button.danger {
      background: var(--danger-gradient);
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.25);
    }
    button.danger:hover {
      box-shadow: 0 6px 16px rgba(239, 68, 68, 0.35);
    }
    .msg {
      margin: 0 0 24px;
      padding: 14px 18px;
      border-radius: var(--radius-sm);
      background: var(--success-bg);
      border: 1px solid var(--success-line);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.15);
      animation: fadeIn 0.3s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg button {
      width: auto;
      min-width: 32px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      box-shadow: none;
    }
    .msg button:hover {
      color: var(--text);
      transform: none;
      box-shadow: none;
    }
    .chip {
      display: inline-block;
      text-align: center;
      vertical-align: middle;
      line-height: normal;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--line);
      background: rgba(10, 10, 12, 0.6);
      color: var(--muted);
      white-space: nowrap;
    }
    .chip.good { color: #34d399; border-color: rgba(52, 211, 153, 0.2); background: rgba(52, 211, 153, 0.05); }
    .chip.bad { color: #f87171; border-color: rgba(248, 113, 113, 0.2); background: rgba(248, 113, 113, 0.05); }
    .section-title {
      margin: 0 0 20px;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .header-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-shrink: 0;
    }
    .header-actions form {
      display: block;
      margin: 0;
    }
    .header-actions .button-link,
    .header-actions button {
      min-width: 112px;
      padding: 12px 16px;
      white-space: nowrap;
    }
    .muted-block {
      padding-top: 16px;
      border-top: 1px solid var(--line);
    }
    details.revoke-details {
      margin-top: 14px;
    }
    details.revoke-details summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
    }
    details.revoke-details summary::-webkit-details-marker {
      display: none;
    }
    .revoke-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 40px;
      padding: 10px 16px;
      border: 1px solid var(--danger);
      background: transparent;
      color: var(--danger);
      font-weight: 600;
      border-radius: var(--radius-sm);
      transition: all 0.2s ease;
    }
    details.revoke-details[open] .revoke-toggle {
      background: var(--danger);
      color: var(--danger-ink);
    }
    .revoke-form {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }
    .card-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 40px;
      padding: 10px 16px;
      border: 1px solid var(--line-strong);
      background: rgba(255, 255, 255, 0.02);
      color: var(--text);
      font-weight: 600;
      text-decoration: none;
      border-radius: var(--radius-sm);
      transition: all 0.2s ease;
    }
    .button-link:hover {
      text-decoration: none;
      border-color: var(--accent-2);
      background: rgba(255, 255, 255, 0.06);
      transform: translateY(-1px);
    }
    .manifest-link {
      display: inline-block;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
      color: var(--accent-2);
    }
    .kv {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .kv .card {
      min-height: 100%;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin-top: 8px;
    }
    th, td {
      text-align: left;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.015);
    }
    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      border-bottom: 2px solid var(--line-strong);
    }
    td code {
      font-size: 12px;
    }
    @media (max-width: 900px) {
      .stats, .main-grid { grid-template-columns: 1fr; }
      .hero {
        flex-direction: column;
        align-items: flex-start;
      }
      .header-actions {
        width: 100%;
        margin-top: 12px;
      }
      .header-actions form,
      .header-actions button {
        width: 100%;
      }
      .kv {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .shell, .login-shell {
        width: min(100% - 24px, 1120px);
        padding: 24px 0 40px;
      }
      .stat, .panel { padding: 18px; }
      .card { padding: 16px; }
      .card-actions {
        width: 100%;
      }
      .card-actions > * {
        width: 100%;
      }
      .button-link,
      .revoke-toggle {
        width: 100%;
      }
    }
    .captcha-wrapper {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease, margin 0.4s ease;
      overflow: hidden;
      opacity: 0;
      margin: 0;
    }
    .captcha-wrapper.revealed {
      grid-template-rows: 1fr;
      opacity: 1;
      margin: 16px 0;
    }
    .captcha-inner {
      min-height: 0;
    }
  </style>
  ${extraHead}
</head>
<body>
  ${body}
  <script>
    (() => {
      document.addEventListener("click", (e) => {
        const toggle = e.target.closest(".reveal-toggle");
        if (toggle) {
          const container = toggle.closest(".reveal-block");
          if (!container) return;
          const secret = container.querySelector(".reveal-secret");
          if (!secret) return;
          
          const isHidden = secret.hasAttribute("hidden");
          if (isHidden) {
            secret.removeAttribute("hidden");
            toggle.textContent = "Click to Hide";
          } else {
            secret.setAttribute("hidden", "");
            toggle.textContent = "Click to Reveal";
          }
          return;
        }
      });

      const flash = document.querySelector("[data-flash-message]");
      if (flash) {
        const dismiss = flash.querySelector("[data-dismiss-flash]");
        if (dismiss) {
          dismiss.addEventListener("click", () => {
            flash.remove();
          });
        }
      }

      const url = new URL(window.location.href);
      if (url.searchParams.has("msg")) {
        url.searchParams.delete("msg");
        const next = url.pathname + (url.search ? url.search : "") + url.hash;
        window.history.replaceState({}, "", next);
      }
    })();
  </script>
</body>
</html>`;
}

function renderMessage(message) {
  if (!message) {
    return "";
  }
  return `<div class="msg" data-flash-message><div>${escapeHtml(message)}</div><button type="button" aria-label="Dismiss notification" data-dismiss-flash>&times;</button></div>`;
}

function renderLogin(message, nullCaptchaUrl = "") {
  let baseUrl = nullCaptchaUrl;
  if (baseUrl && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = "https://" + baseUrl;
  }

  return layout({
    title: "Login",
    extraHead: baseUrl ? `<script src="${baseUrl}/js/null.js" async defer></script>` : "",
    body: `
      <div class="login-shell">
        <section class="hero">
          <div>
            <h1>Bitlab Admin</h1>
            <p>Admin access panel</p>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="panel">
          <h2 class="section-title">Admin Login</h2>
          <form method="post" action="/admin/login">
            <label>Password
              <input type="password" name="password" placeholder="ADMIN_PASSWORD" required />
            </label>
            ${
              baseUrl
                ? `
                <div class="captcha-wrapper">
                  <div class="captcha-inner">
                    <div id="null-captcha-widget" style="margin: 0 auto; display: flex; justify-content: center;"></div>
                  </div>
                </div>
                <input type="hidden" name="null-captcha-token" id="null-captcha-token" />
                `
                : ""
            }
            <button type="submit">Sign In</button>
          </form>
        </section>
      </div>
      ${
        baseUrl
          ? `
          <script>
            (() => {
              const form = document.querySelector('form[action="/admin/login"]');
              if (!form) return;

              window.addEventListener('load', () => {
                const initCaptcha = () => {
                  if (window.NullCaptcha) {
                    window.NullCaptcha.render('null-captcha-widget', {
                      onSuccess: (token) => {
                        const input = document.getElementById('null-captcha-token');
                        if (input) {
                          input.value = token;
                        }
                        form.submit();
                      },
                      onFailure: (error) => {
                        console.error("CAPTCHA Verification Failed:", error);
                      }
                    });
                  } else {
                    setTimeout(initCaptcha, 100);
                  }
                };
                initCaptcha();
              });

              form.addEventListener('submit', (e) => {
                const wrapper = document.querySelector('.captcha-wrapper');
                if (wrapper && !wrapper.classList.contains('revealed')) {
                  e.preventDefault();
                  wrapper.classList.add('revealed');
                  return;
                }

                const tokenInput = document.getElementById('null-captcha-token');
                if (!tokenInput || !tokenInput.value) {
                  e.preventDefault();
                  alert("Please verify the CAPTCHA first.");
                }
              });
            })();
          </script>
          `
          : ""
      }
    `,
  });
}

function renderDashboard({ baseUrl, activeKeys, totalActiveStreams, bitmagnetStatus, message }) {
  const activeKeyCards = activeKeys
    .map(
      (key) => `
        <article class="card" data-key-id="${key.id}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <strong>${escapeHtml(key.name)}</strong>
            <span data-key-live-indicator>${key.activeStreams > 0 ? '<span class="live-indicator" title="Active stream"></span>' : ""}</span>
          </div>
          <div class="small">Created ${escapeHtml(key.created_at)}</div>
          <div class="small" style="margin-top: 8px;">Status: <span data-key-status>${key.paused_at ? "Paused" : "Active"}</span></div>
          <div class="small" style="margin-top: 8px;">Concurrent streams: <span data-key-active-streams>${key.activeStreams}</span> / ${escapeHtml(key.max_concurrent_streams)}</div>
          <div class="reveal-block" style="margin-top: 8px;">
            <button type="button" class="reveal-toggle">Click to Reveal</button>
            <div class="reveal-secret" hidden>
              <div class="small" style="margin-top: 8px;"><code>${escapeHtml(key.token)}</code></div>
              <div class="small" style="margin-top: 8px;">
                <a class="manifest-link" href="${escapeHtml(baseUrl)}/${escapeHtml(key.token)}/manifest.json" target="_blank">${escapeHtml(
                  baseUrl,
                )}/${escapeHtml(key.token)}/manifest.json</a>
              </div>
            </div>
          </div>
          <div class="card-actions">
            <a class="button-link" href="/admin/keys/${key.id}">Manage</a>
          </div>
        </article>
      `,
    )
    .join("");

  const statusChip = bitmagnetStatus.ok === null
    ? '<span class="chip">Loading…</span>'
    : bitmagnetStatus.ok
      ? '<span class="chip good">reachable</span>'
      : '<span class="chip bad">unreachable</span>';

  return layout({
    title: "Admin Dashboard",
    body: `
      <div class="shell" data-dashboard>
        <section class="hero">
          <div>
            <h1>Admin</h1>
            <p>Manage addon keys and check the upstream connection.</p>
          </div>
          <div class="header-actions">
            <a class="button-link" href="/admin/sessions">Sessions</a>
            <a class="button-link" href="/admin/bitmagnet/" target="_blank">Bitmagnet UI</a>
            <form method="post" action="/admin/logout">
              <button class="danger" type="submit">Logout</button>
            </form>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="stats">
          <a href="/admin/bitmagnet/" style="text-decoration: none; color: inherit;" target="_blank">
            <article class="stat" style="cursor: pointer;">
              <div class="eyebrow">Bitmagnet</div>
              <div class="value" data-stat-bitmagnet-value>${bitmagnetStatus.ok === null ? "Loading…" : bitmagnetStatus.ok ? "Live" : "Down"}</div>
              <div class="small" data-stat-bitmagnet-chip>${statusChip}</div>
            </article>
          </a>
          <article class="stat">
            <div class="eyebrow">Total Streams</div>
            <div class="value" data-stat-total-streams>${totalActiveStreams}</div>
            <div class="small">currently active</div>
          </article>
          <article class="stat">
            <div class="eyebrow">Keys</div>
            <div class="value">${escapeHtml(activeKeys.length)}</div>
            <div class="small">active tokens</div>
          </article>
          <article class="stat">
            <div class="eyebrow">Manifest</div>
            <div class="value">Ready</div>
            <div class="small"><code>${escapeHtml(baseUrl)}</code></div>
          </article>
        </section>
        <section class="main-grid" style="margin-top: 16px;">
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Create Key</h2>
              <form method="post" action="/admin/keys">
                <label>Key Name
                  <input name="name" placeholder="Main install" required />
                </label>
                <button type="submit">Create Key</button>
              </form>
              <div class="small muted-block">Create a tokenized manifest for an install.</div>
            </article>
            <article class="stat">
              <div class="eyebrow">Postgres DB & Disk</div>
              <div class="value" data-stat-postgres-value>Loading…</div>
              <div class="small" data-stat-postgres-sub>checking stats</div>
            </article>
          </div>
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Keys</h2>
              <div class="list">${activeKeyCards || '<div class="small">No keys yet.</div>'}</div>
            </article>
          </div>
        </section>
      </div>
      <script>
        (() => {
          if (!document.querySelector("[data-dashboard]")) return;

          async function updateDashboard() {
            try {
              const res = await fetch("/admin/api/status");
              if (!res.ok) return;
              const data = await res.json();

              // Update bitmagnet status
              const bitVal = document.querySelector("[data-stat-bitmagnet-value]");
              if (bitVal) bitVal.textContent = data.bitmagnet.ok ? "Live" : "Down";
              const bitChip = document.querySelector("[data-stat-bitmagnet-chip]");
              if (bitChip) {
                bitChip.innerHTML = data.bitmagnet.ok
                  ? '<span class="chip good">reachable</span>'
                  : '<span class="chip bad">unreachable</span>';
              }

              // Update total streams
              const totalVal = document.querySelector("[data-stat-total-streams]");
              if (totalVal) totalVal.textContent = data.totalActiveStreams;

              // Update postgres status
              const pgVal = document.querySelector("[data-stat-postgres-value]");
              const pgSub = document.querySelector("[data-stat-postgres-sub]");
              if (pgVal && data.postgres) {
                if (data.postgres.hasStats) {
                  pgVal.textContent = \`\${data.postgres.dbSizeFormatted} / \${data.postgres.volumeTotalFormatted}\`;
                  if (pgSub) {
                    pgSub.textContent = \`\${data.postgres.freePercent}% free space remaining\`;
                  }
                } else {
                  pgVal.textContent = "N/A";
                  if (pgSub) pgSub.textContent = "db connection offline";
                }
              }

              // Update and re-order key cards
              const list = document.querySelector(".list");

              data.activeKeys.forEach((key, index) => {
                const card = document.querySelector(\`[data-key-id="\${key.id}"]\`);
                if (!card) return;

                const indicator = card.querySelector("[data-key-live-indicator]");
                if (indicator) {
                  indicator.innerHTML = key.activeStreams > 0
                    ? '<span class="live-indicator" title="Active stream"></span>'
                    : "";
                }

                const status = card.querySelector("[data-key-status]");
                if (status) status.textContent = key.paused ? "Paused" : "Active";

                const active = card.querySelector("[data-key-active-streams]");
                if (active) active.textContent = key.activeStreams;

                // Move card to its sorted position (always append to ensure correct order)
                if (list) {
                  list.appendChild(card);
                }
              });
              if (data.activeKeys.length > 0) {
                console.log("Dashboard updated and re-ordered", data.activeKeys.map(k => k.id));
              }
            } catch (err) {
              console.error("Failed to update dashboard:", err);
            }
          }

          updateDashboard();
          setInterval(updateDashboard, 2000);
        })();
      </script>
    `,
  });
}

function renderKeyDetails({
  baseUrl,
  key,
  activeStreams,
  activePlaybackHashes = [],
  watchHistory,
  watchHistoryHasMore = false,
  watchHistoryLimit = 5,
  watchHistoryStep = 10,
  message,
  timezone,
}) {
  const formatTimestamp = createTimestampFormatter(timezone || "UTC");
  const watchRows = watchHistory
    .map((entry) => {
      const episodeLabel =
        Number.isInteger(entry.season) && Number.isInteger(entry.episode)
          ? `S${String(entry.season).padStart(2, "0")}E${String(entry.episode).padStart(2, "0")}`
          : "";

      const isLive = activePlaybackHashes.includes(entry.playback_token_hash);

      return `
        <tr data-history-id="${entry.id}" data-playback-hash="${entry.playback_token_hash}">
          <td>
            <div style="display: flex; align-items: center;">
              <span data-live-indicator-container>${isLive ? '<span class="live-indicator" title="Active stream"></span>' : ""}</span>
              <div>
                <strong>${escapeHtml(entry.media_title)}</strong>
                <div class="small">${escapeHtml(entry.media_type || "unknown")}${episodeLabel ? ` | ${escapeHtml(episodeLabel)}` : ""}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(entry.release_name || entry.file_name || "n/a")}</td>
          <td>${entry.info_hash ? `<code>${escapeHtml(entry.info_hash)}</code>` : '<span class="small">n/a</span>'}</td>
          <td>${escapeHtml(formatTimestamp(entry.watched_at))}</td>
        </tr>
      `;
    })
    .join("");
  const nextWatchHistoryLimit = watchHistoryLimit + watchHistoryStep;

  return layout({
    title: `Key ${key.name}`,
    body: `
      <div class="shell" data-key-details="${key.id}">
        <section class="hero">
          <div>
            <h1>${escapeHtml(key.name)}</h1>
            <p>Per-key stream limits and watch history.</p>
          </div>
          <div class="header-actions">
            <a class="button-link" href="/admin">Back</a>
            <form method="post" action="/admin/logout">
              <button class="danger" type="submit">Logout</button>
            </form>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="kv">
          <article class="card reveal-block">
            <div class="eyebrow">Manifest</div>
            <button type="button" class="reveal-toggle">Click to Reveal</button>
            <div class="reveal-secret" style="margin-top: 8px;" hidden>
              <div class="small">
                <a class="manifest-link" href="${escapeHtml(baseUrl)}/${escapeHtml(key.token)}/manifest.json" target="_blank">${escapeHtml(baseUrl)}/${escapeHtml(key.token)}/manifest.json</a>
              </div>
            </div>
          </article>
          <article class="card">
            <div class="eyebrow">Current Streams</div>
            <div class="value" data-key-active-streams>${escapeHtml(activeStreams)}</div>
            <div class="small">active playback responses right now</div>
          </article>
        </section>
        <section class="main-grid" style="margin-top: 16px;">
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Concurrency Limit</h2>
              <form method="post" action="/admin/keys/${key.id}/settings">
                <label>Max concurrent streams
                  <input type="number" min="1" step="1" name="maxConcurrentStreams" value="${escapeHtml(key.max_concurrent_streams)}" required />
                </label>
                <button type="submit">Save Limit</button>
              </form>
              <div class="small muted-block">This key is blocked when it already has the configured number of active streams.</div>
            </article>
            <article class="panel">
              <h2 class="section-title">Access State</h2>
              <div class="small">Current state: <span data-key-status-text>${key.paused_at ? `Paused since ${escapeHtml(key.paused_at)}` : "Active"}</span></div>
              <form method="post" action="/admin/keys/${key.id}/${key.paused_at ? "resume" : "pause"}" style="margin-top: 12px;">
                <button class="${key.paused_at ? "" : "danger"}" type="submit">${key.paused_at ? "Resume Key" : "Pause Key"}</button>
              </form>
            </article>
            <article class="panel">
              <h2 class="section-title">Key Details</h2>
              <form method="post" action="/admin/keys/${key.id}/rename" style="margin-bottom: 12px;">
                <label>Key Name
                  <input name="name" value="${escapeHtml(key.name)}" required />
                </label>
                <button type="submit">Rename Key</button>
              </form>
              <div class="small">Created ${escapeHtml(key.created_at)}</div>
              <details class="revoke-details" style="margin-top: 12px;">
                <summary><span class="revoke-toggle">Revoke</span></summary>
                <form class="revoke-form" method="post" action="/admin/keys/${key.id}/revoke">
                  <label class="small">
                    Type <code>${escapeHtml(key.name)}</code> to revoke
                    <input name="confirmName" placeholder="${escapeHtml(key.name)}" required />
                  </label>
                  <button class="danger" type="submit">Revoke Key</button>
                </form>
              </details>
            </article>
          </div>
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Watch History</h2>
              <div class="small" style="margin-bottom: 12px;">Displayed in ${escapeHtml(timezone || "UTC")}. Showing <span data-watch-history-count>${watchHistory.length}</span> most recent entr<span data-watch-history-plural>${watchHistory.length === 1 ? "y" : "ies"}</span>.</div>
              <div data-watch-history-container>
              ${
                watchRows
                  ? `<table>
                      <thead>
                        <tr>
                          <th>Media</th>
                          <th>Release</th>
                          <th>Info Hash</th>
                          <th>Watched At</th>
                        </tr>
                      </thead>
                      <tbody data-watch-history-body>${watchRows}</tbody>
                    </table>`
                  : '<div class="small">No plays logged for this key yet.</div>'
              }
              </div>
              ${
                watchHistoryHasMore
                  ? `<form method="get" action="/admin/keys/${key.id}" style="margin-top: 12px;">
                      <input type="hidden" name="historyLimit" value="${escapeHtml(nextWatchHistoryLimit)}" />
                      <button type="submit">See More</button>
                    </form>`
                  : ""
              }
            </article>
          </div>
        </section>
      </div>
      <script>
        (() => {
          const shell = document.querySelector("[data-key-details]");
          if (!shell) return;
          const keyId = shell.getAttribute("data-key-details");
          const timezone = "${escapeHtml(timezone || "UTC")}";

          function escapeHtml(value) {
            return String(value || "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function formatTimestamp(value) {
            if (!value) return "";
            try {
              const isoValue = String(value).replace(" ", "T");
              const parsed = new Date(isoValue.endsWith("Z") ? isoValue : \`\${isoValue}Z\`);
              return new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                year: "numeric", month: "2-digit", day: "2-digit",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                hour12: false, timeZoneName: "short"
              }).format(parsed);
            } catch (e) { return String(value); }
          }

          async function updateKeyDetails() {
            try {
              const url = new URL(\`/admin/api/keys/\${keyId}\`, window.location.origin);
              const params = new URLSearchParams(window.location.search);
              if (params.has("historyLimit")) {
                url.searchParams.set("historyLimit", params.get("historyLimit"));
              }

              const res = await fetch(url);
              if (!res.ok) return;
              const data = await res.json();

              const activeStreams = document.querySelector("[data-key-active-streams]");
              if (activeStreams) activeStreams.textContent = data.activeStreams;

              const statusText = document.querySelector("[data-key-status-text]");
              if (statusText) statusText.textContent = data.paused ? "Paused" : "Active";

              const watchHistoryBody = document.querySelector("[data-watch-history-body]");
              const watchHistoryContainer = document.querySelector("[data-watch-history-container]");
              const watchCount = document.querySelector("[data-watch-history-count]");
              const watchPlural = document.querySelector("[data-watch-history-plural]");

              if (data.watchHistory && data.watchHistory.length > 0) {
                const activeHashes = data.activePlaybackHashes || [];
                const rows = data.watchHistory.map(entry => {
                  const episodeLabel = (Number.isInteger(entry.season) && Number.isInteger(entry.episode))
                    ? \`S\${String(entry.season).padStart(2, "0")}E\${String(entry.episode).padStart(2, "0")}\`
                    : "";
                  
                  const isLive = activeHashes.includes(entry.playback_token_hash);
                  
                  return \`
                    <tr data-history-id="\${entry.id}" data-playback-hash="\${entry.playback_token_hash}">
                      <td>
                        <div style="display: flex; align-items: center;">
                          <span data-live-indicator-container>\${isLive ? '<span class="live-indicator" title="Active stream"></span>' : ""}</span>
                          <div>
                            <strong>\${escapeHtml(entry.media_title)}</strong>
                            <div class="small">\${escapeHtml(entry.media_type || "unknown")}\${episodeLabel ? " | " + escapeHtml(episodeLabel) : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td>\${escapeHtml(entry.release_name || entry.file_name || "n/a")}</td>
                      <td>\${entry.info_hash ? "<code>" + escapeHtml(entry.info_hash) + "</code>" : '<span class="small">n/a</span>'}</td>
                      <td>\${escapeHtml(formatTimestamp(entry.watched_at))}</td>
                    </tr>
                  \`;
                }).join("");

                if (watchHistoryBody) {
                  watchHistoryBody.innerHTML = rows;
                } else if (watchHistoryContainer) {
                  watchHistoryContainer.innerHTML = \`
                    <table>
                      <thead>
                        <tr><th>Media</th><th>Release</th><th>Info Hash</th><th>Watched At</th></tr>
                      </thead>
                      <tbody data-watch-history-body>\${rows}</tbody>
                    </table>
                  \`;
                }

                if (watchCount) watchCount.textContent = data.watchHistory.length;
                if (watchPlural) watchPlural.textContent = data.watchHistory.length === 1 ? "y" : "ies";
              }
            } catch (err) {
              console.error("Failed to update key details:", err);
            }
          }

          setInterval(updateKeyDetails, 2000);
        })();
      </script>
    `,
  });
}

function formatUserAgent(ua) {
  if (!ua) return "Unknown Device";
  let browser = "Unknown Browser";
  let os = "Unknown OS";

  if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/")) browser = "Safari";
  else if (ua.includes("Edge/")) browser = "Edge";
  else if (ua.includes("Opera/") || ua.includes("OPR/")) browser = "Opera";

  if (ua.includes("Windows NT")) os = "Windows";
  else if (ua.includes("Macintosh") || ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  return `${browser} on ${os}`;
}

function renderSessions({ sessions, currentSessionToken, timezone, message }) {
  const formatTimestamp = createTimestampFormatter(timezone || "UTC");

  const sessionRows = sessions.map((session) => {
    const isCurrent = session.token === currentSessionToken;
    const uaInfo = formatUserAgent(session.user_agent);

    return `
      <tr data-session-id="${session.id}">
        <td>
          <form method="post" action="/admin/sessions/${session.id}/rename" style="display: flex; align-items: center; gap: 8px;">
            <input type="text" name="name" value="${escapeHtml(session.name)}" required style="padding: 6px 12px; font-size: 0.9em; border-radius: var(--radius-sm); border: 1px solid var(--line); background: rgba(10, 10, 12, 0.6); color: var(--text); width: 220px;" />
            <button type="submit" style="padding: 6px 12px; font-size: 0.8em; margin: 0; min-height: unset; line-height: 1.2; width: auto;">Rename</button>
          </form>
        </td>
        <td>
          <div class="small" style="font-weight: 500;">${escapeHtml(uaInfo)}</div>
          <div class="small" style="font-size: 0.85em; opacity: 0.6; word-break: break-all; max-width: 300px; margin-top: 4px;">${escapeHtml(session.user_agent)}</div>
        </td>
        <td style="white-space: nowrap;"><code>${escapeHtml(session.ip_address)}</code></td>
        <td><span class="small">${escapeHtml(formatTimestamp(session.created_at))}</span></td>
        <td><span class="small">${escapeHtml(formatTimestamp(session.last_active_at))}</span></td>
        <td>
          ${isCurrent ? '<span class="chip good">Current Session</span>' : '<span class="chip">Active</span>'}
        </td>
        <td>
          <form method="post" action="/admin/sessions/${session.id}/revoke" style="margin: 0;" onsubmit="return ${isCurrent ? 'confirm(\'Are you sure you want to revoke your current session? You will be logged out immediately.\')' : 'true'};">
            <button class="danger" type="submit" style="padding: 6px 12px; font-size: 0.8em; margin: 0; min-height: unset; line-height: 1.2; width: auto;">Revoke</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return layout({
    title: "Manage Sessions",
    body: `
      <div class="shell">
        <section class="hero">
          <div>
            <h1>Admin Sessions</h1>
            <p>Manage all active administrator sessions.</p>
          </div>
          <div class="header-actions">
            <a class="button-link" href="/admin">Back to Dashboard</a>
            <form method="post" action="/admin/logout">
              <button class="danger" type="submit">Logout</button>
            </form>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="main-grid" style="margin-top: 16px; grid-template-columns: 1fr;">
          <article class="panel">
            <h2 class="section-title">Active Sessions</h2>
            <div class="small" style="margin-bottom: 12px; opacity: 0.6;">Showing active sessions logged into this admin panel. Revoking a session will force that device to log in again.</div>
            <div style="overflow-x: auto;">
              <table>
                <thead>
                  <tr>
                    <th>Session Name</th>
                    <th>Device / User Agent</th>
                    <th>IP Address</th>
                    <th>Created At</th>
                    <th>Last Active</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${sessionRows || '<tr><td colspan="7" class="small" style="text-align: center;">No active sessions found.</td></tr>'}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </div>
    `,
  });
}

module.exports = {
  renderLogin,
  renderDashboard,
  renderKeyDetails,
  renderSessions,
};
