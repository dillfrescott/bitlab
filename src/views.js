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

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
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

function renderLogin(message, nullcaptchaUrl = "") {
  return layout({
    title: "Bitlab Admin Login",
    extraHead: nullcaptchaUrl ? `<script src="${nullcaptchaUrl.replace(/\/$/, "")}/js/null.js" async defer></script>` : "",
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
          <form class="needs-nullcaptcha" method="post" action="/admin/login">
            <label>Password
              <input type="password" name="password" placeholder="ADMIN_PASSWORD" required />
            </label>
            ${
              nullcaptchaUrl
                ? `<div id="nullcaptcha-container" style="display: none; margin: 16px 0; justify-content: center;"></div>`
                : ""
            }
            <button type="submit">Sign In</button>
          </form>
        </section>
      </div>
      ${
        nullcaptchaUrl
          ? `
          <script>
            (() => {
              const form = document.querySelector('.needs-nullcaptcha');
              if (!form) return;
              
              form.addEventListener('submit', async (e) => {
                let tokenInput = form.querySelector('[name="nullcaptcha-response"]');
                if (tokenInput && tokenInput.value) {
                  return;
                }

                e.preventDefault();
                const container = document.getElementById('nullcaptcha-container');
                if (!container) return;
                
                container.style.display = 'flex';
                
                if (!container.querySelector('#null-captcha-widget')) {
                  window.NullCaptcha.render(container, {
                    onSuccess: (token) => {
                      if (!tokenInput) {
                        tokenInput = document.createElement('input');
                        tokenInput.type = 'hidden';
                        tokenInput.name = 'nullcaptcha-response';
                        form.appendChild(tokenInput);
                      }
                      tokenInput.value = token;
                      setTimeout(() => {
                        form.submit();
                      }, 500);
                    },
                    onFailure: (err) => {
                      console.error("Null CAPTCHA error:", err);
                    }
                  });
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

function renderUserLogin(message, nullcaptchaUrl = "") {
  return layout({
    title: "Sign In - Bitlab",
    extraHead: nullcaptchaUrl ? `<script src="${nullcaptchaUrl.replace(/\/$/, "")}/js/null.js" async defer></script>` : "",
    body: `
      <div class="login-shell">
        <section class="hero">
          <div>
            <h1>Bitlab</h1>
            <p>Access your streaming dashboard</p>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="panel">
          <h2 class="section-title">User Sign In</h2>
          <form class="needs-nullcaptcha" method="post" action="/login">
            <label>Username
              <input type="text" name="username" placeholder="Enter username" required />
            </label>
            <label>Password
              <input type="password" name="password" placeholder="Enter password" required />
            </label>
            ${
              nullcaptchaUrl
                ? `<div id="nullcaptcha-container" style="display: none; margin: 16px 0; justify-content: center;"></div>`
                : ""
            }
            <button type="submit">Sign In</button>
          </form>
        </section>
      </div>
      ${
        nullcaptchaUrl
          ? `
          <script>
            (() => {
              const form = document.querySelector('.needs-nullcaptcha');
              if (!form) return;
              
              form.addEventListener('submit', async (e) => {
                let tokenInput = form.querySelector('[name="nullcaptcha-response"]');
                if (tokenInput && tokenInput.value) {
                  return;
                }

                e.preventDefault();
                const container = document.getElementById('nullcaptcha-container');
                if (!container) return;
                
                container.style.display = 'flex';
                
                if (!container.querySelector('#null-captcha-widget')) {
                  window.NullCaptcha.render(container, {
                    onSuccess: (token) => {
                      if (!tokenInput) {
                        tokenInput = document.createElement('input');
                        tokenInput.type = 'hidden';
                        tokenInput.name = 'nullcaptcha-response';
                        form.appendChild(tokenInput);
                      }
                      tokenInput.value = token;
                      setTimeout(() => {
                        form.submit();
                      }, 500);
                    },
                    onFailure: (err) => {
                      console.error("Null CAPTCHA error:", err);
                    }
                  });
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

function renderDashboard({ baseUrl, users, totalActiveStreams, bitmagnetStatus, message }) {
  const userCards = users
    .map(
      (user) => {
        const used = user.bandwidth_used;
        const limit = user.bandwidth_limit;
        const percent = Math.min(100, Math.round((used / limit) * 100)) || 0;
        let barColor = "var(--live)";
        if (percent > 85) barColor = "var(--danger)";
        else if (percent > 60) barColor = "#f59e0b";

        const statusChip = user.is_suspended
          ? '<span class="chip bad">Suspended</span>'
          : '<span class="chip good">Active</span>';

        return `
        <article class="card" data-user-id="${user.id}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <strong>${escapeHtml(user.username)}</strong>
            <span data-user-live-indicator>${user.activeStreams > 0 ? '<span class="live-indicator" title="Active stream"></span>' : ""}</span>
          </div>
          <div class="small">Created ${escapeHtml(user.created_at)}</div>
          <div class="small" style="margin-top: 8px; display: flex; align-items: center; gap: 6px;">
            Status: ${statusChip}
          </div>
          <div class="small" style="margin-top: 8px;">
            Bandwidth: <strong>${escapeHtml(formatBytes(used))}</strong> / ${escapeHtml(formatBytes(limit))}
            <div class="progress-container" style="background: rgba(255, 255, 255, 0.05); border-radius: 999px; height: 8px; width: 100%; overflow: hidden; margin: 6px 0; border: 1px solid var(--line);">
              <div class="progress-bar" style="height: 100%; border-radius: 999px; width: ${percent}%; background-color: ${barColor};"></div>
            </div>
            <div class="small" style="font-size: 0.85em; opacity: 0.7;">Resets next: ${escapeHtml(createTimestampFormatter("UTC")(user.bandwidth_reset_at))}</div>
          </div>
          <div class="small" style="margin-top: 8px;">Concurrent streams: <span data-user-active-streams>${user.activeStreams}</span></div>
          <div class="card-actions" style="margin-top: 12px; padding-top: 12px; display: flex; gap: 8px;">
            <a class="button-link" href="/admin/users/${user.id}">Manage</a>
          </div>
        </article>
      `;
      }
    )
    .join("");

  const statusChip = bitmagnetStatus.ok === null
    ? '<span class="chip">Loading…</span>'
    : bitmagnetStatus.ok
      ? '<span class="chip good">reachable</span>'
      : '<span class="chip bad">unreachable</span>';

  return layout({
    title: "Bitlab Admin Dashboard",
    body: `
      <div class="shell" data-dashboard>
        <section class="hero">
          <div>
            <h1>Admin Dashboard</h1>
            <p>Manage users, bandwidth quotas, and check upstream connection.</p>
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
            <div class="eyebrow">Users</div>
            <div class="value">${escapeHtml(users.length)}</div>
            <div class="small">registered accounts</div>
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
              <h2 class="section-title">Create User</h2>
              <form method="post" action="/admin/users">
                <label>Username
                  <input name="username" placeholder="john_doe" required autocomplete="off" />
                </label>
                <label>Password
                  <input type="password" name="password" placeholder="••••••••" required />
                </label>
                <label>Monthly Bandwidth Limit (GB)
                  <input type="number" name="bandwidthLimitGb" value="100" min="1" required />
                </label>
                <label>Max Keys / Sub-Users
                  <input type="number" name="maxKeys" value="5" min="1" required />
                </label>
                <button type="submit">Create User</button>
              </form>
            </article>
            <article class="stat">
              <div class="eyebrow">Postgres DB & Disk</div>
              <div class="value" data-stat-postgres-value>Loading…</div>
              <div class="small" data-stat-postgres-sub>checking stats</div>
            </article>
          </div>
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Users</h2>
              <div class="list">${userCards || '<div class="small">No users yet.</div>'}</div>
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

              // Update and re-order user cards
              const list = document.querySelector(".list");

              data.users.forEach((user, index) => {
                const card = document.querySelector(\`[data-user-id="\${user.id}"]\`);
                if (!card) return;

                const indicator = card.querySelector("[data-user-live-indicator]");
                if (indicator) {
                  indicator.innerHTML = user.activeStreams > 0
                    ? '<span class="live-indicator" title="Active stream"></span>'
                    : "";
                }

                const active = card.querySelector("[data-user-active-streams]");
                if (active) active.textContent = user.activeStreams;

                // Move card to its sorted position
                if (list) {
                  list.appendChild(card);
                }
              });
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

function renderUserDetails({
  baseUrl,
  user,
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

  const used = user.bandwidth_used;
  const limit = user.bandwidth_limit;
  const percent = Math.min(100, Math.round((used / limit) * 100)) || 0;

  return layout({
    title: `User ${user.username} Details`,
    body: `
      <div class="shell" data-user-details="${user.id}">
        <section class="hero">
          <div>
            <h1>User: ${escapeHtml(user.username)}</h1>
            <p>Manage limits, passwords, status, and view watch history.</p>
          </div>
          <div class="header-actions">
            <a class="button-link" href="/admin">Back</a>
            <form method="post" action="/admin/logout">
              <button class="danger" type="submit">Logout</button>
            </form>
          </div>
        </section>
        ${renderMessage(message)}
        <section class="stats">
          <article class="stat" style="grid-column: span 2;">
            <div class="eyebrow">Bandwidth Used</div>
            <div class="value">${escapeHtml(formatBytes(used))} / ${escapeHtml(formatBytes(limit))}</div>
            <div class="progress-container" style="background: rgba(255, 255, 255, 0.05); border-radius: 999px; height: 10px; width: 100%; overflow: hidden; margin: 8px 0; border: 1px solid var(--line);">
              <div style="height: 100%; width: ${percent}%; background-color: var(--accent-2);"></div>
            </div>
            <div class="small">Resets next: <strong>${escapeHtml(formatTimestamp(user.bandwidth_reset_at))}</strong></div>
          </article>
          <article class="stat">
            <div class="eyebrow">Status</div>
            <div class="value" style="color: ${user.is_suspended ? 'var(--danger)' : 'var(--live)'};">${user.is_suspended ? "Suspended" : "Active"}</div>
            <div class="small">user state</div>
          </article>
          <article class="stat">
            <div class="eyebrow">Current Streams</div>
            <div class="value" data-key-active-streams>${escapeHtml(activeStreams)}</div>
            <div class="small">active playback responses</div>
          </article>
        </section>
        <section class="main-grid" style="margin-top: 16px;">
          <div class="stack">
            <article class="panel">
              <h2 class="section-title">Limits & Quota</h2>
              <form method="post" action="/admin/users/${user.id}/quota">
                <label>Monthly Limit (GB)
                  <input type="number" min="1" step="1" name="bandwidthLimitGb" value="${escapeHtml(Math.round(limit / (1024 * 1024 * 1024)))}" required />
                </label>
                <label>Max Keys / Sub-Users
                  <input type="number" min="1" step="1" name="maxKeys" value="${escapeHtml(user.max_keys || 5)}" required />
                </label>
                <button type="submit">Save Limits</button>
              </form>
              <form method="post" action="/admin/users/${user.id}/reset-bandwidth" style="margin-top: 12px;" onsubmit="return confirm('Are you sure you want to reset bandwidth?');">
                <button type="submit" style="background: var(--line-strong); border: 1px solid var(--line); color: var(--text);">Reset Bandwidth Usage</button>
              </form>
            </article>
            <article class="panel">
              <h2 class="section-title">Change Password</h2>
              <form method="post" action="/admin/users/${user.id}/password">
                <label>New Password
                  <input type="password" name="password" placeholder="••••••••" required />
                </label>
                <button type="submit">Set New Password</button>
              </form>
            </article>
            <article class="panel">
              <h2 class="section-title">Account Access State</h2>
              <div class="small">Current state: <strong>${user.is_suspended ? "Suspended" : "Active"}</strong></div>
              <form method="post" action="/admin/users/${user.id}/toggle-status" style="margin-top: 12px;">
                <button class="${user.is_suspended ? "" : "danger"}" type="submit">${user.is_suspended ? "Unsuspend Account" : "Suspend Account"}</button>
              </form>
            </article>
            <article class="panel">
              <h2 class="section-title">Danger Zone</h2>
              <details class="revoke-details" style="margin-top: 12px;">
                <summary><span class="revoke-toggle">Delete User</span></summary>
                <form class="revoke-form" method="post" action="/admin/users/${user.id}/delete">
                  <label class="small">
                    Type <code>${escapeHtml(user.username)}</code> to delete user and all their watch history and key.
                    <input name="confirmUsername" placeholder="${escapeHtml(user.username)}" required autocomplete="off" />
                  </label>
                  <button class="danger" type="submit">Delete User</button>
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
                  : '<div class="small">No plays logged for this user yet.</div>'
              }
              </div>
              ${
                watchHistoryHasMore
                  ? `<form method="get" action="/admin/users/${user.id}" style="margin-top: 12px;">
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
          const shell = document.querySelector("[data-user-details]");
          if (!shell) return;
          const userId = shell.getAttribute("data-user-details");
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
              const url = new URL(\`/admin/api/users/\${userId}\`, window.location.origin);
              const params = new URLSearchParams(window.location.search);
              if (params.has("historyLimit")) {
                url.searchParams.set("historyLimit", params.get("historyLimit"));
              }

              const res = await fetch(url);
              if (!res.ok) return;
              const data = await res.json();

              const activeStreams = document.querySelector("[data-key-active-streams]");
              if (activeStreams) activeStreams.textContent = data.activeStreams;

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

function renderUserDashboard({ baseUrl, user, key, keys = [], sessions = [], currentSessionToken = "", message, activeTab = "dashboard", timezone = "UTC" }) {
  const formatTimestamp = createTimestampFormatter(timezone);
  const used = user.bandwidth_used;
  const limit = user.bandwidth_limit;
  const percent = Math.min(100, Math.round((used / limit) * 100)) || 0;
  
  let progressBarColor = "var(--live)";
  if (percent > 85) {
    progressBarColor = "var(--danger)";
  } else if (percent > 60) {
    progressBarColor = "#f59e0b";
  }

  const formattedUsed = formatBytes(used);
  const formattedLimit = formatBytes(limit);
  const resetDateText = formatTimestamp(user.bandwidth_reset_at);

  const dashboardActive = activeTab === "dashboard" ? "active" : "";
  const securityActive = activeTab === "security" ? "active" : "";
  const sessionsActive = activeTab === "sessions" ? "active" : "";

  return layout({
    title: `Dashboard - ${escapeHtml(user.username)}`,
    extraHead: `
      <style>
        .tabs-header {
          display: flex;
          gap: 8px;
          margin-bottom: 24px;
          border-bottom: 1px solid var(--line);
          padding-bottom: 1px;
        }
        .tab-btn {
          padding: 12px 20px;
          background: transparent;
          border: none;
          color: var(--muted);
          font-weight: 600;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          border-radius: 0;
          box-shadow: none;
          width: auto;
          transition: all 0.2s ease;
        }
        .tab-btn:hover {
          color: var(--text);
          filter: none;
          transform: none;
          box-shadow: none;
        }
        .tab-btn.active {
          color: var(--accent-2);
          border-bottom-color: var(--accent-2);
        }
        .tab-content {
          display: none;
        }
        .tab-content.active {
          display: block;
        }
        .progress-container {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 999px;
          height: 12px;
          width: 100%;
          overflow: hidden;
          margin: 12px 0;
          border: 1px solid var(--line);
        }
        .progress-bar {
          height: 100%;
          border-radius: 999px;
          transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .clipboard-btn {
          padding: 6px 12px;
          font-size: 12px;
          width: auto;
          min-height: unset;
          margin-left: 8px;
          background: var(--line-strong);
          border: 1px solid var(--line);
        }
        .clipboard-btn:hover {
          background: var(--accent-gradient);
        }
      </style>
    `,
    body: `
      <div class="shell">
        <section class="hero">
          <div>
            <h1>Welcome, ${escapeHtml(user.username)}</h1>
            <p>Manage your private Stremio Addon account</p>
          </div>
          <div class="header-actions">
            <form method="post" action="/logout">
              <button class="danger" type="submit">Logout</button>
            </form>
          </div>
        </section>
        
        ${renderMessage(message)}

        <div class="tabs-header">
          <button class="tab-btn ${dashboardActive}" onclick="switchTab('dashboard')">Dashboard</button>
          <button class="tab-btn ${sessionsActive}" onclick="switchTab('sessions')">Sessions</button>
          <button class="tab-btn ${securityActive}" onclick="switchTab('security')">Security</button>
        </div>

        <!-- DASHBOARD TAB -->
        <div id="tab-dashboard" class="tab-content ${dashboardActive}">
          <section class="stats">
            <article class="stat" style="grid-column: span 2;">
              <div class="eyebrow">Monthly Bandwidth Usage</div>
              <div class="value" data-user-bandwidth-value>${escapeHtml(formattedUsed)} / ${escapeHtml(formattedLimit)}</div>
              <div class="progress-container">
                <div class="progress-bar" data-user-bandwidth-progress style="width: ${percent}%; background-color: ${progressBarColor};"></div>
              </div>
              <div class="small" style="display: flex; justify-content: space-between;">
                <span data-user-bandwidth-percent-text>${percent}% of monthly limit used</span>
                <span data-user-bandwidth-reset-text>Resets on: <strong>${escapeHtml(resetDateText)}</strong></span>
              </div>
            </article>
            
            <article class="stat">
              <div class="eyebrow">Account Status</div>
              <div class="value" style="color: ${user.is_suspended ? 'var(--danger)' : 'var(--live)'};">
                ${user.is_suspended ? "Suspended" : "Active"}
              </div>
              <div class="small">monthly limit active</div>
            </article>

            <article class="stat">
              <div class="eyebrow">Keys</div>
              <div class="value">${keys.length} / ${user.max_keys || 5}</div>
              <div class="small">sub-keys in use</div>
            </article>
          </section>

          <!-- Create New Key -->
          ${keys.length < (user.max_keys || 5) ? `
          <section class="main-grid" style="grid-template-columns: 1fr; margin-top: 24px;">
            <article class="panel">
              <h2 class="section-title">Create New Key</h2>
              <p class="small" style="margin-bottom: 12px;">Generate a new addon key. Each key allows one concurrent stream and can be shared with someone.</p>
              <form method="post" action="/user/keys" style="display: flex; gap: 12px; align-items: flex-end;">
                <label style="flex: 1; margin: 0;">
                  <span class="eyebrow" style="margin-bottom: 4px; display: block;">Key Name</span>
                  <input type="text" name="name" placeholder="e.g. Living Room, Phone, Friend" required style="margin: 0;" />
                </label>
                <button type="submit" style="width: auto; white-space: nowrap; margin-bottom: 0;">Create Key</button>
              </form>
            </article>
          </section>
          ` : `
          <section class="main-grid" style="grid-template-columns: 1fr; margin-top: 24px;">
            <article class="panel" style="border-color: var(--line); opacity: 0.7;">
              <div class="small" style="text-align: center;">Key limit reached (${user.max_keys || 5}/${user.max_keys || 5}). Revoke an existing key to create a new one.</div>
            </article>
          </section>
          `}

          <!-- Key Cards -->
          <section style="margin-top: 24px; display: flex; flex-direction: column; gap: 16px;">
            ${keys.length === 0 ? `
              <article class="panel" style="text-align: center; padding: 40px;">
                <div class="value" style="font-size: 18px; margin-bottom: 8px;">No Keys Yet</div>
                <div class="small">Create your first key above to get started with Stremio.</div>
              </article>
            ` : keys.map((k, idx) => {
              const keyBw = formatBytes(k.bandwidth_used || 0);
              const isActive = k.activeStreamCount > 0;
              const isPaused = !!k.paused_at;
              const statusColor = isPaused ? 'var(--danger)' : (isActive ? 'var(--live)' : 'var(--muted)');
              const statusText = isPaused ? 'Frozen' : (isActive ? 'Streaming' : 'Idle');
              const manifestUrl = baseUrl + '/' + escapeHtml(k.token) + '/manifest.json';
              const history = k.watchHistory || [];
              
              return `
              <article class="panel key-card" data-key-id="${k.id}">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <div data-key-indicator="${k.id}" style="width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; flex-shrink: 0; ${isActive ? 'box-shadow: 0 0 8px ' + statusColor + ';' : ''}"></div>
                    <div>
                      <div style="font-weight: 700; font-size: 16px;">${escapeHtml(k.name)}</div>
                      <div class="small" data-key-status-text="${k.id}" style="color: ${statusColor};">${statusText}${isActive && k.activeStreamTitle ? ' — ' + escapeHtml(k.activeStreamTitle) : ''}</div>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="text-align: right;">
                      <div class="small" style="opacity: 0.5;">Bandwidth</div>
                      <div data-key-bandwidth="${k.id}" style="font-weight: 600; font-size: 14px;">${keyBw}</div>
                    </div>
                    <button type="button" class="manage-toggle" onclick="toggleManage(${k.id})" style="width: auto; min-height: unset; padding: 8px 16px; font-size: 12px; font-weight: 600; background: var(--line-strong); border: 1px solid var(--line);">Manage ▾</button>
                  </div>
                </div>

                <!-- Manage Panel (hidden by default) -->
                <div id="manage-${k.id}" class="manage-panel" style="display: none; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--line);">

                  <!-- Manifest URL -->
                  <div style="margin-bottom: 20px;">
                    <div class="eyebrow">Stremio Manifest URL</div>
                    <div style="display: flex; align-items: center; background: rgba(10,10,12,0.6); padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); word-break: break-all; margin-top: 6px;">
                      <a href="${manifestUrl}" target="_blank" class="manifest-link" style="flex-grow: 1; font-size: 13px;">${manifestUrl}</a>
                      <button type="button" class="clipboard-btn" onclick="copyUrl(this, '${manifestUrl}')">Copy</button>
                    </div>
                  </div>

                  <!-- Actions Row -->
                  <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
                    <!-- Rename -->
                    <form method="post" action="/user/keys/${k.id}/rename" style="display: flex; gap: 8px; align-items: center; margin: 0;">
                      <input name="name" value="${escapeHtml(k.name)}" placeholder="Key name" style="width: 160px; padding: 6px 10px; font-size: 12px; min-height: unset; margin: 0;" />
                      <button type="submit" style="width: auto; min-height: unset; padding: 6px 12px; font-size: 11px; font-weight: 600;">Rename</button>
                    </form>
                    
                    <!-- Pause / Resume -->
                    <form method="post" action="/user/keys/${k.id}/toggle-pause" style="margin: 0;">
                      <button type="submit" style="width: auto; min-height: unset; padding: 6px 12px; font-size: 11px; font-weight: 600; background: ${isPaused ? 'var(--live)' : '#f59e0b'}; color: #000; border: none;">
                        ${isPaused ? '▶ Resume' : '⏸ Freeze'}
                      </button>
                    </form>

                    <!-- Revoke -->
                    <form method="post" action="/user/keys/${k.id}/revoke" style="margin: 0;" onsubmit="return confirm('Permanently revoke this key? This cannot be undone and will immediately stop any active stream.');">
                      <button type="submit" class="danger" style="width: auto; min-height: unset; padding: 6px 12px; font-size: 11px; font-weight: 600;">✕ Revoke</button>
                    </form>
                  </div>

                  <!-- Token Reveal -->
                  <div style="margin-bottom: 20px;">
                    <div class="eyebrow">Raw Token</div>
                    <div class="reveal-block" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                      <code class="reveal-secret" style="font-size: 13px; padding: 4px 8px;" hidden>${escapeHtml(k.token)}</code>
                      <button type="button" class="reveal-toggle" style="width: auto; min-height: unset; padding: 4px 10px; font-size: 11px;">Reveal</button>
                    </div>
                  </div>

                  <!-- Watch History -->
                  <div data-key-history-container="${k.id}">
                    <div class="eyebrow" style="margin-bottom: 8px;">Recent Watch History</div>
                    ${history.length === 0 ? `
                      <div class="small" style="opacity: 0.4; padding: 12px 0;">No watch history yet for this key.</div>
                    ` : `
                      <div style="overflow-x: auto;">
                        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px;">
                          <thead>
                            <tr style="border-bottom: 1px solid var(--line);">
                              <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Title</th>
                              <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Type</th>
                              <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Watched</th>
                            </tr>
                          </thead>
                          <tbody data-key-history-body="${k.id}">
                            ${history.map(h => {
                              const episodeLabel = Number.isInteger(h.season) && Number.isInteger(h.episode)
                                ? ' S' + String(h.season).padStart(2, '0') + 'E' + String(h.episode).padStart(2, '0')
                                : '';
                              return `
                                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                                  <td style="padding: 6px;">${escapeHtml(h.media_title || 'Unknown')}${episodeLabel}</td>
                                  <td style="padding: 6px; text-transform: capitalize;">${escapeHtml(h.media_type || '-')}</td>
                                  <td style="padding: 6px; white-space: nowrap;">${escapeHtml(formatTimestamp(h.watched_at))}</td>
                                </tr>
                              `;
                            }).join('')}
                          </tbody>
                        </table>
                      </div>
                    `}
                  </div>
                </div>
              </article>
              `;
            }).join('')}
          </section>
        </div>

        <!-- SECURITY TAB -->
        <div id="tab-security" class="tab-content ${securityActive}">
          <section class="main-grid" style="grid-template-columns: 1fr;">
            <article class="panel" style="max-width: 600px; margin: 0 auto; width: 100%;">
              <h2 class="section-title">Change Password</h2>
              <form method="post" action="/user/reset-password">
                <label>Current Password
                  <input type="password" name="currentPassword" placeholder="Enter current password" required />
                </label>
                <label>New Password
                  <input type="password" name="newPassword" placeholder="Enter new password" required />
                </label>
                <label>Repeat New Password
                  <input type="password" name="repeatNewPassword" placeholder="Repeat new password" required />
                </label>
                <button type="submit" style="margin-top: 8px;">Update Password</button>
              </form>
            </article>
          </section>
        </div>

        <!-- SESSIONS TAB -->
        <div id="tab-sessions" class="tab-content ${sessionsActive}">
          <section class="main-grid" style="grid-template-columns: 1fr;">
            <article class="panel">
              <h2 class="section-title">Active Sessions (${sessions.length})</h2>
              <div class="small" style="margin-bottom: 16px; opacity: 0.6;">These are your currently active login sessions. Revoking a session will force that device to log in again.</div>
              <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                  <thead>
                    <tr style="border-bottom: 1px solid var(--line);">
                      <th style="padding: 12px 8px; color: var(--muted); font-size: 12px; text-transform: uppercase;">Session Name</th>
                      <th style="padding: 12px 8px; color: var(--muted); font-size: 12px; text-transform: uppercase;">Device</th>
                      <th style="padding: 12px 8px; color: var(--muted); font-size: 12px; text-transform: uppercase;">IP Address</th>
                      <th style="padding: 12px 8px; color: var(--muted); font-size: 12px; text-transform: uppercase;">Last Active</th>
                      <th style="padding: 12px 8px; color: var(--muted); font-size: 12px; text-transform: uppercase; text-align: right;">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${sessions.length === 0 ? `
                      <tr>
                        <td colspan="5" style="padding: 24px 8px; text-align: center; color: var(--muted);">
                          No active sessions found.
                        </td>
                      </tr>
                    ` : sessions.map(s => {
                      const isCurrent = s.token === currentSessionToken;
                      const uaInfo = formatUserAgent(s.user_agent);
                      return `
                        <tr style="border-bottom: 1px solid var(--line); vertical-align: middle;">
                          <td style="padding: 12px 8px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                              ${isCurrent ? '<span class="live-indicator" style="margin: 0;" title="Current session"></span>' : ''}
                              <form method="post" action="/user/sessions/${s.id}/rename" style="margin: 0; display: flex; gap: 6px; align-items: center;">
                                <input name="name" value="${escapeHtml(s.name)}" style="width: 140px; padding: 4px 8px; font-size: 12px; min-height: unset; background: rgba(255,255,255,0.03); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text);" />
                                <button type="submit" style="width: auto; min-height: unset; padding: 4px 8px; font-size: 10px; font-weight: 600;">Save</button>
                              </form>
                            </div>
                            ${isCurrent ? '<div class="small" style="margin-top: 4px; color: var(--live); font-size: 10px;">This device</div>' : ''}
                          </td>
                          <td style="padding: 12px 8px;">
                            <div class="small">${escapeHtml(uaInfo)}</div>
                          </td>
                          <td style="padding: 12px 8px;">
                            <code style="font-size: 12px;">${escapeHtml(s.ip_address || 'n/a')}</code>
                          </td>
                          <td style="padding: 12px 8px;">
                            <div class="small">${escapeHtml(formatTimestamp(s.last_active_at))}</div>
                          </td>
                          <td style="padding: 12px 8px; text-align: right;">
                            ${!isCurrent ? `
                              <form method="post" action="/user/sessions/${s.id}/revoke" style="margin: 0;" onsubmit="return confirm('Revoke this session? The device will be logged out immediately.');">
                                <button type="submit" class="danger" style="width: auto; min-height: unset; padding: 4px 8px; font-size: 11px; font-weight: 600;">Revoke</button>
                              </form>
                            ` : `
                              <span class="small" style="color: var(--muted);">Current</span>
                            `}
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </div>
      </div>

      <script>
        function switchTab(tabId) {
          // Update tabs header
          document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.innerText.toLowerCase() === tabId) {
              btn.classList.add('active');
            }
          });
          // Update URL query parameter without reloading
          const url = new URL(window.location);
          url.searchParams.set('tab', tabId);
          window.history.replaceState({}, '', url);

          // Update tab content
          document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
          });
          document.getElementById('tab-' + tabId).classList.add('active');
        }

        function copyUrl(btn, url) {
          navigator.clipboard.writeText(url).then(() => {
            const oldText = btn.innerText;
            btn.innerText = 'Copied!';
            btn.style.borderColor = 'var(--live)';
            setTimeout(() => {
              btn.innerText = oldText;
              btn.style.borderColor = 'var(--line)';
            }, 2000);
          });
        }

        function toggleManage(keyId) {
          const panel = document.getElementById('manage-' + keyId);
          if (!panel) return;
          const isVisible = panel.style.display !== 'none';
          panel.style.display = isVisible ? 'none' : 'block';
          // Update button text
          const card = panel.closest('.key-card');
          if (card) {
            const btn = card.querySelector('.manage-toggle');
            if (btn) btn.textContent = isVisible ? 'Manage ▾' : 'Manage ▴';
          }
        }

        // Initialize active tab from URL query param if present
        (() => {
          const params = new URLSearchParams(window.location.search);
          const tab = params.get('tab');
          if (tab && (tab === 'dashboard' || tab === 'security' || tab === 'sessions')) {
            switchTab(tab);
          }
        })();

        // Auto-update dashboard key status and history
        (() => {
          const timezone = "${escapeHtml(timezone || "UTC")}";

          function escapeHtml(value) {
            return String(value || "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function formatBytes(bytes) {
            if (bytes === 0) return "0 B";
            const k = 1024;
            const sizes = ["B", "KB", "MB", "GB", "TB"];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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

          async function updateDashboardData() {
            try {
              const res = await fetch("/user/api/dashboard");
              if (!res.ok) return;
              const data = await res.json();

              // Update overall bandwidth stats
              const bwValue = document.querySelector("[data-user-bandwidth-value]");
              if (bwValue) {
                bwValue.textContent = \`\${formatBytes(data.bandwidth_used)} / \${formatBytes(data.bandwidth_limit)}\`;
              }
              const bwProgress = document.querySelector("[data-user-bandwidth-progress]");
              if (bwProgress) {
                const percent = Math.min(100, Math.round((data.bandwidth_used / data.bandwidth_limit) * 100)) || 0;
                bwProgress.style.width = \`\${percent}%\`;
                let progressBarColor = "var(--live)";
                if (percent > 85) {
                  progressBarColor = "var(--danger)";
                } else if (percent > 60) {
                  progressBarColor = "#f59e0b";
                }
                bwProgress.style.backgroundColor = progressBarColor;
                
                const percentText = document.querySelector("[data-user-bandwidth-percent-text]");
                if (percentText) {
                  percentText.textContent = \`\${percent}% of monthly limit used\`;
                }
              }

              const resetText = document.querySelector("[data-user-bandwidth-reset-text]");
              if (resetText && data.bandwidth_reset_at) {
                resetText.innerHTML = \`Resets on: <strong>\${formatTimestamp(data.bandwidth_reset_at)}</strong>\`;
              }

              // Update keys
              if (data.keys) {
                data.keys.forEach(k => {
                  const isActive = k.activeStreamCount > 0;
                  const isPaused = !!k.paused_at;
                  const statusColor = isPaused ? 'var(--danger)' : (isActive ? 'var(--live)' : 'var(--muted)');
                  const statusText = isPaused ? 'Frozen' : (isActive ? 'Streaming' : 'Idle');

                  // 1. Indicator dot
                  const dot = document.querySelector(\`[data-key-indicator="\${k.id}"]\`);
                  if (dot) {
                    dot.style.background = statusColor;
                    if (isActive) {
                      dot.style.boxShadow = \`0 0 8px \${statusColor}\`;
                    } else {
                      dot.style.boxShadow = "none";
                    }
                  }

                  // 2. Status text
                  const statusTextEl = document.querySelector(\`[data-key-status-text="\${k.id}"]\`);
                  if (statusTextEl) {
                    statusTextEl.style.color = statusColor;
                    statusTextEl.textContent = \`\${statusText}\${isActive && k.activeStreamTitle ? ' — ' + k.activeStreamTitle : ''}\`;
                  }

                  // 3. Bandwidth used for key
                  const bwKey = document.querySelector(\`[data-key-bandwidth="\${k.id}"]\`);
                  if (bwKey) {
                    bwKey.textContent = formatBytes(k.bandwidth_used || 0);
                  }

                  // 4. Watch history table
                  const historyContainer = document.querySelector(\`[data-key-history-container="\${k.id}"]\`);
                  if (historyContainer) {
                    if (!k.watchHistory || k.watchHistory.length === 0) {
                      historyContainer.innerHTML = \`
                        <div class="eyebrow" style="margin-bottom: 8px;">Recent Watch History</div>
                        <div class="small" style="opacity: 0.4; padding: 12px 0;">No watch history yet for this key.</div>
                      \`;
                    } else {
                      const tableRows = k.watchHistory.map(h => {
                        const episodeLabel = Number.isInteger(h.season) && Number.isInteger(h.episode)
                          ? ' S' + String(h.season).padStart(2, '0') + 'E' + String(h.episode).padStart(2, '0')
                          : '';
                        return \`
                          <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                            <td style="padding: 6px;">\${escapeHtml(h.media_title || 'Unknown')}\${episodeLabel}</td>
                            <td style="padding: 6px; text-transform: capitalize;">\${escapeHtml(h.media_type || '-')}</td>
                            <td style="padding: 6px; white-space: nowrap;">\${escapeHtml(formatTimestamp(h.watched_at))}</td>
                          </tr>
                        \`;
                      }).join('');

                      historyContainer.innerHTML = \`
                        <div class="eyebrow" style="margin-bottom: 8px;">Recent Watch History</div>
                        <div style="overflow-x: auto;">
                          <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px;">
                            <thead>
                              <tr style="border-bottom: 1px solid var(--line);">
                                <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Title</th>
                                <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Type</th>
                                <th style="padding: 8px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase;">Watched</th>
                              </tr>
                            </thead>
                            <tbody data-key-history-body="\${k.id}">
                              \${tableRows}
                            </tbody>
                          </table>
                        </div>
                      \`;
                    }
                  }
                });
              }
            } catch (err) {
              console.error("Failed to update dashboard data:", err);
            }
          }

          // Initial run and schedule
          updateDashboardData();
          setInterval(updateDashboardData, 2000);
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
  renderKeyDetails: renderUserDetails,
  renderSessions,
  renderUserLogin,
  renderUserDashboard,
  renderUserDetails,
  formatBytes,
};
