import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Write a local copy of generated output (transcripts/, reports/) when running on a dev machine.
// Skipped on Vercel, whose filesystem is read-only. Supabase holds the real copy either way, so a
// failed write is logged rather than thrown. Returns the relative path, or null if nothing was written.
export async function saveLocalCopy(relPath: string, content: string): Promise<string | null> {
  if (process.env.VERCEL) return null;
  try {
    // Not traced: these are local-only output files.
    const full = path.join(/*turbopackIgnore: true*/ process.cwd(), relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return relPath;
  } catch (e) {
    console.error(`[files] could not write ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
