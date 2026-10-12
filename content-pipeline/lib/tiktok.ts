import type { VideoInput } from "@/app/api/transcribe/route";

interface ImageAddr {
  url_list?: string[];
}

// Shape of one entry in ScrapeCreators' `items` array (only the fields we use).
export interface VideoItem {
  id?: string;
  desc?: string;
  url?: string;
  create_time?: string;
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
    collect_count?: number;
  };
  author?: { unique_id?: string; nickname?: string; follower_count?: number };
  video?: {
    duration?: number; // milliseconds
    cla_info?: { caption_infos?: unknown[] | null };
    play_addr?: { url_list?: string[]; data_size?: number };
    cover?: ImageAddr;
    origin_cover?: ImageAddr;
  };
  [key: string]: unknown;
}

// Order play URLs for download: the /aweme/v1/play/ link (on a *.tiktokv.com
// host, which varies) redirects to a fresh file, so try it first. The
// tiktokcdn.com links are signed direct links and come after as fallbacks.
export function orderPlayUrls(urls: string[]): string[] {
  const isPlayRedirect = (u: string) => u.includes("/aweme/v1/play/");
  return [...urls.filter(isPlayRedirect), ...urls.filter((u) => !isPlayRedirect(u))];
}

// Flatten a search item into the metadata we keep alongside its transcript.
export function toVideoInput(v: VideoItem): VideoInput | null {
  if (!v.url) return null;
  const created = Number(v.create_time);
  const durationMs = v.video?.duration;
  const cover = v.video?.cover?.url_list?.[0] ?? v.video?.origin_cover?.url_list?.[0];
  return {
    id: v.id,
    url: v.url,
    author: { username: v.author?.unique_id, nickname: v.author?.nickname, followers: v.author?.follower_count },
    caption: v.desc,
    posted_at: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : v.create_time,
    duration_s: typeof durationMs === "number" ? Math.round(durationMs / 100) / 10 : undefined,
    stats: {
      views: v.statistics?.play_count,
      likes: v.statistics?.digg_count,
      comments: v.statistics?.comment_count,
      shares: v.statistics?.share_count,
      saves: v.statistics?.collect_count,
    },
    play_urls: orderPlayUrls(v.video?.play_addr?.url_list ?? []),
    file_size_bytes: v.video?.play_addr?.data_size,
    cover_url: cover,
  };
}
