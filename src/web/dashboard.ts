import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { listAccounts, listPosts, setPostStatus, updatePost, upsertAccount } from "../db.js";
import { encryptJson } from "../crypto.js";
import { adapters, adapterFor } from "../platforms/index.js";
import { importTrustLottoQueue } from "../importers/trustlotto.js";
import type { Platform } from "../types.js";

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

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, "postbox_session");
  if (token && validSessions.has(token)) return next();
  res.redirect("/login");
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Postbox</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fbfaf8}
    h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
    .card{border:1px solid #ddd;border-radius:10px;padding:1rem;margin:.75rem 0;background:#fff}
    .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
    .tag{display:inline-block;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:.15rem .5rem;border-radius:5px;background:#eee}
    .tag.pending_review{background:#fff3cd} .tag.scheduled{background:#cfe2ff} .tag.published{background:#d1e7dd}
    .tag.failed{background:#f8d7da} .tag.rejected{background:#e2e3e5} .tag.publishing{background:#cff4fc}
    textarea{width:100%;min-height:4rem;font-family:inherit;font-size:.95rem;padding:.5rem;border-radius:6px;border:1px solid #ccc}
    input[type=text],input[type=password],input[type=datetime-local]{padding:.4rem;border-radius:6px;border:1px solid #ccc;font-family:inherit}
    button{padding:.4rem .8rem;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;font-size:.85rem}
    button.secondary{background:#fff;color:#1a1a1a}
    button.danger{background:#fff;color:#b02a37;border-color:#b02a37}
    .muted{color:#777;font-size:.85rem}
    nav a{margin-right:1rem}
    code{background:#eee;padding:.1rem .3rem;border-radius:4px}
  </style></head><body>
  <nav><a href="/">Queue</a><a href="/accounts">Accounts</a></nav>
  ${body}
  </body></html>`;
}

const STATUS_ORDER = ["pending_review", "scheduled", "publishing", "failed", "published", "rejected"] as const;

function postCard(p: ReturnType<typeof listPosts>[number]): string {
  const media = p.media[0]?.path ?? "(no media)";
  const actions: string[] = [];
  if (p.status === "pending_review" || p.status === "scheduled") {
    actions.push(`
      <form method="post" action="/posts/${p.id}/edit" class="row">
        <textarea name="caption">${escapeHtml(p.caption)}</textarea>
      </form>
      <form method="post" action="/posts/${p.id}/edit" class="row" style="margin-top:.3rem">
        <label class="muted">Scheduled for (UTC) <input type="text" name="scheduledFor" value="${p.scheduledFor}" size="22"></label>
        <button class="secondary" type="submit">Save edits</button>
      </form>`);
  }
  if (p.status === "pending_review") {
    actions.push(`
      <form method="post" action="/posts/${p.id}/approve"><button type="submit">Approve &amp; schedule</button></form>
      <form method="post" action="/posts/${p.id}/reject"><button class="danger" type="submit">Reject</button></form>`);
  }
  if (p.status === "failed") {
    actions.push(`<form method="post" action="/posts/${p.id}/retry"><button type="submit">Retry now</button></form>
      <p class="muted">Last error: ${escapeHtml(p.lastError ?? "")}</p>`);
  }
  if (p.status === "published") {
    actions.push(`<p class="muted">Published ${p.publishedAt} → ${p.platformPostId ? `<a href="${p.platformPostId}" target="_blank">${p.platformPostId}</a>` : "(no link)"}</p>`);
  }
  return `<div class="card">
    <div class="row"><span class="tag">${p.platform}</span><span class="tag ${p.status}">${p.status.replace("_", " ")}</span>
      <span class="muted">scheduled ${p.scheduledFor}${p.source ? ` · from ${escapeHtml(p.source)}` : ""}</span></div>
    <p style="white-space:pre-wrap">${escapeHtml(p.caption)}</p>
    <p class="muted">media: <code>${escapeHtml(basename(media))}</code></p>
    ${actions.join("\n")}
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function buildDashboard(opts: { trustlottoRepoRoot: string; mediaRoots: string[] }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  // ---------------------------------------------------------------- auth
  router.get("/login", (_req, res) => {
    res.send(page("Log in", `<h1>Postbox</h1><form method="post" action="/login" class="card">
      <input type="password" name="password" placeholder="Dashboard password" autofocus>
      <button type="submit">Log in</button></form>`));
  });
  router.post("/login", (req, res) => {
    const expected = Buffer.from(process.env.DASHBOARD_PASSWORD ?? "");
    const given = Buffer.from(String(req.body.password ?? ""));
    const ok = expected.length > 0 && expected.length === given.length && timingSafeEqual(expected, given);
    if (!ok) return res.status(401).send(page("Log in", `<p>Wrong password.</p><a href="/login">Try again</a>`));
    const token = randomUUID();
    validSessions.add(token);
    res.setHeader("Set-Cookie", `postbox_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    res.redirect("/");
  });

  router.use(requireAuth);

  // ---------------------------------------------------------------- queue
  router.get("/", (_req, res) => {
    const posts = listPosts();
    const byStatus = new Map<string, typeof posts>();
    for (const s of STATUS_ORDER) byStatus.set(s, []);
    for (const p of posts) byStatus.get(p.status)?.push(p);

    const sections = STATUS_ORDER.map((s) => {
      const items = byStatus.get(s) ?? [];
      if (!items.length) return "";
      return `<h2>${s.replace("_", " ")} (${items.length})</h2>${items.map(postCard).join("\n")}`;
    }).join("\n");

    res.send(page("Queue", `
      <h1>Postbox</h1>
      <form method="post" action="/import"><button type="submit">Import from TrustLotto queue</button></form>
      ${sections || '<p class="muted">Nothing in the queue yet. Connect accounts, then import.</p>'}
    `));
  });

  router.post("/import", (_req, res) => {
    const result = importTrustLottoQueue({
      queueDir: resolve(opts.trustlottoRepoRoot, "marketing/social/queue"),
      repoRoot: opts.trustlottoRepoRoot,
    });
    res.send(page("Import result", `<h1>Import complete</h1>
      <p>Scanned ${result.scanned} blocks across ${result.files.length} file(s): ${result.files.map(escapeHtml).join(", ") || "(none found)"}.</p>
      <ul>
        <li>Imported: ${result.imported}</li>
        <li>Skipped (not a video platform - text-only channels aren't in scope yet): ${result.skippedNotVideoplatform}</li>
        <li>Skipped (no connected account for that platform yet): ${result.skippedNoAccount}</li>
        <li>Skipped (already imported before): ${result.skippedDuplicate}</li>
      </ul>
      <a href="/">Back to queue</a>`));
  });

  router.post("/posts/:id/approve", (req, res) => {
    setPostStatus(req.params.id, "scheduled");
    res.redirect("/");
  });
  router.post("/posts/:id/reject", (req, res) => {
    setPostStatus(req.params.id, "rejected");
    res.redirect("/");
  });
  router.post("/posts/:id/retry", (req, res) => {
    setPostStatus(req.params.id, "scheduled");
    res.redirect("/");
  });
  router.post("/posts/:id/edit", (req, res) => {
    updatePost(req.params.id, { caption: req.body.caption, scheduledFor: req.body.scheduledFor });
    res.redirect("/");
  });

  // ---------------------------------------------------------------- accounts + OAuth
  router.get("/accounts", (_req, res) => {
    const connected = new Map(listAccounts().map((a) => [a.platform, a]));
    const rows = (Object.keys(adapters) as Platform[])
      .map((platform) => {
        const adapter = adapterFor(platform);
        const account = connected.get(platform);
        if (!adapter.isConfigured()) {
          return `<div class="card"><span class="tag">${platform}</span> <span class="muted">not configured - add its client id/secret to .env first</span></div>`;
        }
        if (account) {
          return `<div class="card"><span class="tag">${platform}</span> connected as <b>${escapeHtml(account.handle)}</b>
            <form method="get" action="/auth/${platform}" style="display:inline"><button class="secondary" type="submit">Reconnect</button></form></div>`;
        }
        return `<div class="card"><span class="tag">${platform}</span>
          <form method="get" action="/auth/${platform}" style="display:inline"><button type="submit">Connect ${platform}</button></form></div>`;
      })
      .join("\n");
    res.send(page("Accounts", `<h1>Accounts</h1>${rows}`));
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
      return res.status(400).send("This connect link expired or was already used - go back to Accounts and try again.");
    }
    oauthStates.delete(state);
    try {
      const { handle, credentials } = await adapter.handleCallback(req.query as Record<string, string>);
      upsertAccount({ platform, handle, encryptedCredentials: encryptJson(credentials) });
      res.redirect("/accounts");
    } catch (err: any) {
      res.status(500).send(page("Connect failed", `<p>Could not connect ${platform}: ${escapeHtml(String(err?.message ?? err))}</p><a href="/accounts">Back</a>`));
    }
  });

  // ---------------------------------------------------------------- media (so Instagram/TikTok can pull-by-URL)
  router.get("/media/:file", (req, res) => {
    const name = basename(req.params.file); // strip any path traversal - only a bare filename is ever honored
    const hit = opts.mediaRoots.map((root) => resolve(root, name)).find((p) => existsSync(p));
    if (!hit) return res.status(404).send("Not found.");
    res.sendFile(hit);
  });

  return router;
}
