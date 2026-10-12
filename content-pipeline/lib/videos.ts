import type { TranscribedVideo, VideoInput } from "@/app/api/transcribe/route";
import { mapLimit } from "./async";
import { DOWNLOAD_CONCURRENCY, VIDEO_BUCKET, VIDEO_RETENTION_DAYS } from "./config";
import { supabaseAdmin } from "./supabase";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Referer: "https://www.tiktok.com/",
};

const DOWNLOAD_TIMEOUT_MS = 60_000;

export type DownloadOutcome = "downloaded" | "skipped" | "failed";

export interface DownloadResult {
  id: string;
  outcome: DownloadOutcome;
  detail: string;
}

// Upsert scraped videos. Download columns are left out so reruns don't reset
// them, and collected_at keeps the time we first saw the video.
export async function saveVideos(videos: VideoInput[], searchTerm: string): Promise<void> {
  const rows = videos
    .filter((v) => v.id)
    .map((v) => ({
      id: v.id,
      url: v.url,
      username: v.author?.username,
      followers: v.author?.followers,
      caption: v.caption,
      posted_at: v.posted_at,
      duration_s: v.duration_s,
      views: v.stats?.views,
      likes: v.stats?.likes,
      comments: v.stats?.comments,
      shares: v.stats?.shares,
      saves: v.stats?.saves,
      play_urls: v.play_urls ?? [],
      file_size_bytes: v.file_size_bytes,
      cover_url: v.cover_url,
      search_term: searchTerm,
    }));
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin().from("videos").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`Saving videos failed: ${error.message}`);
}

export async function saveTranscripts(videos: TranscribedVideo[]): Promise<void> {
  for (const v of videos) {
    if (!v.id) continue;
    const { error } = await supabaseAdmin()
      .from("videos")
      .update({ transcript: v.transcript, transcript_error: v.transcript_error ?? null })
      .eq("id", v.id);
    if (error) console.error(`[transcript] ${v.id} save failed: ${error.message}`);
  }
}

// MP4s have an "ftyp" box at byte offset 4, which catches HTML error pages and
// empty bodies that come back with a 200. Photo posts return an audio-only
// M4A (same container), so also require a video track handler ("vide").
function checkMp4(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp") return "not an MP4";
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes("vide")) {
    return "audio only, no video track (likely a photo post)";
  }
  return null;
}

// Try each URL in order and return the first real MP4, or the reasons each one failed.
async function fetchFirstMp4(urls: string[]): Promise<{ bytes: Uint8Array; host: string } | { errors: string[] }> {
  const errors: string[] = [];
  for (const url of urls) {
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push(`${host}: HTTP ${res.status}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const problem = checkMp4(bytes);
      if (problem) {
        errors.push(`${host}: ${problem} (${res.headers.get("content-type") ?? "no content-type"}, ${bytes.length} bytes)`);
        continue;
      }
      return { bytes, host };
    } catch (e) {
      errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { errors: errors.length ? errors : ["no play_urls"] };
}

async function downloadOne(id: string, playUrls: string[]): Promise<DownloadResult> {
  const db = supabaseAdmin();
  const fetched = await fetchFirstMp4(playUrls);

  if ("errors" in fetched) {
    const detail = fetched.errors.join("; ");
    await db.from("videos").update({ download_status: "failed", download_error: detail }).eq("id", id);
    return { id, outcome: "failed", detail };
  }

  const storagePath = `videos/${id}.mp4`;
  const { error: uploadError } = await db.storage
    .from(VIDEO_BUCKET)
    .upload(storagePath, fetched.bytes, { contentType: "video/mp4", upsert: true });
  if (uploadError) {
    const detail = `upload failed: ${uploadError.message}`;
    await db.from("videos").update({ download_status: "failed", download_error: detail }).eq("id", id);
    return { id, outcome: "failed", detail };
  }

  await db
    .from("videos")
    .update({
      download_status: "downloaded",
      download_error: null,
      storage_path: storagePath,
      downloaded_at: new Date().toISOString(),
    })
    .eq("id", id);
  const mb = (fetched.bytes.length / 1_000_000).toFixed(1);
  return { id, outcome: "downloaded", detail: `${mb} MB via ${fetched.host}` };
}

// Download each video's MP4 into storage. Already-downloaded (or expired)
// videos are skipped; a failure is recorded on the row and never stops the run.
export async function downloadVideos(ids: string[]): Promise<DownloadResult[]> {
  if (ids.length === 0) return [];
  const { data: rows, error } = await supabaseAdmin()
    .from("videos")
    .select("id, play_urls, download_status")
    .in("id", ids);
  if (error) throw new Error(`Loading videos failed: ${error.message}`);

  const results = await mapLimit(rows ?? [], DOWNLOAD_CONCURRENCY, async (row): Promise<DownloadResult> => {
    let result: DownloadResult;
    if (row.download_status === "downloaded" || row.download_status === "expired") {
      result = { id: row.id, outcome: "skipped", detail: `already ${row.download_status}` };
    } else {
      result = await downloadOne(row.id, row.play_urls ?? []);
    }
    console.log(`[download] ${result.id} ${result.outcome}: ${result.detail}`);
    return result;
  });

  const count = (o: DownloadOutcome) => results.filter((r) => r.outcome === o).length;
  console.log(`[download] done: ${count("downloaded")} downloaded, ${count("skipped")} skipped, ${count("failed")} failed`);
  return results;
}

// Delete MP4s downloaded more than VIDEO_RETENTION_DAYS ago. Rows stay, marked
// "expired" so reruns don't try to fetch them again.
export async function cleanupOldVideos(retentionDays = VIDEO_RETENTION_DAYS): Promise<{ deleted: string[] }> {
  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db
    .from("videos")
    .select("id, storage_path")
    .eq("download_status", "downloaded")
    .lt("downloaded_at", cutoff);
  if (error) throw new Error(`Loading old videos failed: ${error.message}`);
  if (!rows?.length) {
    console.log(`[cleanup] nothing older than ${retentionDays} days`);
    return { deleted: [] };
  }

  const { error: removeError } = await db.storage.from(VIDEO_BUCKET).remove(rows.map((r) => r.storage_path));
  if (removeError) throw new Error(`Deleting MP4s failed: ${removeError.message}`);

  const ids = rows.map((r) => r.id);
  await db.from("videos").update({ download_status: "expired", storage_path: null }).in("id", ids);
  console.log(`[cleanup] deleted ${ids.length} MP4s older than ${retentionDays} days`);
  return { deleted: ids };
}
