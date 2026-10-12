import { getReport, prepareReport } from "@/lib/report";

// Step 1 uploads the videos to Gemini (about 40 s for 16 videos). Vercel Hobby's limit is 300 s.
export const maxDuration = 300;

// Triggered manually from the "Send to Gemini" button, not after collection.
// Uploads the videos and returns a run id; the panel then calls /api/report/[id]/generate.
export async function POST() {
  try {
    return Response.json(await prepareReport());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[report] prepare failed: ${error}`);
    return Response.json({ error }, { status: 500 });
  }
}

// Latest finished report (null if none yet).
export async function GET() {
  try {
    return Response.json({ report: await getReport() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
