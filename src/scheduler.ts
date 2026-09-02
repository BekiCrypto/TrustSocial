import { db, dueScheduledPosts, setPostStatus } from "./db.js";
import { adapterFor } from "./platforms/index.js";
import { decryptJson } from "./crypto.js";
import type { StoredCredentials } from "./platforms/types.js";
import type { Account } from "./types.js";

const TICK_MS = 60_000; // check once a minute - posting is never THAT time-sensitive

async function publishOne(postId: string) {
  // Re-fetch fresh inside the tick, in case a human edited/rejected it between ticks.
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as any;
  if (!post || post.status !== "scheduled") return;

  setPostStatus(postId, "publishing");
  try {
    const accountRow = db.prepare("SELECT * FROM accounts WHERE id = ?").get(post.account_id) as any;
    if (!accountRow) throw new Error("No account row for this post's account_id - was it deleted?");
    const account: Account = {
      id: accountRow.id,
      platform: accountRow.platform,
      handle: accountRow.handle,
      encryptedCredentials: accountRow.encrypted_credentials,
      createdAt: accountRow.created_at,
      updatedAt: accountRow.updated_at,
    };

    const adapter = adapterFor(account.platform);
    let creds = decryptJson<StoredCredentials>(account.encryptedCredentials);
    creds = await adapter.ensureFreshToken(creds);

    const fullPost = {
      id: post.id,
      platform: post.platform,
      accountId: post.account_id,
      caption: post.caption,
      media: JSON.parse(post.media_json),
      scheduledFor: post.scheduled_for,
      status: post.status,
      source: post.source,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
    };

    const { platformPostId } = await adapter.publish(fullPost, account, creds);
    setPostStatus(postId, "published", { publishedAt: new Date().toISOString(), platformPostId });
    console.log(`[scheduler] published ${post.platform} post ${postId} -> ${platformPostId}`);
  } catch (err: any) {
    setPostStatus(postId, "failed", { lastError: String(err?.message ?? err) });
    console.error(`[scheduler] FAILED ${post.platform} post ${postId}:`, err?.message ?? err);
  }
}

export function startScheduler() {
  const tick = async () => {
    const due = dueScheduledPosts();
    for (const p of due) {
      await publishOne(p.id); // sequential on purpose - no reason to hammer platform APIs concurrently for a single brand
    }
  };
  tick(); // run once immediately on boot, then on the interval
  const handle = setInterval(tick, TICK_MS);
  return () => clearInterval(handle);
}
