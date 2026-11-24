import type { PendingItem, VideoFormat, VideoInfo } from "@/types";
import { isValidUrl } from "@/utils/validate";

// Do not serialize yt-dlp's full JSON: it can carry signed stream URLs,
// extractor cookies, HTTP headers, and hundreds of nested playlist entries.
function formatSnapshot(f: VideoFormat): VideoFormat {
  const { format_id, ext, resolution, height, width, fps, vcodec, acodec, filesize,
    filesize_approx, format_note, language, language_preference, audio_channels,
    dynamic_range, tbr, vbr, abr } = f;
  return { format_id, ext, resolution, height, width, fps, vcodec, acodec, filesize,
    filesize_approx, format_note, language, language_preference, audio_channels,
    dynamic_range, tbr, vbr, abr };
}

function subtitleSnapshot(subtitles: VideoInfo["subtitles"] = {}): VideoInfo["subtitles"] {
  return Object.fromEntries(Object.entries(subtitles).map(([lang, tracks]) => [
    lang, tracks.map(({ ext, name }) => ({ ext, name, url: "" })),
  ]));
}

function publicThumbnail(value: string | undefined): string {
  try {
    const url = new URL(value || "");
    if (!["https:", "http:"].includes(url.protocol)) return "";
    url.username = url.password = url.search = url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function infoSnapshot(info: VideoInfo): VideoInfo {
  const { title, duration, uploader, view_count, upload_date, live_status, is_live } = info;
  return {
    title, duration, uploader, view_count, upload_date, live_status, is_live,
    description: info.description?.slice(0, 4096) ?? "",
    thumbnail: publicThumbnail(info.thumbnail),
    formats: [],
    subtitles: subtitleSnapshot(info.subtitles),
    automatic_captions: subtitleSnapshot(info.automatic_captions),
  };
}

export function serializeReview(state: Record<string, unknown>): string {
  const items = state.items as PendingItem[];
  return JSON.stringify({
    activeId: state.activeId,
    items: items.map((item) => ({
      ...item,
      videoInfo: infoSnapshot(item.videoInfo),
      videoFormats: item.videoFormats.map(formatSnapshot),
      audioFormats: item.audioFormats.map(formatSnapshot),
      playlistEntries: item.playlistEntries.map(({ id, title, duration, playlist_index }) => ({
        id, title, duration, playlist_index, url: "",
      })),
    })),
  });
}

export function deserializeReview(raw: string): { items: PendingItem[]; activeId: string } {
  try {
    const state = JSON.parse(raw);
    const items: PendingItem[] = Array.isArray(state?.items) ? state.items.filter((item: PendingItem) =>
      item && typeof item.id === "string" && typeof item.url === "string" && isValidUrl(item.url) &&
      item.videoInfo && Array.isArray(item.videoFormats) && Array.isArray(item.audioFormats) &&
      Array.isArray(item.playlistEntries) && Array.isArray(item.selectedPlaylistItems) &&
      typeof item.selectedVideoFormat === "string" && typeof item.selectedAudioFormat === "string" &&
      Array.isArray(item.selectedSubtitles) && typeof item.customArgs === "string" && typeof item.ffmpegArgs === "string",
    ) : [];
    return { items, activeId: items.some((item) => item.id === state?.activeId) ? state.activeId : items[0]?.id ?? "" };
  } catch {
    return { items: [], activeId: "" };
  }
}
