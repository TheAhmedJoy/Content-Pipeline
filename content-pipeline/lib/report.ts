import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPartFromUri, FileState, GoogleGenAI, MediaResolution, type File as GeminiFile, type Part } from "@google/genai";
import { mapLimit } from "./async";
import { saveLocalCopy } from "./local-files";
import {
  GEMINI_MEDIA_RESOLUTION,
  GEMINI_MODEL,
  GEMINI_UPLOAD_CONCURRENCY,
  REPORT_PROMPT_PATH,
  REPORT_WINDOW_DAYS,
  VIDEO_BUCKET,
} from "./config";
import { supabaseAdmin } from "./supabase";

const FILE_POLL_MS = 3_000;
const FILE_PROCESSING_TIMEOUT_MS = 5 * 60_000;

const MEDIA_RESOLUTIONS: Record<string, MediaResolution> = {
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  high: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

interface VideoRow {
  id: string;
  url: string;
  username: string | null;
  followers: number | null;
  caption: string | null;
  posted_at: string | null;
  duration_s: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  transcript: string | null;
  transcript_error: string | null;
  search_term: string | null;
  storage_path: string;
}

export interface ReportResult {
  id: string;
  created_at: string;
  file: string | null; // local markdown copy; null when deployed
  model: string;
  search_terms: string[];
  video_ids: string[];
  skipped: { id: string; reason: string }[];
  usage: { prompt_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number };
  report_md: string;
}

function gemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  // The SDK only retries when retryOptions is set. Retries 408/429/5xx (e.g. 503
  // "high demand") with exponential backoff: roughly 5s, 10s, 20s, 40s.
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 5, initialDelay: 5, maxDelay: 60 } } });
}

// The per-video JSON in the shape the prompt describes.
function toPromptJson(v: VideoRow) {
  return {
    id: v.id,
    url: v.url,
    username: v.username,
    followers: v.followers,
    caption: v.caption,
    posted_at: v.posted_at,
    duration_s: v.duration_s,
    stats: { views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves },
    transcript: v.transcript,
    // Videos never run through "Transcribe all" have neither field set; say so rather than imply none exists.
    transcript_error: v.transcript || v.transcript_error ? v.transcript_error : "not transcribed (transcription was not run for this video)",
  };
}

// Copy one MP4 from Supabase storage to the Gemini Files API and wait until it's ready to use.
async function uploadToGemini(ai: GoogleGenAI, v: VideoRow): Promise<GeminiFile> {
  const { data: blob, error } = await supabaseAdmin().storage.from(VIDEO_BUCKET).download(v.storage_path);
  if (error || !blob) throw new Error(`storage download failed: ${error?.message ?? "empty"}`);

  let file = await ai.files.upload({ file: blob, config: { mimeType: "video/mp4", displayName: v.id } });
  const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Gemini to process the file");
    await new Promise((r) => setTimeout(r, FILE_POLL_MS));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`Gemini file processing ${file.state}: ${file.error?.message ?? "no details"}`);
  }
  return file;
}

// Send every downloaded video from the past REPORT_WINDOW_DAYS to Gemini in one
// request with the weekly report prompt, then save the report.
export async function generateWeeklyReport(): Promise<ReportResult> {
  const db = supabaseAdmin();
  const ai = gemini();
  const mediaResolution = MEDIA_RESOLUTIONS[GEMINI_MEDIA_RESOLUTION];
  if (!mediaResolution) throw new Error(`Unknown GEMINI_MEDIA_RESOLUTION "${GEMINI_MEDIA_RESOLUTION}" (use low, medium or high)`);

  // Bundled via outputFileTracingIncludes in next.config.ts, so tracing is skipped here.
  const prompt = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), REPORT_PROMPT_PATH), "utf8");

  const since = new Date(Date.now() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("videos")
    .select(
      "id, url, username, followers, caption, posted_at, duration_s, views, likes, comments, shares, saves, transcript, transcript_error, search_term, storage_path",
    )
    .eq("download_status", "downloaded")
    .gte("collected_at", since)
    .order("views", { ascending: false });
  if (error) throw new Error(`Loading videos failed: ${error.message}`);
  const videos = (data ?? []) as VideoRow[];
  if (videos.length === 0) throw new Error(`No downloaded videos from the past ${REPORT_WINDOW_DAYS} days`);
  console.log(`[report] ${videos.length} downloaded videos from the past ${REPORT_WINDOW_DAYS} days`);

  const uploaded: GeminiFile[] = [];
  try {
    // Upload all files. A failed upload drops that video's file but keeps its JSON entry,
    // which the prompt tells Gemini how to handle.
    const skipped: { id: string; reason: string }[] = [];
    const files = await mapLimit(videos, GEMINI_UPLOAD_CONCURRENCY, async (v) => {
      try {
        const file = await uploadToGemini(ai, v);
        uploaded.push(file);
        console.log(`[report] ${v.id} uploaded to Gemini (${file.name})`);
        return file;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        skipped.push({ id: v.id, reason });
        console.error(`[report] ${v.id} upload failed: ${reason}`);
        return null;
      }
    });

    // Each video file is preceded by a text label with its ID, then the JSON, then the prompt.
    const parts: Part[] = [];
    videos.forEach((v, i) => {
      const file = files[i];
      if (!file) return;
      parts.push({ text: `Video id: ${v.id}` }, createPartFromUri(file.uri!, file.mimeType ?? "video/mp4"));
    });
    const json = JSON.stringify(videos.map(toPromptJson), null, 2);
    parts.push({ text: `Video data JSON:\n\n${json}` }, { text: prompt });

    const attachedIds = videos.filter((_, i) => files[i]).map((v) => v.id);
    console.log(`[report] sending ${attachedIds.length} video files + JSON for ${videos.length} videos to ${GEMINI_MODEL} (${GEMINI_MEDIA_RESOLUTION} resolution)`);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts }],
      config: { mediaResolution },
    });
    const reportMd = response.text ?? "";
    if (!reportMd.trim()) throw new Error(`Gemini returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"})`);

    const u = response.usageMetadata;
    const usage = {
      prompt_tokens: u?.promptTokenCount,
      output_tokens: u?.candidatesTokenCount,
      thinking_tokens: u?.thoughtsTokenCount,
      total_tokens: u?.totalTokenCount,
    };
    console.log(`[report] done: ${JSON.stringify(usage)}`);

    const searchTerms = [...new Set(videos.map((v) => v.search_term).filter((t): t is string => !!t))];
    const now = new Date();
    const file = `reports/${now.toISOString().replace(/[:.]/g, "-")}_weekly-report.md`;
    const header = [
      `<!-- generated ${now.toISOString()} by ${GEMINI_MODEL} (${GEMINI_MEDIA_RESOLUTION} media resolution) -->`,
      `<!-- search terms: ${searchTerms.join(", ")} | ${attachedIds.length} of ${videos.length} video files attached | tokens: ${usage.total_tokens ?? "?"} -->`,
      "",
    ].join("\n");
    // Local copy only; the reports table is the source of truth.
    const savedFile = await saveLocalCopy(file, header + reportMd);

    const { data: row, error: insertError } = await db
      .from("reports")
      .insert({
        search_terms: searchTerms,
        video_ids: attachedIds,
        model: GEMINI_MODEL,
        media_resolution: GEMINI_MEDIA_RESOLUTION,
        report_md: reportMd,
        report_file: savedFile,
        ...usage,
        response: JSON.parse(JSON.stringify(response)),
      })
      .select("id, created_at")
      .single();
    if (insertError) {
      const where = savedFile ? ` (markdown is still at ${savedFile})` : "";
      throw new Error(`Saving report failed${where}: ${insertError.message}`);
    }

    return { id: row.id, created_at: row.created_at, file: savedFile, model: GEMINI_MODEL, search_terms: searchTerms, video_ids: attachedIds, skipped, usage, report_md: reportMd };
  } finally {
    // Clean up Gemini-side copies whether or not the request succeeded.
    await Promise.all(
      uploaded.map((f) =>
        ai.files.delete({ name: f.name! }).catch((e) => console.error(`[report] failed to delete ${f.name}: ${e}`)),
      ),
    );
    if (uploaded.length) console.log(`[report] deleted ${uploaded.length} files from Gemini`);
  }
}

// The most recent saved report, so it can be viewed and downloaded without a new run.
export async function getLatestReport(): Promise<ReportResult | null> {
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .select("id, created_at, report_file, model, search_terms, video_ids, report_md, prompt_tokens, output_tokens, thinking_tokens, total_tokens")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Loading latest report failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    created_at: data.created_at,
    file: data.report_file,
    model: data.model,
    search_terms: data.search_terms,
    video_ids: data.video_ids,
    skipped: [],
    usage: {
      prompt_tokens: data.prompt_tokens,
      output_tokens: data.output_tokens,
      thinking_tokens: data.thinking_tokens,
      total_tokens: data.total_tokens,
    },
    report_md: data.report_md,
  };
}
