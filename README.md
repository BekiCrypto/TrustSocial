# Postbox

A tiny, self-hosted post scheduler for a single brand's social accounts. Built because the
established open-source options didn't fit a one-brand, few-accounts use case: **Postiz** now
requires a full Elasticsearch + Temporal workflow-engine stack (built for serving many customers
at once), and **Mixpost**'s free tier doesn't support TikTok, Instagram, or YouTube (that needs
its paid tier). Postbox is the missing middle: one small Node process, one SQLite file, nothing
else running.

**Status: early, unaudited by real traffic yet.** The three platform integrations are written
against each platform's current documented API, but haven't been exercised against live
developer-app credentials. Test each one for real before trusting it unattended.

## What it does

1. **Reads a queue** of drafted posts (from a `### POST` block format — see below — or write your
   own importer for a different source).
2. **Shows them to a human** for approval/edit/reject before anything goes near a real account.
3. **Publishes on schedule** once approved — one small loop, checks once a minute.

It does **not**: manage multiple brands/tenants, do analytics, handle text-only platforms (X,
Telegram, Discord aren't in scope — those don't need a video-publish API, just paste the drafted
text in yourself), or store anything it doesn't need to.

## Platforms supported

| Platform | API used | Public review needed to post publicly? |
|---|---|---|
| YouTube (Shorts) | YouTube Data API v3 | No, for your own channel — OAuth app can stay in "Testing" |
| Instagram (Reels) | Instagram Graph API | No, for your own account — app can stay in Development Mode as long as the account is added as an App Role |
| TikTok | Content Posting API v2 | **Yes** — unaudited apps can only post privately (`SELF_ONLY`). See below. |

## One-time setup, per platform

You do this once, in each platform's own developer console — Postbox never sees a password, only
the OAuth tokens each platform hands back after you approve the connection in your browser.

### YouTube
1. [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **YouTube Data API v3**.
2. OAuth consent screen: type **External**, fill the basics, leave publish status as **Testing** (fine for your own channel — full verification is only required to open it to arbitrary users).
3. Credentials → **Create OAuth client ID** → type **Web application** → add `{PUBLIC_URL}/auth/youtube/callback` as an authorized redirect URI.
4. Put the client ID/secret in `.env` as `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`.

### Instagram
1. [developers.facebook.com](https://developers.facebook.com) → Create App → type **Business**.
2. Add the **Instagram Graph API** product.
3. Your Instagram account needs to be a **Business or Creator** account, linked to a **Facebook Page** you admin.
4. Under App Roles, add your own Facebook account as an Admin/Developer/Tester — this is what lets it work without a full Meta App Review, since it's only ever posting as you.
5. Add `{PUBLIC_URL}/auth/instagram/callback` as a valid OAuth redirect URI.
6. Put the app ID/secret in `.env` as `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`.

### TikTok
1. [developers.tiktok.com](https://developers.tiktok.com) → Manage apps → Create app.
2. Add the **Content Posting API** product.
3. Add `{PUBLIC_URL}/auth/tiktok/callback` as a redirect URI.
4. **Verify your domain** in the app's settings (a DNS TXT record or file-upload check) — TikTok will only fetch video URLs from a domain you've proven you own.
5. Put the client key/secret in `.env` as `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
6. **Leave `TIKTOK_AUDITED=false`.** Every post publishes as private (`SELF_ONLY`) until TikTok has reviewed and approved the app for public posting — that review is TikTok's process, on TikTok's timeline, and nothing in this codebase can shortcut it. Submit for review when you're ready (inside the TikTok developer dashboard); once approved, flip `TIKTOK_AUDITED=true`.

## Running it

```bash
cp .env.example .env
# fill in PUBLIC_URL, TOKEN_ENCRYPTION_KEY, DASHBOARD_PASSWORD, and whichever
# platform credentials you have so far - you don't need all three to start.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → TOKEN_ENCRYPTION_KEY

npm install
npm run dev        # http://localhost:4400, auto-reloads on change
# or: npm run build && npm start
```

Then:
1. Open the dashboard, log in with `DASHBOARD_PASSWORD`.
2. **Accounts** → Connect each platform you've configured (this is where you do the real login + 2FA, in that platform's own popup — Postbox never touches your password).
3. **Queue** → Import from TrustLotto queue → review each drafted post → Approve or Reject → edit the caption/time first if you want.
4. Leave it running. The scheduler checks every minute and publishes anything approved whose time has come.

## The queue format

Postbox is generic; the one TrustLotto-specific piece is `src/importers/trustlotto.ts`, which
reads `### POST` blocks out of `marketing/social/queue/*.md` in the TrustLotto repo:

```
### POST
platform: tiktok
scheduled_for: 2026-09-04T15:00:00Z
media: marketing/social/video/out/some-video.mp4
source: free text, just for your own traceability
---
The caption/body text goes here. Multiple lines,
emoji, hashtags - whatever the post needs.
---
```

`platform` must be `youtube`, `instagram`, or `tiktok` (text-only platforms are skipped, not
errored — mix them freely in the same file). `media` is a path relative to the TrustLotto repo
root; Postbox serves it at `{PUBLIC_URL}/media/<filename>` so Instagram/TikTok's URL-fetch
requirement is satisfied automatically. Re-running the import is safe — each block is
fingerprinted so it's only ever created once.

Point a different importer at a different source (a JSON file, another repo, a form) by writing
a new file matching the same shape as `trustlotto.ts` and wiring it into the dashboard's
`/import` route — everything downstream (approval, scheduling, publishing) is unchanged.

## Deploying

```bash
git clone https://github.com/BekiCrypto/TrustSocial.git
cd TrustSocial
cp .env.example .env   # fill in TOKEN_ENCRYPTION_KEY, DASHBOARD_PASSWORD, PUBLIC_URL, platform creds
docker compose up -d --build
```

By default `docker-compose.yml` only binds the dashboard to `127.0.0.1:4400` on the host — **not**
exposed to the internet yet. Two reasons: the login page posts a password over plain HTTP, and
this thing will hold real OAuth tokens once accounts are connected — neither should sit on the
open internet without TLS in front of it. Google, Meta, and TikTok also generally require an
`https://` redirect URI for anything other than `localhost` anyway, so a bare `http://ip:4400`
won't get you a working "Connect account" flow regardless.

**To actually go live:** put a real domain in front of it with TLS — the simplest path if the
domain is already on Cloudflare (as trustlotto.app is) is a proxied subdomain (e.g.
`social.trustlotto.app`) pointed at this host; Cloudflare terminates HTTPS at the edge and proxies
plain HTTP to the container, so nothing extra is needed on the box itself. Then set `PUBLIC_URL`
to that `https://` URL, change the compose port mapping to `"4400:4400"` (or route through a
reverse proxy already on the box), and re-run `docker compose up -d`.

## Security notes

- Platform tokens are encrypted at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`). Losing that key
  means reconnecting every account — there's no recovery path, by design (keeps the code simple
  and auditable instead of building key-rotation machinery for a single-operator tool).
- The dashboard is a single shared password, not real user accounts — appropriate for "one
  brand, one or two operators," not for a multi-user product.
- Never commit `.env` or `postbox.db` — both are gitignored.
- `TIKTOK_AUDITED` exists specifically so a misconfigured `.env` can't accidentally make a real
  public post before TikTok has actually reviewed the app.

## License

MIT — see `LICENSE`. Built for TrustLotto's own use first; the importer is the only
TrustLotto-specific piece, so it should be reusable for any single-brand setup.
