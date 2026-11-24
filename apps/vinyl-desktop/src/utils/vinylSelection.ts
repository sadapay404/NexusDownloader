import type { VideoFormat } from "@/types";
import { getCodecKey } from "@/utils/formats";

export const primaryTiers = [480, 720, 1080] as const;
export const extendedTiers = [144, 240, 360, 1440, 2160] as const;

const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const videoIdPattern = /^[\w-]{11}$/;

/** Auto-inspect only a single, exact YouTube watch, Shorts, or share URL. */
export function clipboardVideo(value: string): { url: string; id: string } | null {
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\\]/u.test(input)) return null;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
      return null;
    }
    let ids: string[] = [];
    if (url.hostname === "youtu.be") {
      ids = url.pathname.match(/^\/([\w-]+)\/?$/)?.slice(1) || [];
    } else if (youtubeHosts.has(url.hostname)) {
      if (url.pathname === "/watch") ids = url.searchParams.getAll("v");
      else ids = url.pathname.match(/^\/shorts\/([\w-]+)\/?$/)?.slice(1) || [];
    }
    if (ids.length !== 1 || !videoIdPattern.test(ids[0])) return null;
    // Keep the original URL. Upstream owns metadata parsing and playlist handling.
    return { url: input, id: ids[0] };
  } catch {
    return null;
  }
}

export function nativeTier(format: VideoFormat | undefined): number | null {
  if (!format?.height || !format.vcodec || format.vcodec === "none") return null;
  return Math.min(format.width || format.height, format.height);
}

export function tierLabel(tier: number): string {
  if (tier === 1440) return "2K";
  if (tier === 2160) return "4K";
  return `${tier}p`;
}

/** Choose an existing format ID; keep the extractor's order within a codec. */
export function formatForTier(
  formats: readonly VideoFormat[],
  tier: number,
  selected: string,
  preferredCodec: string,
): VideoFormat | undefined {
  const matching = formats.filter((format) => nativeTier(format) === tier);
  return (
    matching.find((format) => format.format_id === selected) ??
    matching.find((format) => getCodecKey(format.vcodec) === preferredCodec) ??
    matching[0]
  );
}

// An inspection arms only the newly added pending tab, not previously parsed items.
let nextPendingId = "";
export function armVinylSelection(id: string) {
  nextPendingId = id;
}
export function consumeVinylSelection(id: string): boolean {
  const matches = id === nextPendingId && id !== "";
  nextPendingId = "";
  return matches;
}
let lastClipboardId = "";
export function markClipboardVideo(id: string): boolean {
  if (lastClipboardId === id) return false;
  lastClipboardId = id;
  return true;
}
