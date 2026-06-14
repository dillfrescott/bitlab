function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLandingPage({ addonUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Bitlab — a Stremio addon that searches your local bitmagnet index and streams via magnet links." />
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>Bitlab — Stremio Addon</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: rgba(20, 20, 28, 0.72);
      --line: rgba(255,255,255,0.07);
      --line-strong: rgba(255,255,255,0.14);
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-2: #60a5fa;
      --accent-glow: rgba(59,130,246,0.18);
      --accent-gradient: linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%);
      --success: #10b981;
      --success-glow: rgba(16,185,129,0.2);
      --radius: 16px;
      --radius-sm: 10px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* Animated background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 70% -10%, rgba(59,130,246,0.12) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at -10% 80%, rgba(99,102,241,0.08) 0%, transparent 60%),
        radial-gradient(ellipse 40% 40% at 50% 50%, rgba(16,185,129,0.04) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .page {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
    }

    /* Logo / hero */
    .logo {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 2rem;
    }
    .logo-icon {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, #1d2235 0%, #0f1629 100%);
      border: 1px solid rgba(59,130,246,0.3);
      box-shadow: 0 0 24px rgba(59,130,246,0.18), 0 4px 16px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .logo-text {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      background: linear-gradient(90deg, #e0e7ff 0%, #93c5fd 50%, #60a5fa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* Main card */
    .card {
      width: 100%;
      max-width: 560px;
      background: var(--panel);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      padding: 2.5rem 2rem;
      box-shadow: 0 24px 80px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.06) inset;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 0.4rem;
    }
    .card-desc {
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 1.5rem;
      line-height: 1.6;
    }

    /* URL copy section */
    .url-group {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
      margin-bottom: 1.25rem;
    }
    .url-input {
      flex: 1;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm);
      padding: 0.75rem 1rem;
      font-family: 'Outfit', monospace;
      font-size: 0.82rem;
      color: var(--accent-2);
      outline: none;
      cursor: text;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: border-color 0.2s;
      user-select: all;
    }
    .url-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .copy-btn {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--accent-gradient);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      padding: 0.75rem 1.2rem;
      font-family: 'Outfit', sans-serif;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.18s, transform 0.12s, box-shadow 0.2s;
      box-shadow: 0 2px 12px rgba(59,130,246,0.3);
      white-space: nowrap;
    }
    .copy-btn:hover { opacity: 0.88; transform: translateY(-1px); box-shadow: 0 4px 18px rgba(59,130,246,0.4); }
    .copy-btn:active { transform: translateY(0); }
    .copy-btn.copied {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      box-shadow: 0 2px 12px var(--success-glow);
    }

    /* Install button */
    .install-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 0.9rem 1rem;
      border-radius: var(--radius-sm);
      background: rgba(59,130,246,0.08);
      border: 1px solid rgba(59,130,246,0.25);
      color: var(--accent-2);
      font-family: 'Outfit', sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.18s, border-color 0.18s, transform 0.12s;
    }
    .install-btn:hover {
      background: rgba(59,130,246,0.15);
      border-color: rgba(59,130,246,0.4);
      transform: translateY(-1px);
    }
    .install-btn:active { transform: translateY(0); }

    /* Divider */
    .divider {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 1.25rem 0;
      color: var(--muted);
      font-size: 0.8rem;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--line);
    }

    /* Info pills */
    .info-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--line);
      border-radius: 100px;
      padding: 0.3rem 0.75rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
    .pill svg { opacity: 0.7; }

    /* Footer */
    .footer {
      margin-top: 2.5rem;
      font-size: 0.78rem;
      color: rgba(161,161,170,0.55);
      text-align: center;
    }
    .footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }

    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .logo { animation: fadeSlideUp 0.5s ease both; }
    .card { animation: fadeSlideUp 0.5s ease 0.08s both; }
    .footer { animation: fadeSlideUp 0.5s ease 0.16s both; }
  </style>
</head>
<body>
<div class="page">
  <div class="logo">
    <div class="logo-icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
        <path d="M10 8V16C10 19.3137 12.6863 22 16 22C19.3137 22 22 19.3137 22 16V8H18V16C18 17.1046 17.1046 18 16 18C14.8954 18 14 17.1046 14 16V8H10Z" fill="#7ea2ff"/>
        <rect x="10" y="8" width="4" height="3" fill="#f2f2f2"/>
        <rect x="18" y="8" width="4" height="3" fill="#f2f2f2"/>
      </svg>
    </div>
    <span class="logo-text">Bitlab</span>
  </div>

  <div class="card">
    <div class="card-title">Install Stremio Addon</div>
    <div class="card-desc">
      Copy the URL below and paste it into Stremio's addon installer, or click "Open in Stremio" to install directly.
      Bitlab searches your local bitmagnet index — Stremio handles all torrenting.
    </div>

    <div class="url-group">
      <input
        id="addon-url"
        class="url-input"
        type="text"
        readonly
        value="${escapeHtml(addonUrl)}"
        aria-label="Addon manifest URL"
        onclick="this.select()"
      />
      <button id="copy-btn" class="copy-btn" onclick="copyUrl()" aria-label="Copy addon URL">
        <svg id="copy-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span id="copy-label">Copy</span>
      </button>
    </div>

    <div class="divider">or</div>

    <a id="install-btn" class="install-btn" href="${escapeHtml("stremio://" + addonUrl.replace(/^https?:\/\//, ""))}" aria-label="Open addon in Stremio">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Open in Stremio
    </a>

    <div class="info-row">
      <span class="pill">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Magnet streams
      </span>
      <span class="pill">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10H3"/><path d="M21 6H3"/><path d="M21 14H3"/><path d="M21 18H3"/></svg>
        Movies &amp; Series
      </span>
      <span class="pill">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        No auth required
      </span>
      <span class="pill">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>
        bitmagnet index
      </span>
    </div>
  </div>

  <div class="footer">
    Bitlab &mdash; powered by <a href="https://github.com/bitmagnet-io/bitmagnet" target="_blank" rel="noopener">bitmagnet</a>
  </div>
</div>

<script>
  function copyUrl() {
    const input = document.getElementById('addon-url');
    const btn = document.getElementById('copy-btn');
    const label = document.getElementById('copy-label');

    navigator.clipboard.writeText(input.value).then(() => {
      btn.classList.add('copied');
      label.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = 'Copy';
      }, 2200);
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      btn.classList.add('copied');
      label.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = 'Copy';
      }, 2200);
    });
  }
</script>
</body>
</html>`;
}

module.exports = {
  renderLandingPage,
};
