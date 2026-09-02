import type { Account, Post } from "../types.js";

/** Every platform stores whatever shape it needs here, encrypted at rest (crypto.ts). */
export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. */
  expiresAt?: number;
  /** Platform-specific extra ids the publish call needs (e.g. Instagram's ig_user_id). */
  extra?: Record<string, string>;
}

export interface PlatformAdapter {
  readonly platform: "youtube" | "instagram" | "tiktok";

  /** True once this .env has the client id/secret this adapter needs to do anything. */
  isConfigured(): boolean;

  /** Where to send the browser to start the one-time "Connect account" flow. */
  buildAuthUrl(state: string): string;

  /** Exchange the OAuth callback's ?code=... for tokens, and return what to store. */
  handleCallback(query: Record<string, string>): Promise<{ handle: string; credentials: StoredCredentials }>;

  /** Refresh an expiring access token. Returns the same object if nothing needed refreshing. */
  ensureFreshToken(creds: StoredCredentials): Promise<StoredCredentials>;

  /**
   * Publish one post. Must throw with a clear message on failure - the scheduler
   * records whatever it throws verbatim into posts.last_error. Must return the
   * platform's own id/url for the new post on success.
   */
  publish(post: Post, account: Account, creds: StoredCredentials): Promise<{ platformPostId: string }>;
}
