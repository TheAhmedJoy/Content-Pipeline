// Storage bucket that holds downloaded MP4s.
export const VIDEO_BUCKET = "videos";

// How long downloaded MP4s are kept in storage before cleanup deletes them.
// Database rows are kept regardless.
export const VIDEO_RETENTION_DAYS = Number(process.env.VIDEO_RETENTION_DAYS ?? 30);

// Max video downloads in flight at once.
export const DOWNLOAD_CONCURRENCY = 3;

// Gemini video analysis.
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
// low | medium | high. Low keeps video token cost down.
export const GEMINI_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION ?? "low";
export const REPORT_PROMPT_PATH = "prompts/weekly_report.md";
// The report covers videos collected in this many past days.
export const REPORT_WINDOW_DAYS = 7;
// Max Gemini file uploads in flight at once.
export const GEMINI_UPLOAD_CONCURRENCY = 3;
// Time the generate step may spend calling Gemini (including retries) in one request.
// Kept under Vercel Hobby's 300 s function limit with room to save the result.
export const REPORT_GENERATE_BUDGET_MS = 240_000;
