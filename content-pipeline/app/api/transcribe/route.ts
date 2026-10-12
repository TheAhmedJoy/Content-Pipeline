import { mapLimit } from "@/lib/async";
import { saveLocalCopy } from "@/lib/local-files";
import { saveTranscripts } from "@/lib/videos";

// Max transcript requests in flight to ScrapeCreators at once.
const CONCURRENCY = 5;

// Video metadata sent from the frontend alongside each URL.
export interface VideoInput {
  id?: string;
  url: string;
  author?: { username?: string; nickname?: string; followers?: number };
  caption?: string;
  posted_at?: string;
  duration_s?: number;
  stats?: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
  // Video file links in the order to try them (see orderPlayUrls in lib/tiktok.ts).
  play_urls?: string[];
  file_size_bytes?: number;
  cover_url?: string;
}

export interface TranscribedVideo extends VideoInput {
  transcript: string | null;
  transcript_error?: string;
}

// The shareable context file: one per transcription run.
export interface TranscriptBundle {
  query: string | null;
  region: string | null;
  language: string;
  generated_at: string;
  video_count: number;
  transcribed_count: number;
  videos: TranscribedVideo[];
}

// Reduce WebVTT to plain spoken text: drop the header, cue ids, timestamps and
// inline tags, and collapse the repeated lines that rolling captions produce.
function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE") || line.includes("-->") || /^\d+$/.test(line)) {
      continue;
    }
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ");
}

async function fetchTranscript(video: VideoInput, language: string, apiKey: string): Promise<TranscribedVideo> {
  const url = new URL("https://api.scrapecreators.com/v1/tiktok/video/transcript");
  url.searchParams.set("url", video.url);
  url.searchParams.set("language", language);

  try {
    const response = await fetch(url.toString(), { headers: { "x-api-key": apiKey } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ...video, transcript: null, transcript_error: data?.message ?? data?.error ?? `HTTP ${response.status}` };
    }
    if (typeof data?.transcript !== "string" || !data.transcript.trim()) {
      return { ...video, transcript: null, transcript_error: "No transcript available" };
    }
    const text = vttToText(data.transcript);
    return text ? { ...video, transcript: text } : { ...video, transcript: null, transcript_error: "Transcript was empty" };
  } catch (e) {
    return { ...video, transcript: null, transcript_error: String(e) };
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "videos";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const videos: VideoInput[] = Array.isArray(body?.videos) ? body.videos.filter((v: VideoInput) => v?.url) : [];
  const query: string | null = body?.query ?? null;
  const region: string | null = body?.region ?? null;
  const language: string = body?.language ?? "en";

  if (videos.length === 0) {
    return Response.json({ error: "No video URLs provided" }, { status: 400 });
  }

  const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "SCRAPE_CREATORS_API_KEY not set" }, { status: 500 });
  }

  const results = await mapLimit(videos, CONCURRENCY, (v) => fetchTranscript(v, language, apiKey));

  // Keep the database copy in step with the JSON file; the file is still written if this fails.
  await saveTranscripts(results).catch((e) => console.error(`[transcript] save failed: ${e}`));

  const generatedAt = new Date();
  const bundle: TranscriptBundle = {
    query,
    region,
    language,
    generated_at: generatedAt.toISOString(),
    video_count: results.length,
    transcribed_count: results.filter((r) => r.transcript).length,
    videos: results,
  };

  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}_${slugify(query ?? "videos")}.json`;
  const file = await saveLocalCopy(`transcripts/${filename}`, JSON.stringify(bundle, null, 2));

  return Response.json({ file, filename, bundle });
}
