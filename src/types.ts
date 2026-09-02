export type Platform = "youtube" | "instagram" | "tiktok";

export type PostStatus =
  | "pending_review" // imported, waiting for a human to approve
  | "scheduled" // approved, waiting for scheduled_for to arrive
  | "publishing" // the scheduler has claimed it and is calling the platform now
  | "published" // live
  | "failed" // publish attempt errored - see last_error
  | "rejected"; // a human declined it; left in the DB for the record, never published

export interface MediaRef {
  /** Local file path OR an already-public URL. If local, TrustSocial serves it at /media/:id. */
  path: string;
  kind: "video" | "image";
}

export interface Post {
  id: string;
  platform: Platform;
  accountId: string;
  caption: string;
  media: MediaRef[];
  /** ISO 8601. When the scheduler is allowed to publish this. */
  scheduledFor: string;
  status: PostStatus;
  /** Free-form: which content pillar / campaign / source file this came from. */
  source?: string;
  lastError?: string | null;
  publishedAt?: string | null;
  /** The platform's own id/url for the published post, once known. */
  platformPostId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  platform: Platform;
  /** Human-readable handle, for display only. */
  handle: string;
  /** Encrypted at rest - see crypto.ts. Shape is platform-specific (access/refresh token, expiry, ids). */
  encryptedCredentials: string;
  createdAt: string;
  updatedAt: string;
}
