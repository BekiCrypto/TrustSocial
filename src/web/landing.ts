import { brand, platformIcon, platformLabel, shell } from "./layout.js";

const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/>
  <path d="M8 12.3l2.6 2.6L16.2 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_REVIEW = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M9 11l2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" stroke-width="1.7"/>
</svg>`;
const ICON_QUEUE = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="10.5" width="16" height="10" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
  <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" stroke="currentColor" stroke-width="1.7"/>
</svg>`;
const ICON_TINY = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/>
  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

function header(ctaHref: string, ctaLabel: string): string {
  return `<header class="site-header"><div class="wrap header-inner">
    ${brand()}
    <nav class="site-nav">
      <div class="nav-links">
        <a href="#features">Features</a>
        <a href="#how-it-works">How it works</a>
        <a href="https://github.com/BekiCrypto/TrustSocial" target="_blank" rel="noopener">GitHub</a>
      </div>
      <a class="btn btn-primary btn-sm" href="${ctaHref}">${ctaLabel}</a>
    </nav>
  </div></header>`;
}

function footer(): string {
  return `<footer class="site-footer"><div class="wrap footer-inner">
    <span>© ${new Date().getFullYear()} TrustSocial · MIT License</span>
    <nav>
      <a href="https://github.com/BekiCrypto/TrustSocial" target="_blank" rel="noopener">GitHub</a>
      <a href="https://github.com/BekiCrypto/TrustSocial#readme" target="_blank" rel="noopener">Docs</a>
      <a href="https://trustlotto.app" target="_blank" rel="noopener">trustlotto.app</a>
    </nav>
  </div></footer>`;
}

export function renderLanding(loggedIn: boolean): string {
  const ctaHref = loggedIn ? "/app" : "/login";
  const ctaLabel = loggedIn ? "Open dashboard" : "Log in";

  const body = `
  ${header(ctaHref, ctaLabel)}
  <main>
    <section class="hero"><div class="wrap">
      <span class="eyebrow">Open source · self-hosted</span>
      <h1>The scheduler for one brand's social accounts.</h1>
      <p class="lead">Draft once, review every post, publish on schedule — TikTok, Instagram Reels, and
        YouTube Shorts, from one small process you run yourself. No search engine, no workflow
        orchestrator, nothing to babysit.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="${ctaHref}">${ctaLabel}</a>
        <a class="btn btn-ghost btn-lg" href="https://github.com/BekiCrypto/TrustSocial" target="_blank" rel="noopener">View source →</a>
      </div>
    </div></section>

    <section class="section" id="features"><div class="wrap">
      <h2>Built to stay small</h2>
      <p class="section-sub">The established self-host options are built for agencies running many
        clients at once. This is the missing middle: one brand, a few accounts, nothing extra.</p>
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">${ICON_REVIEW}</div>
          <h3>Review before it ships</h3>
          <p>Every drafted post waits for a human to approve, edit, or reject it. Nothing reaches a
            real account unattended.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">${ICON_QUEUE}</div>
          <h3>Three platforms, one queue</h3>
          <p>${["youtube", "instagram", "tiktok"].map((p) => `<span class="tag platform" style="margin-right:.3rem">${platformIcon(p)}${platformLabel(p)}</span>`).join("")}<br>
            from a single place - the scheduler checks every minute and publishes what's due.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">${ICON_LOCK}</div>
          <h3>Your server, your data</h3>
          <p>Platform tokens are encrypted at rest. There's no third-party service in the middle of
            your accounts - just this process and the platforms' own APIs.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">${ICON_TINY}</div>
          <h3>Genuinely tiny</h3>
          <p>One Node process, one SQLite file. No Elasticsearch, no Temporal, no Docker Compose
            stack to maintain beyond this single container.</p>
        </div>
      </div>
    </div></section>

    <section class="section section-alt" id="how-it-works"><div class="wrap">
      <h2>How it works</h2>
      <p class="section-sub">Three steps, the same for every post regardless of source.</p>
      <ol class="step-list">
        <li><span class="step-num">1</span><div>
          <h3>Draft or import</h3>
          <p>Write a post by hand, or point an importer at wherever your drafts already live -
            a folder of Markdown files, a spreadsheet, anything.</p>
        </div></li>
        <li><span class="step-num">2</span><div>
          <h3>Review &amp; approve</h3>
          <p>Every import lands as "pending review" - watch the attached clip right in the queue,
            edit the caption or schedule time, then approve it or reject it.</p>
        </div></li>
        <li><span class="step-num">3</span><div>
          <h3>Publish on schedule</h3>
          <p>A once-a-minute loop checks for approved posts whose time has come and publishes them
            through each platform's own API. Failures are visible, with one-click retry.</p>
        </div></li>
      </ol>
    </div></section>

    <section class="section"><div class="wrap" style="text-align:center">
      <h2>Your server, your data</h2>
      <ul class="trust-list">
        <li>${CHECK_SVG}Platform tokens encrypted at rest (AES-256-GCM) - losing the key just means reconnecting accounts, by design</li>
        <li>${CHECK_SVG}One shared dashboard password - no user accounts to manage for a single-operator tool</li>
        <li>${CHECK_SVG}<span>TikTok publishes privately until TikTok has reviewed the app</span></li>
        <li>${CHECK_SVG}MIT licensed - read every line yourself, nothing hidden behind a paid tier</li>
      </ul>
    </div></section>

    <section class="section"><div class="wrap">
      <div class="cta-band">
        <h2>Run your own copy</h2>
        <p>Clone it, fill in a <code>.env</code>, and you're scheduling posts in minutes - or open the
          dashboard if you already have one running.</p>
        <a class="btn btn-primary btn-lg" href="${ctaHref}">${ctaLabel}</a>
      </div>
    </div></section>
  </main>
  ${footer()}`;

  return shell("The self-hosted social scheduler", body);
}
