import { generateWeeklyReport, getLatestReport } from "@/lib/report";

// Uploading videos to Gemini and generating the report can take several minutes.
export const maxDuration = 300;

// Triggered manually from the "Send to Gemini" button, not after collection.
export async function POST() {
  try {
    return Response.json(await generateWeeklyReport());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[report] failed: ${error}`);
    return Response.json({ error }, { status: 500 });
  }
}

// Latest saved report (null if none yet).
export async function GET() {
  try {
    return Response.json({ report: await getLatestReport() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
