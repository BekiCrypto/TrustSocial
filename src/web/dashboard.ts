import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { getPublishStats, listAccounts, listPosts, setPostStatus, updatePost, upsertAccount, type PublishStats } from "../db.js";
import { encryptJson } from "../crypto.js";
import { adapters, adapterFor } from "../platforms/index.js";
import { importTrustLottoQueue } from "../importers/trustlotto.js";
import type { Platform } from "../types.js";
import {
  brand,
  escapeHtml,
  ICON_CHECK_SM,
  ICON_FLAME,
  ICON_STAR,
  ICON_TROPHY,
  platformIcon,
  platformLabel,
  platformTag,
  shell,
} from "./layout.js";
import { renderLanding } from "./landing.js";
import { clearCsrfToken, csrfField, getOrCreateCsrfToken, rateLimiter, verifyCsrfToken } from "../security.js";

const validSessions = new Set<string>(); // in-memory on purpose - a restart just means logging in again
const oauthStates = new Map<string, number>(); // state -> created-at ms, to prevent CSRF on the OAuth callback

const loginLimiter = rateLimiter({
  windowMs: 15 * 60_000,
  max: 8,
  message: "Too many login attempts. Wait a few minutes and try again.",
});

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sessionToken(req: Request): string | undefined {
  return readCookie(req, "trustsocial_session");
}

function isLoggedIn(req: Request): boolean {
  const token = sessionToken(req);
  return !!token && validSessions.has(token);
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isLoggedIn(req)) return next();
  res.redirect("/login");
}

// ---------------------------------------------------------------- icons (small, inline, no dependency)
const ICON_LOGOUT = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8M10 12h11m0 0-3.5-3.5M21 12l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_IMPORT = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_INBOX = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 12h4.5l1.5 3h6l1.5-3H21M4 12l1.4-6.3A2 2 0 0 1 7.35 4h9.3a2 2 0 0 1 1.95 1.7L20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------- app shell (header/nav shared by every authenticated page)
function appHeader(active: "queue" | "accounts", logoutCsrf: string): string {
  return `<header class="site-header"><div class="wrap header-inner">
    ${brand("/app")}
    <nav class="site-nav">
      <div class="nav-links">
        <a href="/app" class="${active === "queue" ? "nav-active" : ""}">Queue</a>
        <a href="/app/accounts" class="${active === "accounts" ? "nav-active" : ""}">Accounts</a>
      </div>
      <form method="post" action="/app/logout">
        ${csrfField(logoutCsrf)}
        <button class="btn btn-ghost btn-sm" type="submit">${ICON_LOGOUT}Log out</button>
      </form>
    </nav>
  </div></header>`;
}

function appPage(title: string, active: "queue" | "accounts", body: string, logoutCsrf: string): string {
  return shell(
    title,
    `${appHeader(active, logoutCsrf)}<div class="app-shell"><main class="app-main"><div class="wrap">${body}</div></main></div>`,
    { noindex: true }
  );
}

function errorPage(code: number, title: string, message: string, backHref = "/", backLabel = "← Back to home"): string {
  return shell(
    title,
    `<div class="error-wrap"><div>
      <div class="error-code">Error ${code}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a class="btn btn-secondary" href="${backHref}">${backLabel}</a>
    </div></div>`,
    { noindex: true }
  );
}

const STATUS_ORDER = ["pending_review", "scheduled", "publishing", "failed", "published", "rejected"] as const;
const STATUS_LABEL: Record<(typeof STATUS_ORDER)[number], string> = {
  pending_review: "Pending review",
  scheduled: "Scheduled",
  publishing: "Publishing",
  failed: "Failed",
  published: "Published",
  rejected: "Rejected",
};

function mediaSrc(path: string): string {
  return /^https?:\/\//.test(path) ? path : `/media/${encodeURIComponent(basename(path))}`;
}

function postCard(p: ReturnType<typeof listPosts>[number], csrf: string): string {
  const media = p.media[0];
  const actions: string[] = [];
  if (p.status === "pending_review" || p.status === "scheduled") {
    actions.push(`
      <form method="post" action="/app/posts/${p.id}/edit" class="edit-form">
        ${csrfField(csrf)}
        <textarea name="caption">${escapeHtml(p.caption)}</textarea>
        <div class="field-row">
          <div class="field">
            <label>Scheduled for (UTC)</label>
            <input type="text" name="scheduledFor" value="${escapeHtml(p.scheduledFor)}">
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Save edits</button>
        </div>
      </form>`);
  }
  if (p.status === "pending_review") {
    actions.push(`
      <form method="post" action="/app/posts/${p.id}/approve">${csrfField(csrf)}<button class="btn btn-primary btn-sm" type="submit">Approve &amp; schedule</button></form>
      <form method="post" action="/app/posts/${p.id}/reject">${csrfField(csrf)}<button class="btn btn-danger btn-sm" type="submit">Reject</button></form>`);
  }
  if (p.status === "failed") {
    actions.push(`<form method="post" action="/app/posts/${p.id}/retry">${csrfField(csrf)}<button class="btn btn-primary btn-sm" type="submit">Retry now</button></form>`);
  }

  const mediaBlock = media
    ? media.kind === "video"
      ? `<div class="post-media"><video controls preload="metadata" src="${mediaSrc(media.path)}"></video></div>`
      : `<div class="post-media"><img src="${mediaSrc(media.path)}" alt=""></div>`
    : `<p class="faint">(no media attached)</p>`;

  return `<div class="card">
    <div class="card-row">
      ${platformTag(p.platform)}
      <span class="tag ${p.status}">${STATUS_LABEL[p.status]}</span>
      <span class="post-meta">scheduled ${escapeHtml(p.scheduledFor)}${p.source ? ` · from ${escapeHtml(p.source)}` : ""}</span>
    </div>
    <p class="post-caption">${escapeHtml(p.caption)}</p>
    ${mediaBlock}
    ${p.status === "failed" && p.lastError ? `<p class="faint text-danger">Last error: ${escapeHtml(p.lastError)}</p>` : ""}
    ${p.status === "published" ? `<p class="faint">Published ${escapeHtml(p.publishedAt ?? "")}${p.platformPostId ? ` → <a href="${escapeHtml(p.platformPostId)}" target="_blank" rel="noopener">${escapeHtml(p.platformPostId)}</a>` : ""}</p>` : ""}
    ${actions.length ? `<div class="card-actions">${actions.join("\n")}</div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- gamification: setup checklist + stats/streak/heatmap
function setupChecklist(hasAccount: boolean, hasPost: boolean, hasApproved: boolean, hasPublished: boolean): string {
  const steps = [
    { label: "Connect a platform account", done: hasAccount, href: "/app/accounts" },
    { label: "Import or draft your first post", done: hasPost, href: "/app" },
    { label: "Approve a post", done: hasApproved, href: "/app" },
    { label: "Publish your first post", done: hasPublished, href: "/app" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return ""; // graduated - no need to keep nagging

  const pct = Math.round((doneCount / steps.length) * 100);
  let markedNext = false;
  const stepsHtml = steps
    .map((s) => {
      let cls = "checklist-step";
      if (s.done) cls += " done";
      else if (!markedNext) {
        cls += " next";
        markedNext = true;
      }
      return `<div class="${cls}"><span class="step-dot">${s.done ? ICON_CHECK_SM : ""}</span><a href="${s.href}">${escapeHtml(s.label)}</a></div>`;
    })
    .join("");

  return `<div class="checklist-card">
    <div class="checklist-head"><h2>Get set up</h2><span class="checklist-progress-label">${doneCount}/${steps.length} done</span></div>
    <div class="progress-track"><div class="progress-fill p${pct}"></div></div>
    <div class="checklist-steps">${stepsHtml}</div>
  </div>`;
}

function achievementBadges(stats: PublishStats): string {
  const badges: string[] = [];
  if (stats.totalPublished >= 1) badges.push(`<span class="badge">${ICON_STAR}First post published</span>`);
  if (stats.currentStreakDays >= 3) badges.push(`<span class="badge">${ICON_FLAME}${stats.currentStreakDays}-day streak</span>`);
  if (stats.totalPublished >= 10) badges.push(`<span class="badge">${ICON_TROPHY}10 posts published</span>`);
  if (stats.totalPublished >= 50) badges.push(`<span class="badge">${ICON_TROPHY}50 posts published</span>`);
  return badges.length ? `<div class="badge-row">${badges.join("")}</div>` : "";
}

function statsPanel(stats: PublishStats): string {
  const weeks: { date: string; count: number }[][] = [];
  for (let i = 0; i < stats.activity.length; i += 7) weeks.push(stats.activity.slice(i, i + 7));
  const levelFor = (count: number) => (count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3);
  const heatmapHtml = weeks
    .map(
      (week) =>
        `<div class="heatmap-week">${week
          .map((d) => `<div class="heatmap-day" data-level="${levelFor(d.count)}" title="${d.date}: ${d.count} published"></div>`)
          .join("")}</div>`
    )
    .join("");

  return `${achievementBadges(stats)}
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-value">${stats.totalPublished}</div><div class="stat-label">Published</div></div>
    <div class="stat-card"><div class="stat-value">${stats.successRate}<span class="unit">%</span></div><div class="stat-label">Success rate</div></div>
    <div class="stat-card streak"><div class="stat-value">${stats.currentStreakDays}<span class="unit">day${stats.currentStreakDays === 1 ? "" : "s"}</span></div><div class="stat-label">Current streak</div></div>
    <div class="stat-card"><div class="stat-value">${stats.totalPosts}</div><div class="stat-label">Total posts</div></div>
  </div>
  <div class="card">
    <div class="heatmap">${heatmapHtml}</div>
    <div class="heatmap-foot"><span>Last 12 weeks</span><span>Publishing activity</span></div>
  </div>`;
}

export function buildDashboard(opts: { trustlottoRepoRoot: string; mediaRoots: string[] }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  // ---------------------------------------------------------------- health check (for Docker/monitoring - public, no auth)
  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  // ---------------------------------------------------------------- public landing page
  router.get("/", (req, res) => {
    res.send(renderLanding(isLoggedIn(req)));
  });

  // ---------------------------------------------------------------- auth
  router.get("/login", (_req, res) => {
    res.send(
      shell(
        "Log in",
        `<div class="auth-wrap"><div class="auth-card">
          ${brand("/")}
          <form method="post" action="/login">
            <div class="field">
              <label>Dashboard password</label>
              <input type="password" name="password" placeholder="••••••••" autofocus>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Log in</button>
          </form>
          <p class="auth-foot muted"><a href="/">← Back to home</a></p>
        </div></div>`,
        { noindex: true }
      )
    );
  });
  router.post("/login", loginLimiter, (req, res) => {
    const expected = Buffer.from(process.env.DASHBOARD_PASSWORD ?? "");
    const given = Buffer.from(String(req.body.password ?? ""));
    const ok = expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given);
    if (!ok) {
      return res.status(401).send(
        shell(
          "Log in",
          `<div class="auth-wrap"><div class="auth-card">
            ${brand("/")}
            <p class="auth-error">Wrong password. Try again.</p>
            <form method="post" action="/login">
              <div class="field">
                <label>Dashboard password</label>
                <input type="password" name="password" placeholder="••••••••" autofocus>
              </div>
              <button class="btn btn-primary btn-block" type="submit">Log in</button>
            </form>
            <p class="auth-foot muted"><a href="/">← Back to home</a></p>
          </div></div>`,
          { noindex: true }
        )
      );
    }
    const token = randomUUID();
    validSessions.add(token);
    const secure = req.secure ? "; Secure" : "";
    res.setHeader("Set-Cookie", `trustsocial_session=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
    res.redirect("/app");
  });

  // ---------------------------------------------------------------- media (public on purpose - Instagram/
  // TikTok's own servers fetch this by URL and never carry our session cookie, so this route must be
  // reachable BEFORE the requireAuth gate below, not after it.
  router.get("/media/:file", (req, res) => {
    const name = basename(req.params.file); // strip any path traversal - only a bare filename is ever honored
    const hit = opts.mediaRoots.map((root) => resolve(root, name)).find((p) => existsSync(p));
    if (!hit) return res.status(404).send("Not found.");
    res.sendFile(hit);
  });

  // Scoped to /app and /auth (not a blanket router.use) so a request for a genuinely
  // unmatched path (a bot probing random URLs, a stale bookmark) falls through to the real
  // 404 handler at the bottom instead of being redirected to /login - redirecting every
  // unmatched path to a login page is both wrong and a minor information leak.
  router.use(["/app", "/auth"], requireAuth);

  // CSRF check for every authenticated state-changing request. GETs (including the OAuth
  // initiate/callback redirects) are read-only from our own server's point of view and are
  // left alone - only POSTs mutate anything here.
  router.use(["/app", "/auth"], (req, res, next) => {
    if (req.method !== "POST") return next();
    if (!verifyCsrfToken(sessionToken(req), req.body?._csrf)) {
      return res
        .status(403)
        .send(errorPage(403, "Form expired", "This form was stale or came from an untrusted origin. Go back and try again.", "/app", "← Back to queue"));
    }
    next();
  });

  router.post("/app/logout", (req, res) => {
    const token = sessionToken(req);
    if (token) {
      validSessions.delete(token);
      clearCsrfToken(token);
    }
    res.setHeader("Set-Cookie", `trustsocial_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.redirect("/");
  });

  // ---------------------------------------------------------------- queue
  router.get("/app", (req, res) => {
    const csrf = getOrCreateCsrfToken(sessionToken(req)!);
    const posts = listPosts();
    const accounts = listAccounts();
    const byStatus = new Map<string, typeof posts>();
    for (const s of STATUS_ORDER) byStatus.set(s, []);
    for (const p of posts) byStatus.get(p.status)?.push(p);

    const stats = getPublishStats();
    const checklist = setupChecklist(
      accounts.length > 0,
      posts.length > 0,
      posts.some((p) => p.status !== "pending_review" && p.status !== "rejected"),
      stats.totalPublished > 0
    );

    const statPill = STATUS_ORDER.map((s) => `<span class="stat-pill"><b>${byStatus.get(s)?.length ?? 0}</b> ${STATUS_LABEL[s].toLowerCase()}</span>`).join("");

    const sections = STATUS_ORDER.map((s) => {
      const items = byStatus.get(s) ?? [];
      if (!items.length) return "";
      return `<div class="section-heading">${STATUS_LABEL[s]} · ${items.length}</div>${items.map((p) => postCard(p, csrf)).join("\n")}`;
    }).join("\n");

    const empty = `<div class="empty-state">
      <div class="empty-icon">${ICON_INBOX}</div>
      <h3>Nothing in the queue yet</h3>
      <p>Connect an account, then import drafts to get started.</p>
      <form method="post" action="/app/import" class="mt-1">
        ${csrfField(csrf)}
        <button class="btn btn-primary" type="submit">${ICON_IMPORT}Import from TrustLotto queue</button>
      </form>
    </div>`;

    res.send(
      appPage(
        "Queue",
        "queue",
        `<div class="app-header">
          <div class="app-header-row">
            <h1>Queue</h1>
            <form method="post" action="/app/import">
              ${csrfField(csrf)}
              <button class="btn btn-primary btn-sm" type="submit">${ICON_IMPORT}Import from TrustLotto queue</button>
            </form>
          </div>
        </div>
        ${checklist}
        ${statsPanel(stats)}
        <div class="stat-strip">${statPill}</div>
        ${posts.length ? sections : empty}`,
        csrf
      )
    );
  });

  router.post("/app/import", (_req, res) => {
    const result = importTrustLottoQueue({
      queueDir: resolve(opts.trustlottoRepoRoot, "marketing/social/queue"),
      repoRoot: opts.trustlottoRepoRoot,
    });
    const csrf = getOrCreateCsrfToken(sessionToken(_req)!);
    res.send(
      appPage(
        "Import result",
        "queue",
        `<div class="app-header"><h1>Import complete</h1></div>
        <div class="card">
          <p>Scanned <b>${result.scanned}</b> block(s) across ${result.files.length} file(s): ${result.files.map(escapeHtml).join(", ") || "(none found)"}.</p>
          <div class="stat-strip">
            <span class="stat-pill"><b>${result.imported}</b> imported</span>
            <span class="stat-pill"><b>${result.skippedNotVideoplatform}</b> skipped · text-only platform</span>
            <span class="stat-pill"><b>${result.skippedNoAccount}</b> skipped · no connected account</span>
            <span class="stat-pill"><b>${result.skippedDuplicate}</b> skipped · already imported</span>
          </div>
        </div>
        <a class="btn btn-secondary" href="/app">← Back to queue</a>`,
        csrf
      )
    );
  });

  router.post("/app/posts/:id/approve", (req, res) => {
    setPostStatus(req.params.id, "scheduled");
    res.redirect("/app");
  });
  router.post("/app/posts/:id/reject", (req, res) => {
    setPostStatus(req.params.id, "rejected");
    res.redirect("/app");
  });
  router.post("/app/posts/:id/retry", (req, res) => {
    setPostStatus(req.params.id, "scheduled");
    res.redirect("/app");
  });
  router.post("/app/posts/:id/edit", (req, res) => {
    updatePost(req.params.id, { caption: req.body.caption, scheduledFor: req.body.scheduledFor });
    res.redirect("/app");
  });

  // ---------------------------------------------------------------- accounts + OAuth
  router.get("/app/accounts", (req, res) => {
    const connected = new Map(listAccounts().map((a) => [a.platform, a]));
    const cards = (Object.keys(adapters) as Platform[])
      .map((platform) => {
        const adapter = adapterFor(platform);
        const account = connected.get(platform);
        const reviewNote = platform === "tiktok" ? `<span class="tag requires-review ml-sm">Needs TikTok review</span>` : "";
        let status: string;
        let action: string;
        if (!adapter.isConfigured()) {
          status = `<p class="account-status off">Not configured</p><p class="faint">Add its client id/secret to <code>.env</code> first.</p>`;
          action = `<button class="btn btn-secondary btn-sm" disabled>Connect</button>`;
        } else if (account) {
          status = `<p class="account-status ok">Connected as <b>${escapeHtml(account.handle)}</b></p>`;
          // A plain link, not a <form method="get">: this navigates same-origin to /auth/:platform,
          // which immediately 302s to the platform's (cross-origin) consent screen. A GET form's
          // submission is covered by the page's `form-action 'self'` CSP directive - and per the
          // CSP3 spec, that directive also governs any redirect the target then issues, not just
          // the form's own immediate target. Chrome enforces this: the form-based version silently
          // blocked the whole OAuth flow the instant /auth/:platform tried to redirect to
          // accounts.google.com/tiktok.com. A plain <a> navigation was never covered by
          // form-action in the first place, so it isn't affected.
          action = `<a class="btn btn-secondary btn-sm" href="/auth/${platform}">Reconnect</a>`;
        } else {
          status = `<p class="account-status off">Not connected</p>`;
          action = `<a class="btn btn-primary btn-sm" href="/auth/${platform}">Connect</a>`;
        }
        return `<div class="card account-card">
          <div class="card-row justify-between">
            <div class="platform-icon">${platformIcon(platform)}</div>
            ${reviewNote}
          </div>
          <div><h3 class="mb-xs">${platformLabel(platform)}</h3>${status}</div>
          ${action}
        </div>`;
      })
      .join("\n");
    res.send(
      appPage(
        "Accounts",
        "accounts",
        `<div class="app-header"><h1>Accounts</h1><p class="muted">Connect each platform once - TrustSocial never sees your password, only the OAuth token each platform hands back.</p></div>
        <div class="account-grid">${cards}</div>`,
        getOrCreateCsrfToken(sessionToken(req)!)
      )
    );
  });

  router.get("/auth/:platform", (req, res) => {
    const platform = req.params.platform as Platform;
    const adapter = adapters[platform];
    if (!adapter) return res.status(404).send(errorPage(404, "Unknown platform", "That platform isn't supported."));
    if (!adapter.isConfigured())
      return res.status(400).send(errorPage(400, "Not configured", `${platformLabel(platform)} isn't configured in .env yet.`, "/app/accounts", "← Back to accounts"));
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now());
    res.redirect(adapter.buildAuthUrl(state));
  });

  router.get("/auth/:platform/callback", async (req, res) => {
    const platform = req.params.platform as Platform;
    const adapter = adapters[platform];
    if (!adapter) return res.status(404).send(errorPage(404, "Unknown platform", "That platform isn't supported."));
    const state = String(req.query.state ?? "");
    const seenAt = oauthStates.get(state);
    if (!seenAt || Date.now() - seenAt > 10 * 60_000) {
      return res
        .status(400)
        .send(errorPage(400, "Connect link expired", "This connect link expired or was already used.", "/app/accounts", "← Back to accounts"));
    }
    oauthStates.delete(state);
    try {
      const { handle, credentials } = await adapter.handleCallback(req.query as Record<string, string>);
      upsertAccount({ platform, handle, encryptedCredentials: encryptJson(credentials) });
      res.redirect("/app/accounts");
    } catch (err: any) {
      res
        .status(500)
        .send(errorPage(500, "Connect failed", `Could not connect ${platformLabel(platform)}: ${String(err?.message ?? err)}`, "/app/accounts", "← Back to accounts"));
    }
  });

  // ---------------------------------------------------------------- 404 + error fallbacks (must be last)
  router.use((_req, res) => {
    res.status(404).send(errorPage(404, "Page not found", "That page doesn't exist - it may have moved."));
  });
  router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[dashboard] unhandled error:", err);
    res.status(500).send(errorPage(500, "Something went wrong", "An unexpected error occurred. It's been logged."));
  });

  return router;
}
