import { type NextRequest } from "next/server";
import { toVideoInput, type VideoItem } from "@/lib/tiktok";
import { downloadVideos, saveVideos, type DownloadResult } from "@/lib/videos";
import type { VideoInput } from "../transcribe/route";

// Downloads run right after the scrape (TikTok links expire within ~a day), so allow time for them.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get("query");
  const region = searchParams.get("region") ?? "AU";

  if (!query) {
    return Response.json({ error: "Missing query parameter" }, { status: 400 });
  }

  const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "SCRAPE_CREATORS_API_KEY not set" }, { status: 500 });
  }

  const url = new URL("https://api.scrapecreators.com/v1/tiktok/search/top");
  url.searchParams.set("query", query);
  url.searchParams.set("publish_time", "this-week");
  url.searchParams.set("sort_by", "most-liked");
  url.searchParams.set("region", region);

  const response = await fetch(url.toString(), {
    headers: {
      "x-api-key": apiKey,
    },
  });

  const data = await response.json();

  // Save the videos and download their MP4s. A storage problem shouldn't hide the search results.
  let downloads: DownloadResult[] = [];
  let downloadError: string | undefined;
  const items: VideoItem[] = Array.isArray(data?.items) ? data.items : [];
  if (response.ok && items.length > 0) {
    try {
      const videos = items.map(toVideoInput).filter((v): v is VideoInput => !!v?.id);
      await saveVideos(videos, query);
      downloads = await downloadVideos(videos.map((v) => v.id!));
    } catch (e) {
      downloadError = e instanceof Error ? e.message : String(e);
      console.error(`[search] ${query}: ${downloadError}`);
    }
  }

  return Response.json({
    status: response.status,
    query,
    region,
    data,
    downloads,
    download_error: downloadError,
  });
}
