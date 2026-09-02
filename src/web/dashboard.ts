import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { listAccounts, listPosts, setPostStatus, updatePost, upsertAccount } from "../db.js";
import { encryptJson } from "../crypto.js";
import { adapters, adapterFor } from "../platforms/index.js";
import { importTrustLottoQueue } from "../importers/trustlotto.js";
import type { Platform } from "../types.js";
import { escapeHtml, brand, platformIcon, platformLabel, platformTag, shell } from "./layout.js";
import { renderLanding } from "./landing.js";

const validSessions = new Set<string>(); // in-memory on purpose - a restart just means logging in again
const oauthStates = new Map<string, number>(); // state -> created-at ms, to prevent CSRF on the OAuth callback

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function isLoggedIn(req: Request): boolean {
  const token = readCookie(req, "trustsocial_session");
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
function appHeader(active: "queue" | "accounts", statusMsg?: string): string {
  return `<header class="site-header"><div class="wrap header-inner">
    ${brand("/app")}
    <nav class="site-nav">
      <div class="nav-links">
        <a href="/app" style="${active === "queue" ? "color:var(--text)" : ""}">Queue</a>
        <a href="/app/accounts" style="${active === "accounts" ? "color:var(--text)" : ""}">Accounts</a>
      </div>
      <form method="post" action="/logout">
        <button class="btn btn-ghost btn-sm" type="submit">${ICON_LOGOUT}Log out</button>
      </form>
    </nav>
  </div></header>${statusMsg ?? ""}`;
}

function appPage(title: string, active: "queue" | "accounts", body: string, statusMsg?: string): string {
  return shell(
    title,
    `${appHeader(active, statusMsg)}<div class="app-shell"><main class="app-main"><div class="wrap">${body}</div></main></div>`
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

function postCard(p: ReturnType<typeof listPosts>[number]): string {
  const media = p.media[0];
  const actions: string[] = [];
  if (p.status === "pending_review" || p.status === "scheduled") {
    actions.push(`
      <form method="post" action="/app/posts/${p.id}/edit" class="edit-form">
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
      <form method="post" action="/app/posts/${p.id}/approve"><button class="btn btn-primary btn-sm" type="submit">Approve &amp; schedule</button></form>
      <form method="post" action="/app/posts/${p.id}/reject"><button class="btn btn-danger btn-sm" type="submit">Reject</button></form>`);
  }
  if (p.status === "failed") {
    actions.push(`<form method="post" action="/app/posts/${p.id}/retry"><button class="btn btn-primary btn-sm" type="submit">Retry now</button></form>`);
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
    ${p.status === "failed" && p.lastError ? `<p class="faint" style="color:var(--danger)">Last error: ${escapeHtml(p.lastError)}</p>` : ""}
    ${p.status === "published" ? `<p class="faint">Published ${escapeHtml(p.publishedAt ?? "")}${p.platformPostId ? ` → <a href="${escapeHtml(p.platformPostId)}" target="_blank" rel="noopener">${escapeHtml(p.platformPostId)}</a>` : ""}</p>` : ""}
    ${actions.length ? `<div class="card-actions">${actions.join("\n")}</div>` : ""}
  </div>`;
}

export function buildDashboard(opts: { trustlottoRepoRoot: string; mediaRoots: string[] }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

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
        </div></div>`
      )
    );
  });
  router.post("/login", (req, res) => {
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
          </div></div>`
        )
      );
    }
    const token = randomUUID();
    validSessions.add(token);
    res.setHeader("Set-Cookie", `trustsocial_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    res.redirect("/app");
  });
  router.post("/logout", (req, res) => {
    const token = readCookie(req, "trustsocial_session");
    if (token) validSessions.delete(token);
    res.setHeader("Set-Cookie", `trustsocial_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.redirect("/");
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

  router.use(requireAuth);

  // ---------------------------------------------------------------- queue
  router.get("/app", (_req, res) => {
    const posts = listPosts();
    const byStatus = new Map<string, typeof posts>();
    for (const s of STATUS_ORDER) byStatus.set(s, []);
    for (const p of posts) byStatus.get(p.status)?.push(p);

    const stats = STATUS_ORDER.map((s) => `<span class="stat-pill"><b>${byStatus.get(s)?.length ?? 0}</b> ${STATUS_LABEL[s].toLowerCase()}</span>`).join("");

    const sections = STATUS_ORDER.map((s) => {
      const items = byStatus.get(s) ?? [];
      if (!items.length) return "";
      return `<div class="section-heading">${STATUS_LABEL[s]} · ${items.length}</div>${items.map(postCard).join("\n")}`;
    }).join("\n");

    const empty = `<div class="empty-state">
      <div class="empty-icon">${ICON_INBOX}</div>
      <h3>Nothing in the queue yet</h3>
      <p>Connect an account, then import drafts to get started.</p>
      <form method="post" action="/app/import" style="margin-top:1rem">
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
              <button class="btn btn-primary btn-sm" type="submit">${ICON_IMPORT}Import from TrustLotto queue</button>
            </form>
          </div>
          <div class="stat-strip">${stats}</div>
        </div>
        ${posts.length ? sections : empty}`
      )
    );
  });

  router.post("/app/import", (_req, res) => {
    const result = importTrustLottoQueue({
      queueDir: resolve(opts.trustlottoRepoRoot, "marketing/social/queue"),
      repoRoot: opts.trustlottoRepoRoot,
    });
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
        <a class="btn btn-secondary" href="/app">← Back to queue</a>`
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
  router.get("/app/accounts", (_req, res) => {
    const connected = new Map(listAccounts().map((a) => [a.platform, a]));
    const cards = (Object.keys(adapters) as Platform[])
      .map((platform) => {
        const adapter = adapterFor(platform);
        const account = connected.get(platform);
        const reviewNote =
          platform === "tiktok" ? `<span class="tag requires-review" style="margin-left:.4rem">Needs TikTok review</span>` : "";
        let status: string;
        let action: string;
        if (!adapter.isConfigured()) {
          status = `<p class="account-status off">Not configured</p><p class="faint">Add its client id/secret to <code>.env</code> first.</p>`;
          action = `<button class="btn btn-secondary btn-sm" disabled>Connect</button>`;
        } else if (account) {
          status = `<p class="account-status ok">Connected as <b>${escapeHtml(account.handle)}</b></p>`;
          action = `<form method="get" action="/auth/${platform}"><button class="btn btn-secondary btn-sm" type="submit">Reconnect</button></form>`;
        } else {
          status = `<p class="account-status off">Not connected</p>`;
          action = `<form method="get" action="/auth/${platform}"><button class="btn btn-primary btn-sm" type="submit">Connect</button></form>`;
        }
        return `<div class="card account-card">
          <div class="card-row" style="justify-content:space-between">
            <div class="platform-icon">${platformIcon(platform)}</div>
            ${reviewNote}
          </div>
          <div><h3 style="margin-bottom:.15rem">${platformLabel(platform)}</h3>${status}</div>
          ${action}
        </div>`;
      })
      .join("\n");
    res.send(
      appPage(
        "Accounts",
        "accounts",
        `<div class="app-header"><h1>Accounts</h1><p class="muted">Connect each platform once - TrustSocial never sees your password, only the OAuth token each platform hands back.</p></div>
        <div class="account-grid">${cards}</div>`
      )
    );
  });

  router.get("/auth/:platform", (req, res) => {
    const platform = req.params.platform as Platform;
    const adapter = adapters[platform];
    if (!adapter) return res.status(404).send("Unknown platform.");
    if (!adapter.isConfigured()) return res.status(400).send(`${platform} isn't configured in .env yet.`);
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now());
    res.redirect(adapter.buildAuthUrl(state));
  });

  router.get("/auth/:platform/callback", async (req, res) => {
    const platform = req.params.platform as Platform;
    const adapter = adapters[platform];
    if (!adapter) return res.status(404).send("Unknown platform.");
    const state = String(req.query.state ?? "");
    const seenAt = oauthStates.get(state);
    if (!seenAt || Date.now() - seenAt > 10 * 60_000) {
      return res.status(400).send(
        appPage(
          "Connect expired",
          "accounts",
          `<div class="card"><p>This connect link expired or was already used.</p><a class="btn btn-secondary" href="/app/accounts">← Back to accounts</a></div>`
        )
      );
    }
    oauthStates.delete(state);
    try {
      const { handle, credentials } = await adapter.handleCallback(req.query as Record<string, string>);
      upsertAccount({ platform, handle, encryptedCredentials: encryptJson(credentials) });
      res.redirect("/app/accounts");
    } catch (err: any) {
      res.status(500).send(
        appPage(
          "Connect failed",
          "accounts",
          `<div class="card"><p>Could not connect ${escapeHtml(platform)}: ${escapeHtml(String(err?.message ?? err))}</p><a class="btn btn-secondary" href="/app/accounts">← Back to accounts</a></div>`
        )
      );
    }
  });

  return router;
}
