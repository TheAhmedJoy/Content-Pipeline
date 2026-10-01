"use client";

import { useState } from "react";

const DEFAULT_TERMS = ["sydney bakery", "sydney cafe", "sydney sourdough"];

// Shape of one entry in ScrapeCreators' `items` array (only the fields we use).
interface VideoItem {
  id?: string;
  desc?: string;
  url?: string;
  create_time?: string;
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
    collect_count?: number;
  };
  author?: { unique_id?: string; nickname?: string; follower_count?: number };
  video?: { duration?: number; cla_info?: { caption_infos?: unknown[] | null } };
  [key: string]: unknown;
}

interface SearchResponse {
  success?: boolean;
  credits_remaining?: number;
  credits_charged?: number;
  cursor?: number;
  items?: VideoItem[];
}

interface SearchResult {
  status: number;
  query: string;
  region?: string;
  data: SearchResponse;
}

function analyzeResults(data: SearchResponse | undefined) {
  const videos = Array.isArray(data?.items) ? data.items : [];

  const fields = videos.length > 0 ? Object.keys(videos[0]) : [];

  // TikTok caption tracks live under video.cla_info.caption_infos
  const withSubtitles = videos.filter((v) => (v.video?.cla_info?.caption_infos?.length ?? 0) > 0).length;

  const withCaptions = videos.filter((v) => typeof v.desc === "string" && v.desc.trim().length > 0).length;

  return { count: videos.length, videos, fields, withSubtitles, withCaptions, sample: videos.slice(0, 3) };
}

function formatCount(n: number | undefined): string {
  if (n === undefined) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function Home() {
  const [query, setQuery] = useState("sydney bakery");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run(term: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);
    setQuery(term);
    try {
      const res = await fetch(`/api/search?query=${encodeURIComponent(term)}`);
      const json = await res.json();
      setResult(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const analysis = result ? analyzeResults(result.data) : null;
  const links = analysis ? analysis.videos.map((v) => v.url).filter((u): u is string => !!u) : [];

  async function copyLinks() {
    await navigator.clipboard.writeText(links.join("\n"));
    setCopied(true);
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 mb-1">
          ScrapeCreators API Explorer
        </h1>
        <p className="text-sm text-zinc-500 mb-8">
          Test the TikTok search endpoint and inspect raw responses
        </p>

        {/* Search bar */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run(query)}
            placeholder="Search term..."
            className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50 outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <button
            onClick={() => run(query)}
            disabled={loading}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-50 text-white dark:text-zinc-900 px-5 py-2 text-sm font-medium disabled:opacity-50 hover:bg-zinc-700 dark:hover:bg-zinc-200 transition-colors"
          >
            {loading ? "Loading..." : "Search"}
          </button>
        </div>

        {/* Quick terms */}
        <div className="flex gap-2 mb-8">
          {DEFAULT_TERMS.map((t) => (
            <button
              key={t}
              onClick={() => run(t)}
              disabled={loading}
              className="rounded-full border border-zinc-200 dark:border-zinc-700 px-3 py-1 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              {t}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Results summary */}
        {result && analysis && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "HTTP status", value: result.status },
                { label: "Videos returned", value: analysis.count },
                { label: "With subtitles", value: `${analysis.withSubtitles} / ${analysis.count}` },
                { label: "With captions", value: `${analysis.withCaptions} / ${analysis.count}` },
                { label: "Credits charged", value: result.data?.credits_charged ?? "–" },
                { label: "Credits remaining", value: result.data?.credits_remaining ?? "–" },
                { label: "Next cursor", value: result.data?.cursor ?? "–" },
                { label: "Region", value: result.region ?? "–" },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4"
                >
                  <div className="text-xs text-zinc-500 mb-1">{s.label}</div>
                  <div className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Video links */}
            {analysis.videos.length > 0 && (
              <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                    Video links ({links.length})
                  </h2>
                  <button
                    onClick={copyLinks}
                    className="rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    {copied ? "Copied" : "Copy all links"}
                  </button>
                </div>
                <ol className="space-y-2 text-sm">
                  {analysis.videos.map((v, i) => (
                    <li key={v.id ?? i} className="flex gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-2 last:border-0">
                      <span className="w-6 shrink-0 text-right text-xs text-zinc-400 pt-0.5">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        {v.url ? (
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-blue-600 dark:text-blue-400 hover:underline break-all"
                          >
                            {v.url}
                          </a>
                        ) : (
                          <span className="text-zinc-400">No URL</span>
                        )}
                        <div className="text-xs text-zinc-500 mt-0.5">
                          @{v.author?.unique_id ?? "unknown"} · {formatCount(v.author?.follower_count)} followers ·{" "}
                          {formatCount(v.statistics?.play_count)} views · {formatCount(v.statistics?.digg_count)} likes
                        </div>
                        {v.desc && <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 line-clamp-2">{v.desc}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Fields */}
            {analysis.fields.length > 0 && (
              <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
                <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                  Fields in response ({analysis.fields.length})
                </h2>
                <div className="flex flex-wrap gap-2">
                  {analysis.fields.map((f) => (
                    <span
                      key={f}
                      className="rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-700 dark:text-zinc-300"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Sample videos */}
            {analysis.sample.length > 0 && (
              <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
                <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">
                  First {analysis.sample.length} videos
                </h2>
                <div className="space-y-4">
                  {analysis.sample.map((v, i) => (
                    <div
                      key={i}
                      className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 p-3 text-xs font-mono overflow-x-auto"
                    >
                      <pre className="whitespace-pre-wrap break-all text-zinc-700 dark:text-zinc-300">
                        {JSON.stringify(v, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Raw response toggle */}
            <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-50"
              >
                {showRaw ? "Hide" : "Show"} full raw response
              </button>
              {showRaw && (
                <pre className="mt-3 text-xs font-mono whitespace-pre-wrap break-all text-zinc-600 dark:text-zinc-400 max-h-[60vh] overflow-auto">
                  {JSON.stringify(result.data, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
