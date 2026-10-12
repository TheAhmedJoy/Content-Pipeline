"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GenerateResult, PrepareResult, ReportResult } from "@/lib/report";

// Generate calls to make while Gemini reports busy (each can take up to ~4 min) before
// handing back to the user, and the pause between them.
const MAX_GENERATE_CALLS = 3;
const BUSY_PAUSE_MS = 15_000;

type Phase = "uploading" | "writing" | "busy";

const PHASE_LABELS: Record<Phase, string> = {
  uploading: "Uploading videos to Gemini…",
  writing: "Writing report…",
  busy: "Gemini is busy, retrying…",
};

async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-zinc-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

// Weekly report: manual "Send to Gemini" trigger, rendered report, and PDF download.
export default function ReportPanel() {
  const [phase, setPhase] = useState<Phase | null>(null);
  const reporting = phase !== null;
  // A run whose videos are uploaded but whose report isn't written yet, so Retry can skip the upload.
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show the latest saved report on load so it can be downloaded without a new run.
  useEffect(() => {
    fetch("/api/report")
      .then((res) => res.json())
      .then((json) => json.report && setReport((current) => current ?? json.report))
      .catch(() => {});
  }, []);

  // Elapsed-time counter while a run is in progress.
  useEffect(() => {
    if (!reporting) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [reporting]);

  // Report runs in steps so each request fits the hosting time limit:
  // upload the videos, then generate (repeated while Gemini is overloaded).
  async function sendToGemini() {
    setElapsed(0);
    setError(null);
    setPendingRunId(null);
    setPhase("uploading");
    try {
      const run = await postJson<PrepareResult>("/api/report");
      setPendingRunId(run.id);
      await generate(run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase(null);
    }
  }

  async function retryGenerate() {
    if (!pendingRunId) return;
    setElapsed(0);
    setError(null);
    try {
      await generate(pendingRunId);
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase(null);
    }
  }

  async function generate(id: string) {
    for (let call = 1; call <= MAX_GENERATE_CALLS; call++) {
      setPhase(call === 1 ? "writing" : "busy");
      const result = await postJson<GenerateResult>(`/api/report/${id}/generate`);
      if (result.status === "done") {
        setReport(result.report);
        setPendingRunId(null);
        return;
      }
      if (call < MAX_GENERATE_CALLS) {
        setPhase("busy");
        await new Promise((r) => setTimeout(r, BUSY_PAUSE_MS));
      } else {
        throw new Error(`Gemini is still overloaded (${result.error}). The videos are uploaded; click Retry to try again without re-uploading.`);
      }
    }
  }

  // The browser's print dialog saves a PDF; print styles hide everything but the report.
  // The document title becomes the suggested file name.
  function downloadPdf() {
    if (!report) return;
    const previousTitle = document.title;
    document.title = `Weekly Trend Report - ${formatDate(report.created_at)}`;
    window.addEventListener("afterprint", () => (document.title = previousTitle), { once: true });
    window.print();
  }

  return (
    <div className="mb-8 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 print:m-0 print:border-0 print:p-0">
      <div className="flex items-center justify-between gap-4 print:hidden">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Weekly report</h2>
          <p className="text-xs text-zinc-500">Sends every video downloaded in the past 7 days, with its data, to Gemini.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {reporting && (
            <span className="flex items-center gap-2 text-xs text-zinc-500" role="status">
              <Spinner />
              {phase && PHASE_LABELS[phase]} {formatElapsed(elapsed)} (usually 2–3 min)
            </span>
          )}
          {pendingRunId && !reporting && (
            <button
              onClick={retryGenerate}
              className="rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Retry
            </button>
          )}
          {report && !reporting && (
            <button
              onClick={downloadPdf}
              className="rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Download PDF
            </button>
          )}
          <button
            onClick={sendToGemini}
            disabled={reporting}
            className="rounded-md bg-zinc-900 dark:bg-zinc-50 text-white dark:text-zinc-900 px-3 py-1.5 text-xs font-medium disabled:opacity-50 hover:bg-zinc-700 dark:hover:bg-zinc-200 transition-colors"
          >
            Send to Gemini
          </button>
        </div>
      </div>

      {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400 print:hidden">{error}</div>}

      {report && (
        <div className="mt-4 print:mt-0">
          <div className="text-xs text-zinc-500 mb-4 print:hidden">
            {formatDate(report.created_at)} · {report.video_ids.length} videos · {report.model} ·{" "}
            {report.usage.total_tokens?.toLocaleString() ?? "?"} tokens
            {report.file && (
              <>
                {" "}· saved to <span className="font-mono">{report.file}</span>
              </>
            )}
            {report.skipped.length > 0 && ` · ${report.skipped.length} files failed to upload`}
          </div>
          <div className="hidden print:block text-xs text-zinc-600 mb-4">
            Week to {formatDate(report.created_at)} · Search terms: {report.search_terms.join(", ")} ·{" "}
            {report.video_ids.length} videos analysed
          </div>
          <article className="prose prose-sm prose-zinc max-w-none dark-screen:prose-invert prose-table:text-xs prose-th:whitespace-nowrap [&_td_a]:whitespace-nowrap prose-code:before:content-none prose-code:after:content-none prose-a:text-blue-600 print:prose-a:text-black">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // react-markdown passes its AST `node`; strip it so it isn't spread onto the DOM element.
                // Wide tables scroll sideways on screen instead of overflowing the card.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                table: ({ node, ...props }) => (
                  <div className="overflow-x-auto">
                    <table {...props} />
                  </div>
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
              }}
            >
              {report.report_md}
            </ReactMarkdown>
          </article>
        </div>
      )}
    </div>
  );
}
