import type { Account, Post } from "../types.js";
import type { PlatformAdapter, StoredCredentials } from "./types.js";
import { publicMediaUrl } from "../media.js";

/**
 * TikTok Content Posting API v2 (Direct Post, PULL_FROM_URL variant).
 *
 * Setup: developers.tiktok.com -> Manage apps -> Create app -> add the
 * "Content Posting API" product -> add {PUBLIC_URL}/auth/tiktok/callback as a
 * redirect URI -> verify PUBLIC_URL's domain in the app's settings (TikTok will
 * only fetch video_url from a domain you've proven you own - a DNS TXT record or
 * a file-upload check, done once in their dashboard).
 *
 * THE ONE THING THIS CODE CANNOT FIX: unaudited apps may only publish with
 * privacy_level "SELF_ONLY" (private, visible only to the account owner) -
 * that's a TikTok policy on the app, not a parameter we can override. Public
 * posting needs TikTok to review and approve the app first (their timeline, not
 * ours). Until TIKTOK_AUDITED=true is set (only flip it once TikTok has actually
 * approved the app), every publish is forced to SELF_ONLY regardless of what's
 * requested, so nothing here can accidentally violate that.
 */
const API = "https://open.tiktokapis.com/v2";

function clientKey() {
  return process.env.TIKTOK_CLIENT_KEY!;
}
function clientSecret() {
  return process.env.TIKTOK_CLIENT_SECRET!;
}
function redirectUri() {
  return `${process.env.PUBLIC_URL}/auth/tiktok/callback`;
}
function isAudited() {
  return process.env.TIKTOK_AUDITED === "true";
}

async function post(path: string, body: unknown, accessToken?: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok || json.error?.code === "invalid" || (json.error && json.error.code !== "ok")) {
    throw new Error(`TikTok API error on POST ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const tiktokAdapter: PlatformAdapter = {
  platform: "tiktok",

  isConfigured() {
    return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
  },

  buildAuthUrl(state) {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize");
    url.searchParams.set("client_key", clientKey());
    url.searchParams.set("scope", "user.info.basic,video.publish,video.upload");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query) {
    const body = new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      code: query.code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
    });
    const res = await fetch(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens: any = await res.json();
    if (!res.ok || !tokens.access_token) throw new Error(`TikTok token exchange failed: ${JSON.stringify(tokens)}`);

    if (!isAudited()) {
      console.warn(
        "[tiktok] TIKTOK_AUDITED is not 'true' - every publish will be forced to privacy_level " +
          "SELF_ONLY (private) until TikTok approves this app for public posting."
      );
    }

    return {
      handle: `open_id:${tokens.open_id}`, // TikTok's basic-scope token doesn't include @username
      credentials: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + Number(tokens.expires_in ?? 86400) * 1000,
        extra: { openId: tokens.open_id },
      },
    };
  },

  async ensureFreshToken(creds) {
    if (!creds.expiresAt || creds.expiresAt - Date.now() > 5 * 60_000) return creds;
    if (!creds.refreshToken) throw new Error("TikTok token expired and no refresh_token was stored - reconnect the account.");
    const body = new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    });
    const res = await fetch(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens: any = await res.json();
    if (!res.ok || !tokens.access_token) throw new Error(`TikTok token refresh failed: ${JSON.stringify(tokens)}`);
    return {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 86400) * 1000,
    };
  },

  async publish(post_: Post, _account: Account, creds: StoredCredentials) {
    const video = post_.media.find((m) => m.kind === "video");
    if (!video) throw new Error("TikTok post has no video attached.");
    // TikTok fetches by URL from its own servers, not the browser - a local filesystem path
    // (the common case: the importer stores repo-relative paths) needs converting to this
    // server's own /media/:file address first. That address is only reachable at all because
    // its domain was verified in TikTok's app settings (see README's TikTok setup section).
    const videoUrl = publicMediaUrl(video.path);

    const privacyLevel = isAudited() ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
    const init = await post(
      "/post/publish/video/init/",
      {
        post_info: {
          title: post_.caption.slice(0, 2200),
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      },
      creds.accessToken
    );
    const publishId = init.data?.publish_id;
    if (!publishId) throw new Error(`TikTok did not return a publish_id: ${JSON.stringify(init)}`);

    // Poll for completion so a failure (e.g. domain not verified) surfaces now,
    // not silently, and so we can record TikTok's own video id once it exists.
    for (let i = 0; i < 15; i++) {
      await sleep(4000);
      const status = await post("/post/publish/status/fetch/", { publish_id: publishId }, creds.accessToken);
      const s = status.data?.status;
      if (s === "PUBLISH_COMPLETE") {
        return { platformPostId: status.data?.publicaly_available_post_id?.[0] ?? publishId };
      }
      if (s === "FAILED") throw new Error(`TikTok publish failed: ${JSON.stringify(status.data)}`);
    }
    // Still processing after ~1 minute - not an error, TikTok can take longer for
    // some videos. Return the publish_id; the dashboard shows it as "processing".
    return { platformPostId: publishId };
  },
};
