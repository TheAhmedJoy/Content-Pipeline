import { generateReport } from "@/lib/report";

// Step 2 calls Gemini within REPORT_GENERATE_BUDGET_MS (240 s), under Vercel Hobby's 300 s limit.
export const maxDuration = 300;

// Returns { status: "done", report } or, if Gemini stayed overloaded, { status: "busy" }.
// A busy run keeps its uploaded files, so the panel just calls this again.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json(await generateReport(id));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[report] generate ${id} failed: ${error}`);
    return Response.json({ error }, { status: 500 });
  }
}
