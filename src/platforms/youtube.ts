import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { Account, Post } from "../types.js";
import type { PlatformAdapter, StoredCredentials } from "./types.js";

/**
 * YouTube Data API v3. Setup: console.cloud.google.com -> new project -> enable
 * "YouTube Data API v3" -> OAuth consent screen (External, can stay in "Testing"
 * status for a single self-owned channel - no Google review needed for that) ->
 * Credentials -> OAuth client ID (type: Web application) -> add
 * {PUBLIC_URL}/auth/youtube/callback as an authorized redirect URI.
 *
 * "Testing" publish status is enough for us: Google only requires the longer
 * verification process once you want arbitrary third-party users to consent,
 * which doesn't apply here - we're authorizing our own channel.
 */
function oauthClient() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    `${process.env.PUBLIC_URL}/auth/youtube/callback`
  );
}

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

async function mediaStream(path: string) {
  if (/^https?:\/\//.test(path)) {
    const res = await fetch(path);
    if (!res.ok || !res.body) throw new Error(`Could not fetch media at ${path}: HTTP ${res.status}`);
    // node's fetch Response.body is a web ReadableStream; googleapis wants a node stream.
    const { Readable } = await import("node:stream");
    return Readable.fromWeb(res.body as any);
  }
  return createReadStream(path);
}

export const youtubeAdapter: PlatformAdapter = {
  platform: "youtube",

  isConfigured() {
    return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
  },

  buildAuthUrl(state) {
    return oauthClient().generateAuthUrl({
      access_type: "offline", // required to get a refresh_token back
      prompt: "consent", // force refresh_token on every connect, not just the first
      scope: SCOPES,
      state,
    });
  },

  async handleCallback(query) {
    const client = oauthClient();
    const { tokens } = await client.getToken(query.code);
    client.setCredentials(tokens);
    const youtube = google.youtube({ version: "v3", auth: client });
    const me = await youtube.channels.list({ part: ["snippet"], mine: true });
    const channel = me.data.items?.[0];
    return {
      handle: channel?.snippet?.title ?? "(unknown channel)",
      credentials: {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token ?? undefined,
        expiresAt: tokens.expiry_date ?? undefined,
        extra: { channelId: channel?.id ?? "" },
      },
    };
  },

  async ensureFreshToken(creds) {
    if (!creds.expiresAt || creds.expiresAt - Date.now() > 60_000) return creds;
    if (!creds.refreshToken) throw new Error("YouTube token expired and no refresh_token was stored - reconnect the account.");
    const client = oauthClient();
    client.setCredentials({ refresh_token: creds.refreshToken });
    const { credentials } = await client.refreshAccessToken();
    return {
      ...creds,
      accessToken: credentials.access_token!,
      expiresAt: credentials.expiry_date ?? undefined,
    };
  },

  async publish(post: Post, _account: Account, creds: StoredCredentials) {
    const video = post.media.find((m) => m.kind === "video");
    if (!video) throw new Error("YouTube post has no video attached.");
    const client = oauthClient();
    client.setCredentials({ access_token: creds.accessToken, refresh_token: creds.refreshToken });
    const youtube = google.youtube({ version: "v3", auth: client });

    // First line of the caption becomes the title (YouTube has no separate title
    // field in our post model - keep captions short-first-line for Shorts).
    const [title, ...rest] = post.caption.split("\n");
    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title.slice(0, 100),
          description: post.caption,
          tags: ["shorts"],
        },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      },
      media: { body: await mediaStream(video.path) },
    });
    const id = res.data.id;
    if (!id) throw new Error("YouTube upload succeeded but returned no video id.");
    return { platformPostId: `https://youtube.com/shorts/${id}` };
  },
};
