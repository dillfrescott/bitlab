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
  <meta name="description" content="Bitlab — Stremio addon powered by bitmagnet." />
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
  <title>Bitlab</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e0e10;
      --panel: #18181b;
      --line: #27272a;
      --text: #f4f4f5;
      --accent: #3b82f6;
      --success: #22c55e;
      --radius: 8px;
      --radius-sm: 6px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .page {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
      gap: 1.5rem;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      animation: fadeIn 0.3s ease both;
    }
    .logo-icon {
      width: 40px;
      height: 40px;
      border-radius: var(--radius);
      background: var(--panel);
      border: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .logo-text {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .url-group {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
      width: 100%;
      max-width: 480px;
      animation: fadeIn 0.3s ease 0.06s both;
    }
    .url-input {
      flex: 1;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 0.7rem 0.9rem;
      font-family: 'Outfit', monospace;
      font-size: 0.82rem;
      color: var(--accent);
      outline: none;
      cursor: text;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: border-color 0.15s;
      user-select: all;
    }
    .url-input:focus { border-color: var(--accent); }

    .copy-btn {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      padding: 0.7rem 1.1rem;
      font-family: 'Outfit', sans-serif;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s, background 0.15s;
      white-space: nowrap;
    }
    .copy-btn:hover { opacity: 0.85; }
    .copy-btn.copied { background: var(--success); }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
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
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      <span id="copy-label">Copy</span>
    </button>
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
      setTimeout(() => { btn.classList.remove('copied'); label.textContent = 'Copy'; }, 2200);
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      btn.classList.add('copied');
      label.textContent = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); label.textContent = 'Copy'; }, 2200);
    });
  }
</script>
</body>
</html>`;
}

module.exports = {
  renderLandingPage,
};
