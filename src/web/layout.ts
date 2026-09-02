// Shared HTML shell + small building blocks used by both the public landing
// page (landing.ts) and the authenticated dashboard (dashboard.ts). Plain
// server-rendered strings on purpose - no template engine, no build step,
// matching the rest of this project.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function shell(title: string, body: string, description?: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · TrustSocial</title>
<meta name="description" content="${escapeHtml(
    description ?? "TrustSocial - a tiny, self-hosted post scheduler for one brand's TikTok, Instagram, and YouTube accounts."
  )}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/styles.css">
</head><body>${body}</body></html>`;
}

export const BRAND_MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="4" width="18" height="17" rx="4" stroke="currentColor" stroke-width="1.7"/>
  <path d="M3 9h18" stroke="currentColor" stroke-width="1.7"/>
  <path d="M8 2.5v3M16 2.5v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M8.5 13.5l2.3 2.3L15.8 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function brand(href = "/"): string {
  return `<a href="${href}" class="brand"><span class="brand-mark">${BRAND_MARK_SVG}</span>TrustSocial</a>`;
}

const PLATFORM_ICONS: Record<string, string> = {
  youtube: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="5" width="20" height="14" rx="4" stroke="currentColor" stroke-width="1.6"/>
    <path d="M10 9l6 3-6 3V9z" fill="currentColor"/>
  </svg>`,
  instagram: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/>
  </svg>`,
  tiktok: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 3v10.5a3.5 3.5 0 1 1-3-3.46" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 3c.4 2.4 2.1 4.1 4.3 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
};

export function platformIcon(platform: string): string {
  return PLATFORM_ICONS[platform] ?? "";
}

export function platformLabel(platform: string): string {
  return platform === "youtube" ? "YouTube" : platform === "instagram" ? "Instagram" : platform === "tiktok" ? "TikTok" : platform;
}

export function platformTag(platform: string): string {
  return `<span class="tag platform">${platformIcon(platform)}${platformLabel(platform)}</span>`;
}
