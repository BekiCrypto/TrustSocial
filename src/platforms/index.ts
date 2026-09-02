import type { Platform } from "../types.js";
import type { PlatformAdapter } from "./types.js";
import { youtubeAdapter } from "./youtube.js";
import { instagramAdapter } from "./instagram.js";
import { tiktokAdapter } from "./tiktok.js";

export const adapters: Record<Platform, PlatformAdapter> = {
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
};

export function adapterFor(platform: Platform): PlatformAdapter {
  const a = adapters[platform];
  if (!a) throw new Error(`No adapter registered for platform "${platform}".`);
  return a;
}
