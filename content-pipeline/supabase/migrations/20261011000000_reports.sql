-- One row per Gemini analysis run.
create table public.reports (
  id                uuid primary key default gen_random_uuid(),
  run_date          date not null default current_date,
  created_at        timestamptz not null default now(),
  search_terms      text[] not null default '{}',
  video_ids         text[] not null default '{}',  -- videos whose files were attached
  model             text not null,
  media_resolution  text,
  report_md         text,                          -- the response text
  report_file       text,                          -- markdown copy under reports/
  prompt_tokens     integer,
  output_tokens     integer,
  thinking_tokens   integer,
  total_tokens      integer,
  response          jsonb                          -- full API response, including usage metadata
);

alter table public.reports enable row level security;
