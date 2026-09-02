import type { Account, Post } from "../types.js";
import type { PlatformAdapter, StoredCredentials } from "./types.js";

/**
 * Instagram Graph API (Reels publishing), via the classic Facebook-Login + linked-
 * Page pattern - the longest-stable path, though Meta has since also introduced
 * "Instagram API with Instagram Login" which skips the Page requirement entirely.
 * Re-check https://developers.facebook.com/docs/instagram-platform before relying
 * on this in production; Meta reshuffles scope names and API versions often.
 *
 * Setup: developers.facebook.com -> Create App (type: Business) -> add the
 * "Instagram Graph API" product -> your Instagram account must be a
 * Business/Creator account linked to a Facebook Page you admin -> add
 * {PUBLIC_URL}/auth/instagram/callback as a valid OAuth redirect URI.
 * For OUR OWN account only (not a public SaaS), the app can stay in Development
 * Mode as long as the IG/FB account is added as an App Role (Admin/Developer/
 * Tester) on the app - no App Review needed for that case.
 */
const GRAPH = "https://graph.facebook.com/v21.0";
const SCOPES = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"];

function appId() {
  return process.env.INSTAGRAM_APP_ID!;
}
function appSecret() {
  return process.env.INSTAGRAM_APP_SECRET!;
}
function redirectUri() {
  return `${process.env.PUBLIC_URL}/auth/instagram/callback`;
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`Instagram/Graph API error on GET ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function graphPost(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(`Instagram/Graph API error on POST ${path}: ${JSON.stringify(body)}`);
  return body;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const instagramAdapter: PlatformAdapter = {
  platform: "instagram",

  isConfigured() {
    return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
  },

  buildAuthUrl(state) {
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", appId());
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query) {
    // 1) code -> short-lived user token
    const shortLived = await graphGet("/oauth/access_token", {
      client_id: appId(),
      client_secret: appSecret(),
      redirect_uri: redirectUri(),
      code: query.code,
    });
    // 2) short-lived -> long-lived (~60 day) user token
    const longLived = await graphGet("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: appId(),
      client_secret: appSecret(),
      fb_exchange_token: shortLived.access_token,
    });
    // 3) find the Page this user admins, then the IG Business account behind it
    const pages = await graphGet("/me/accounts", { access_token: longLived.access_token });
    const page = pages.data?.[0];
    if (!page) throw new Error("No Facebook Page found for this account - Instagram publishing needs a linked Page.");
    const igLink = await graphGet(`/${page.id}`, {
      fields: "instagram_business_account,name",
      access_token: page.access_token,
    });
    const igUserId = igLink.instagram_business_account?.id;
    if (!igUserId) throw new Error(`Page "${page.name}" has no linked Instagram Business/Creator account.`);
    const igProfile = await graphGet(`/${igUserId}`, { fields: "username", access_token: page.access_token });

    return {
      handle: `@${igProfile.username}`,
      credentials: {
        accessToken: page.access_token, // page access tokens don't expire on their own while the user token is valid
        refreshToken: longLived.access_token, // the long-lived USER token; re-exchange this to refresh
        expiresAt: Date.now() + (Number(longLived.expires_in ?? 5_184_000) * 1000),
        extra: { igUserId, pageId: page.id },
      },
    };
  },

  async ensureFreshToken(creds) {
    if (!creds.expiresAt || creds.expiresAt - Date.now() > 3 * 24 * 3600_000) return creds;
    if (!creds.refreshToken) throw new Error("Instagram long-lived token expired with nothing to refresh from - reconnect the account.");
    const refreshed = await graphGet("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: appId(),
      client_secret: appSecret(),
      fb_exchange_token: creds.refreshToken,
    });
    return {
      ...creds,
      refreshToken: refreshed.access_token,
      expiresAt: Date.now() + Number(refreshed.expires_in ?? 5_184_000) * 1000,
    };
  },

  async publish(post: Post, _account: Account, creds: StoredCredentials) {
    const video = post.media.find((m) => m.kind === "video");
    if (!video) throw new Error("Instagram post has no video attached.");
    if (!/^https?:\/\//.test(video.path)) {
      throw new Error(
        "Instagram fetches media by public URL - this post's media is a local path. " +
          "Serve it first (Postbox's /media/:id route) or host it and use that URL."
      );
    }
    const igUserId = creds.extra?.igUserId;
    if (!igUserId) throw new Error("Missing igUserId on stored Instagram credentials - reconnect the account.");

    // 1) create a REELS media container
    const container = await graphPost(`/${igUserId}/media`, {
      media_type: "REELS",
      video_url: video.path,
      caption: post.caption,
      access_token: creds.accessToken,
    });

    // 2) poll until Instagram has finished processing the video (can take ~10-60s)
    let status = "IN_PROGRESS";
    for (let i = 0; i < 30 && status !== "FINISHED"; i++) {
      await sleep(4000);
      const check = await graphGet(`/${container.id}`, { fields: "status_code", access_token: creds.accessToken });
      status = check.status_code;
      if (status === "ERROR") throw new Error("Instagram failed to process the uploaded video.");
    }
    if (status !== "FINISHED") throw new Error("Instagram video processing did not finish in time - try publishing again shortly.");

    // 3) publish the container
    const published = await graphPost(`/${igUserId}/media_publish`, {
      creation_id: container.id,
      access_token: creds.accessToken,
    });
    return { platformPostId: `https://instagram.com/reel/${published.id}` };
  },
};
