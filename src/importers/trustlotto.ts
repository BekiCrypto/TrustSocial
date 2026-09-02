import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPostIfNew, getAccountByPlatform } from "../db.js";
import type { MediaRef, Platform } from "../types.js";

/**
 * Imports the weekly post queue TrustLotto's marketing "Loop B" writes to
 * marketing/social/queue/*.md in its own repo. This is the ONE piece of
 * TrustSocial that's TrustLotto-specific - everything else (db, adapters, web UI,
 * scheduler) is generic. A different project would swap this file for its own
 * importer and reuse the rest as-is.
 *
 * Expected block format inside a queue .md file (see marketing/desks.md's Loop B
 * spec for the authoring side):
 *
 *   ### POST
 *   platform: tiktok | instagram | youtube
 *   scheduled_for: 2026-09-04T15:00:00Z
 *   media: marketing/social/video/out/some-video.mp4
 *   source: free text, for traceability only
 *   ---
 *   the caption/body text goes here, can span
 *   multiple lines, emoji and hashtags are fine
 *   ---
 *
 * Text-only channels (X, Telegram, Discord) aren't in scope for TrustSocial v0.1 -
 * it's video-first, matching the three platforms it can actually publish to.
 * Blocks for other platforms are skipped, not errored, so one file can mix
 * platforms freely.
 */

const BLOCK_RE = /###\s*POST\s*\n([\s\S]*?)\n---\n([\s\S]*?)\n---/g;

interface ParsedBlock {
  platform: string;
  scheduledFor: string;
  mediaPath?: string;
  source?: string;
  caption: string;
}

function parseFrontMatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function parseFile(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  for (const match of text.matchAll(BLOCK_RE)) {
    const fm = parseFrontMatter(match[1]);
    if (!fm.platform || !fm.scheduled_for) continue; // malformed block, skip rather than crash the whole import
    blocks.push({
      platform: fm.platform,
      scheduledFor: fm.scheduled_for,
      mediaPath: fm.media,
      source: fm.source,
      caption: match[2].trim(),
    });
  }
  return blocks;
}

const VIDEO_PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

export interface ImportResult {
  scanned: number;
  imported: number;
  skippedNotVideoplatform: number;
  skippedNoAccount: number;
  skippedDuplicate: number;
  files: string[];
}

export function importTrustLottoQueue(opts: {
  /** Path to marketing/social/queue/ inside the TrustLotto repo checkout. */
  queueDir: string;
  /** TrustLotto repo root, so relative `media:` paths resolve correctly. */
  repoRoot: string;
}): ImportResult {
  const result: ImportResult = {
    scanned: 0,
    imported: 0,
    skippedNotVideoplatform: 0,
    skippedNoAccount: 0,
    skippedDuplicate: 0,
    files: [],
  };
  if (!existsSync(opts.queueDir)) return result;

  const files = readdirSync(opts.queueDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    result.files.push(file);
    const text = readFileSync(resolve(opts.queueDir, file), "utf8");
    const blocks = parseFile(text);
    for (const [i, block] of blocks.entries()) {
      result.scanned++;
      const platform = block.platform as Platform;
      if (!VIDEO_PLATFORMS.includes(platform)) {
        result.skippedNotVideoplatform++;
        continue;
      }
      const account = getAccountByPlatform(platform);
      if (!account) {
        result.skippedNoAccount++;
        continue;
      }
      const media: MediaRef[] = block.mediaPath
        ? [{ path: resolve(opts.repoRoot, block.mediaPath), kind: "video" }]
        : [];

      const fingerprint = createHash("sha1").update(`${file}::${i}::${block.caption}`).digest("hex");
      const created = createPostIfNew(
        {
          platform,
          accountId: account.id,
          caption: block.caption,
          media,
          scheduledFor: block.scheduledFor,
          source: block.source ?? `${file}#${i}`,
        },
        fingerprint
      );
      if (created) result.imported++;
      else result.skippedDuplicate++;
    }
  }
  return result;
}
