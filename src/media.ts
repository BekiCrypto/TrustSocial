import { basename } from "node:path";

/**
 * A stored MediaRef.path is either already a public URL, or a local filesystem path
 * (see types.ts's MediaRef comment) - the latter needs converting to the address this
 * server actually serves it at (GET /media/:file, see web/dashboard.ts) before handing
 * it to anything outside this process. Platforms that fetch media by URL (TikTok,
 * Instagram) need this to be a full absolute URL, not just a path, since their own
 * servers - not the requester's browser - are the ones resolving it.
 */
export function publicMediaUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return `${base}/media/${encodeURIComponent(basename(path))}`;
}
