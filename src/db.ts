import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Account, MediaRef, Platform, Post, PostStatus } from "./types.js";

// Node's own built-in SQLite (stable since Node 22+, no flag needed here on v24) -
// deliberately not `better-sqlite3`: that needs native compilation (node-gyp +
// Python), which is exactly the kind of extra machinery this whole project
// exists to avoid. Zero dependencies for the database layer.
const DB_PATH = process.env.POSTBOX_DB_PATH || "postbox.db";
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    encrypted_credentials TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    caption TEXT NOT NULL,
    media_json TEXT NOT NULL DEFAULT '[]',
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    source TEXT,
    last_error TEXT,
    published_at TEXT,
    platform_post_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled ON posts(status, scheduled_for);

  -- Import de-duplication: the same source line (e.g. a specific block in a specific
  -- weekly queue file) should never create two posts if the importer runs twice.
  CREATE TABLE IF NOT EXISTS import_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- accounts

export function upsertAccount(input: {
  platform: Platform;
  handle: string;
  encryptedCredentials: string;
}): Account {
  const existing = db
    .prepare("SELECT * FROM accounts WHERE platform = ? LIMIT 1")
    .get(input.platform) as unknown as Account | undefined;
  const ts = nowIso();
  if (existing) {
    db.prepare("UPDATE accounts SET handle = ?, encrypted_credentials = ?, updated_at = ? WHERE id = ?").run(
      input.handle,
      input.encryptedCredentials,
      ts,
      existing.id
    );
    return { ...existing, handle: input.handle, encryptedCredentials: input.encryptedCredentials, updatedAt: ts };
  }
  const row: Account = {
    id: randomUUID(),
    platform: input.platform,
    handle: input.handle,
    encryptedCredentials: input.encryptedCredentials,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    "INSERT INTO accounts (id, platform, handle, encrypted_credentials, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.platform, row.handle, row.encryptedCredentials, row.createdAt, row.updatedAt);
  return row;
}

export function getAccountByPlatform(platform: Platform): Account | undefined {
  return db.prepare("SELECT * FROM accounts WHERE platform = ? LIMIT 1").get(platform) as unknown as
    | Account
    | undefined;
}

export function listAccounts(): Account[] {
  return db.prepare("SELECT * FROM accounts ORDER BY platform").all() as unknown as Account[];
}

// ---------------------------------------------------------------- posts

interface PostRow {
  id: string;
  platform: Platform;
  account_id: string;
  caption: string;
  media_json: string;
  scheduled_for: string;
  status: PostStatus;
  source: string | null;
  last_error: string | null;
  published_at: string | null;
  platform_post_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPost(r: PostRow): Post {
  return {
    id: r.id,
    platform: r.platform,
    accountId: r.account_id,
    caption: r.caption,
    media: JSON.parse(r.media_json) as MediaRef[],
    scheduledFor: r.scheduled_for,
    status: r.status,
    source: r.source ?? undefined,
    lastError: r.last_error,
    publishedAt: r.published_at,
    platformPostId: r.platform_post_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Returns the created post, or null if `fingerprint` was already imported once. */
export function createPostIfNew(
  input: {
    platform: Platform;
    accountId: string;
    caption: string;
    media: MediaRef[];
    scheduledFor: string;
    source?: string;
  },
  fingerprint: string
): Post | null {
  const dup = db
    .prepare("SELECT post_id FROM import_fingerprints WHERE fingerprint = ?")
    .get(fingerprint) as unknown as { post_id: string } | undefined;
  if (dup) return null;

  const ts = nowIso();
  const row: PostRow = {
    id: randomUUID(),
    platform: input.platform,
    account_id: input.accountId,
    caption: input.caption,
    media_json: JSON.stringify(input.media),
    scheduled_for: input.scheduledFor,
    status: "pending_review",
    source: input.source ?? null,
    last_error: null,
    published_at: null,
    platform_post_id: null,
    created_at: ts,
    updated_at: ts,
  };

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO posts (id, platform, account_id, caption, media_json, scheduled_for, status,
                           source, last_error, published_at, platform_post_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.platform,
      row.account_id,
      row.caption,
      row.media_json,
      row.scheduled_for,
      row.status,
      row.source,
      row.last_error,
      row.published_at,
      row.platform_post_id,
      row.created_at,
      row.updated_at
    );
    db.prepare("INSERT INTO import_fingerprints (fingerprint, post_id, created_at) VALUES (?, ?, ?)").run(
      fingerprint,
      row.id,
      ts
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rowToPost(row);
}

export function listPosts(filter?: { status?: PostStatus }): Post[] {
  const rows = (
    filter?.status
      ? db.prepare("SELECT * FROM posts WHERE status = ? ORDER BY scheduled_for").all(filter.status)
      : db.prepare("SELECT * FROM posts ORDER BY scheduled_for").all()
  ) as unknown as PostRow[];
  return rows.map(rowToPost);
}

export function getPost(id: string): Post | undefined {
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as unknown as PostRow | undefined;
  return row ? rowToPost(row) : undefined;
}

export function updatePost(id: string, patch: Partial<Pick<Post, "caption" | "scheduledFor">>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.caption !== undefined) {
    fields.push("caption = ?");
    values.push(patch.caption);
  }
  if (patch.scheduledFor !== undefined) {
    fields.push("scheduled_for = ?");
    values.push(patch.scheduledFor);
  }
  if (!fields.length) return;
  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE posts SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));
}

export function setPostStatus(
  id: string,
  status: PostStatus,
  extra?: { lastError?: string | null; publishedAt?: string | null; platformPostId?: string | null }
): void {
  db.prepare(
    `UPDATE posts SET status = ?, last_error = ?, published_at = COALESCE(?, published_at),
     platform_post_id = COALESCE(?, platform_post_id), updated_at = ? WHERE id = ?`
  ).run(status, extra?.lastError ?? null, extra?.publishedAt ?? null, extra?.platformPostId ?? null, nowIso(), id);
}

/** Posts approved and due right now - what the scheduler loop looks for each tick. */
export function dueScheduledPosts(): Post[] {
  const rows = db
    .prepare("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for")
    .all(nowIso()) as unknown as PostRow[];
  return rows.map(rowToPost);
}
