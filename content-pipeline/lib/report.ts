import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ApiError,
  createPartFromUri,
  FileState,
  GoogleGenAI,
  MediaResolution,
  type File as GeminiFile,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { mapLimit } from "./async";
import { saveLocalCopy } from "./local-files";
import {
  GEMINI_MEDIA_RESOLUTION,
  GEMINI_MODEL,
  GEMINI_UPLOAD_CONCURRENCY,
  REPORT_GENERATE_BUDGET_MS,
  REPORT_PROMPT_PATH,
  REPORT_WINDOW_DAYS,
  VIDEO_BUCKET,
} from "./config";
import { supabaseAdmin } from "./supabase";

const FILE_POLL_MS = 3_000;
// Kept well under the function time limit; a video still processing after this is skipped.
const FILE_PROCESSING_TIMEOUT_MS = 2 * 60_000;

// Waits between generate attempts inside one request while Gemini is overloaded.
const GENERATE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000];
// Don't start another attempt with less than this left of the time budget.
const MIN_ATTEMPT_MS = 30_000;

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

interface SkippedVideo {
  id: string;
  reason: string;
}

// A video uploaded to the Gemini Files API, saved on the run so generate can reuse it.
interface GeminiFileRef {
  video_id: string;
  name: string;
  uri: string;
  mime_type: string;
}

// The columns of a `ready` run that generate needs.
interface ReportRun {
  id: string;
  status: string;
  model: string;
  media_resolution: string;
  search_terms: string[];
  video_ids: string[];
  gemini_files: GeminiFileRef[] | null;
  videos_json: unknown[] | null;
  prompt: string;
  skipped: SkippedVideo[] | null;
  attempts: number;
}

export interface PrepareResult {
  id: string;
  video_count: number;
  attached: number;
  skipped: SkippedVideo[];
}

export type GenerateResult =
  | { status: "done"; report: ReportResult }
  // Gemini stayed overloaded for this request's time budget; call generate again.
  | { status: "busy"; attempts: number; error: string };

export interface ReportResult {
  id: string;
  created_at: string;
  file: string | null; // local markdown copy; null when deployed
  model: string;
  search_terms: string[];
  video_ids: string[];
  skipped: SkippedVideo[];
  usage: { prompt_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number };
  report_md: string;
}

// Uploads use the SDK's own retries. The generate call retries itself instead (see
// generateReport) so it can stop before the function time limit.
function gemini({ retry }: { retry: boolean }): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  // The SDK only retries when retryOptions is set. Retries 408/429/5xx (e.g. 503
  // "high demand") with exponential backoff: roughly 5s, 10s, 20s, 40s.
  return new GoogleGenAI({
    apiKey,
    httpOptions: retry ? { retryOptions: { attempts: 5, initialDelay: 5, maxDelay: 60 } } : undefined,
  });
}

function mediaResolutionFor(name: string): MediaResolution {
  const resolution = MEDIA_RESOLUTIONS[name];
  if (!resolution) throw new Error(`Unknown GEMINI_MEDIA_RESOLUTION "${name}" (use low, medium or high)`);
  return resolution;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

async function deleteGeminiFiles(ai: GoogleGenAI, names: string[]): Promise<void> {
  await Promise.all(
    names.map((name) => ai.files.delete({ name }).catch((e) => console.error(`[report] failed to delete ${name}: ${e}`))),
  );
  if (names.length) console.log(`[report] deleted ${names.length} files from Gemini`);
}

// Step 1 of a report run: upload every downloaded video from the past REPORT_WINDOW_DAYS
// to Gemini and save a `ready` reports row holding the file references, the video JSON
// and the prompt. Takes about 40 s for 16 videos. Gemini keeps the files for 48 hours.
export async function prepareReport(): Promise<PrepareResult> {
  const db = supabaseAdmin();
  const ai = gemini({ retry: true });
  mediaResolutionFor(GEMINI_MEDIA_RESOLUTION); // fail before uploading if misconfigured

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

  // A failed upload drops that video's file but keeps its JSON entry,
  // which the prompt tells Gemini how to handle.
  const skipped: SkippedVideo[] = [];
  const files = await mapLimit(videos, GEMINI_UPLOAD_CONCURRENCY, async (v) => {
    try {
      const file = await uploadToGemini(ai, v);
      console.log(`[report] ${v.id} uploaded to Gemini (${file.name})`);
      return file;
    } catch (e) {
      skipped.push({ id: v.id, reason: errorMessage(e) });
      console.error(`[report] ${v.id} upload failed: ${errorMessage(e)}`);
      return null;
    }
  });

  const geminiFiles: GeminiFileRef[] = [];
  videos.forEach((v, i) => {
    const f = files[i];
    if (f) geminiFiles.push({ video_id: v.id, name: f.name!, uri: f.uri!, mime_type: f.mimeType ?? "video/mp4" });
  });
  if (geminiFiles.length === 0) throw new Error(`None of the ${videos.length} videos could be uploaded to Gemini`);

  const searchTerms = [...new Set(videos.map((v) => v.search_term).filter((t): t is string => !!t))];
  const { data: row, error: insertError } = await db
    .from("reports")
    .insert({
      status: "ready",
      search_terms: searchTerms,
      video_ids: geminiFiles.map((f) => f.video_id),
      model: GEMINI_MODEL,
      media_resolution: GEMINI_MEDIA_RESOLUTION,
      gemini_files: geminiFiles,
      videos_json: videos.map(toPromptJson),
      prompt,
      skipped,
    })
    .select("id")
    .single();
  if (insertError) {
    await deleteGeminiFiles(ai, geminiFiles.map((f) => f.name));
    throw new Error(`Saving report run failed: ${insertError.message}`);
  }

  console.log(`[report] run ${row.id} ready: ${geminiFiles.length} of ${videos.length} files uploaded`);
  return { id: row.id, video_count: videos.length, attached: geminiFiles.length, skipped };
}

// Overloaded, rate limited or timed out: worth another try later.
function isRetryable(e: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (e instanceof ApiError) return e.status === 408 || e.status === 429 || e.status >= 500;
  return false;
}

// Step 2 of a report run: send the uploaded files, video JSON and prompt to Gemini in one
// request and save the report. Retries overload errors itself, but stops within
// REPORT_GENERATE_BUDGET_MS and returns `busy` so the caller can call again; the files
// stay uploaded in between. Gemini files are deleted once the run is done or failed.
export async function generateReport(id: string): Promise<GenerateResult> {
  const db = supabaseAdmin();
  const ai = gemini({ retry: false });

  const { data, error } = await db
    .from("reports")
    .select("id, status, model, media_resolution, search_terms, video_ids, gemini_files, videos_json, prompt, skipped, attempts")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Loading report run failed: ${error.message}`);
  if (!data) throw new Error(`Report run ${id} not found`);
  const run = data as ReportRun;
  if (run.status === "done") {
    const report = await getReport(id);
    if (report) return { status: "done", report };
  }
  if (run.status !== "ready") throw new Error(`Report run ${id} has status "${run.status}"; start a new run`);

  const geminiFiles = run.gemini_files ?? [];
  const videos = run.videos_json ?? [];
  const mediaResolution = mediaResolutionFor(run.media_resolution);

  // Each video file is preceded by a text label with its ID, then the JSON, then the prompt.
  const parts: Part[] = [];
  for (const f of geminiFiles) parts.push({ text: `Video id: ${f.video_id}` }, createPartFromUri(f.uri, f.mime_type));
  parts.push({ text: `Video data JSON:\n\n${JSON.stringify(videos, null, 2)}` }, { text: run.prompt });

  const deadline = Date.now() + REPORT_GENERATE_BUDGET_MS;
  let attempts = run.attempts;
  let lastError = "";
  for (let i = 0; ; i++) {
    attempts++;
    const remaining = deadline - Date.now();
    // Abort a call that would run past the budget, so the function always gets to respond.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    console.log(
      `[report] run ${id} attempt ${attempts}: sending ${geminiFiles.length} video files + JSON for ${videos.length} videos to ${run.model} (${run.media_resolution} resolution)`,
    );
    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: run.model,
        contents: [{ role: "user", parts }],
        config: { mediaResolution, abortSignal: controller.signal },
      });
    } catch (e) {
      const aborted = controller.signal.aborted;
      lastError = aborted ? `no response within ${Math.round(remaining / 1000)} s` : errorMessage(e);
      console.error(`[report] run ${id} attempt ${attempts} failed: ${lastError}`);

      if (!isRetryable(e, aborted)) {
        await failRun(ai, id, attempts, lastError, geminiFiles);
        throw new Error(`Report generation failed: ${lastError}`);
      }

      // Try again within this request only if the wait still leaves time for a real attempt.
      const delay = GENERATE_RETRY_DELAYS_MS[Math.min(i, GENERATE_RETRY_DELAYS_MS.length - 1)];
      if (aborted || deadline - Date.now() - delay < MIN_ATTEMPT_MS) break;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    } finally {
      clearTimeout(timer);
    }

    const reportMd = response.text ?? "";
    if (!reportMd.trim()) {
      lastError = `Gemini returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"})`;
      await failRun(ai, id, attempts, lastError, geminiFiles);
      throw new Error(lastError);
    }
    return { status: "done", report: await saveReport(ai, run, attempts, response, reportMd) };
  }

  await db.from("reports").update({ attempts, error: lastError }).eq("id", id);
  return { status: "busy", attempts, error: lastError };
}

async function failRun(ai: GoogleGenAI, id: string, attempts: number, error: string, geminiFiles: GeminiFileRef[]) {
  await supabaseAdmin().from("reports").update({ status: "failed", attempts, error, gemini_files: null }).eq("id", id);
  await deleteGeminiFiles(ai, geminiFiles.map((f) => f.name));
}

async function saveReport(
  ai: GoogleGenAI,
  run: ReportRun,
  attempts: number,
  response: GenerateContentResponse,
  reportMd: string,
): Promise<ReportResult> {
  const geminiFiles = run.gemini_files ?? [];
  const skipped = run.skipped ?? [];
  const u = response.usageMetadata;
  const usage = {
    prompt_tokens: u?.promptTokenCount,
    output_tokens: u?.candidatesTokenCount,
    thinking_tokens: u?.thoughtsTokenCount,
    total_tokens: u?.totalTokenCount,
  };
  console.log(`[report] run ${run.id} done: ${JSON.stringify(usage)}`);

  const now = new Date();
  const file = `reports/${now.toISOString().replace(/[:.]/g, "-")}_weekly-report.md`;
  const videoCount = run.videos_json?.length ?? geminiFiles.length;
  const header = [
    `<!-- generated ${now.toISOString()} by ${run.model} (${run.media_resolution} media resolution) -->`,
    `<!-- search terms: ${run.search_terms.join(", ")} | ${geminiFiles.length} of ${videoCount} video files attached | tokens: ${usage.total_tokens ?? "?"} -->`,
    "",
  ].join("\n");
  // Local copy only; the reports table is the source of truth.
  const savedFile = await saveLocalCopy(file, header + reportMd);

  const { data: row, error } = await supabaseAdmin()
    .from("reports")
    .update({
      status: "done",
      attempts,
      error: null,
      report_md: reportMd,
      report_file: savedFile,
      ...usage,
      response: JSON.parse(JSON.stringify(response)),
      gemini_files: null,
    })
    .eq("id", run.id)
    .select("created_at")
    .single();
  if (error) {
    // The run stays `ready` with its files, so calling generate again can still save a report.
    const where = savedFile ? ` (markdown is still at ${savedFile})` : "";
    throw new Error(`Saving report failed${where}: ${error.message}`);
  }
  await deleteGeminiFiles(ai, geminiFiles.map((f) => f.name));

  return {
    id: run.id,
    created_at: row.created_at,
    file: savedFile,
    model: run.model,
    search_terms: run.search_terms,
    video_ids: run.video_ids,
    skipped,
    usage,
    report_md: reportMd,
  };
}

// A finished report by id, or the most recent one when no id is given.
export async function getReport(id?: string): Promise<ReportResult | null> {
  let query = supabaseAdmin()
    .from("reports")
    .select("id, created_at, report_file, model, search_terms, video_ids, skipped, report_md, prompt_tokens, output_tokens, thinking_tokens, total_tokens")
    .eq("status", "done");
  query = id ? query.eq("id", id) : query.order("created_at", { ascending: false }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Loading report failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    created_at: data.created_at,
    file: data.report_file,
    model: data.model,
    search_terms: data.search_terms,
    video_ids: data.video_ids,
    skipped: data.skipped ?? [],
    usage: {
      prompt_tokens: data.prompt_tokens,
      output_tokens: data.output_tokens,
      thinking_tokens: data.thinking_tokens,
      total_tokens: data.total_tokens,
    },
    report_md: data.report_md,
  };
}
