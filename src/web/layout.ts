// Shared HTML shell + small building blocks used by both the public landing
// page (landing.ts) and the authenticated dashboard (dashboard.ts). Plain
// server-rendered strings on purpose - no template engine, no build step,
// matching the rest of this project.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const DEFAULT_DESCRIPTION =
  "TrustSocial - a tiny, self-hosted post scheduler for one brand's TikTok, Instagram, and YouTube accounts.";

export function shell(title: string, body: string, opts?: { description?: string; noindex?: boolean }): string {
  const description = opts?.description ?? DEFAULT_DESCRIPTION;
  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const fullTitle = `${escapeHtml(title)} · TrustSocial`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${escapeHtml(description)}">
${opts?.noindex ? `<meta name="robots" content="noindex, nofollow">` : ""}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/styles.css">
<meta property="og:type" content="website">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${escapeHtml(description)}">
${publicUrl ? `<meta property="og:url" content="${escapeHtml(publicUrl)}">\n<meta property="og:image" content="${escapeHtml(publicUrl)}/og-image.png">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${escapeHtml(description)}">
${publicUrl ? `<meta name="twitter:image" content="${escapeHtml(publicUrl)}/og-image.png">` : ""}
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

export const ICON_CHECK_SM = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_FLAME = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5c1 3-3 4.3-3 8a3 3 0 0 0 6 0c1.3 1 2 2.6 2 4.2a5 5 0 0 1-10 0c0-4.4 3.3-6 5-12.2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
export const ICON_STAR = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3.5l2.4 5.3 5.6.6-4.2 3.9 1.2 5.7L12 16l-5 3 1.2-5.7-4.2-3.9 5.6-.6L12 3.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
export const ICON_TROPHY = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 4h10v4a5 5 0 0 1-10 0V4z" stroke="currentColor" stroke-width="1.6"/><path d="M7 5H4v1a4 4 0 0 0 4 4M17 5h3v1a4 4 0 0 1-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 13v3m-3 3h6m-3 0v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
