import { cleanupOldVideos } from "@/lib/videos";

// Delete MP4s older than the retention period from storage. Rows are kept.
export async function POST() {
  try {
    return Response.json(await cleanupOldVideos());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
