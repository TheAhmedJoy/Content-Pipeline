-- One row per TikTok video we've collected. Mirrors the per-video JSON from
-- lib/tiktok.ts plus collection and download bookkeeping.
create table public.videos (
  id               text primary key,          -- TikTok video ID
  url              text not null,
  username         text,
  followers        bigint,
  caption          text,
  posted_at        timestamptz,
  duration_s       numeric,
  views            bigint,
  likes            bigint,
  comments         bigint,
  shares           bigint,
  saves            bigint,
  transcript       text,
  transcript_error text,
  play_urls        text[] not null default '{}',
  file_size_bytes  bigint,
  cover_url        text,

  search_term      text,
  collected_at     timestamptz not null default now(),

  -- pending | downloaded | failed | expired (MP4 removed by retention cleanup)
  download_status  text not null default 'pending'
    check (download_status in ('pending', 'downloaded', 'failed', 'expired')),
  download_error   text,
  storage_path     text,                      -- object key in the `videos` bucket
  downloaded_at    timestamptz                -- used by retention cleanup
);

create index videos_download_status_idx on public.videos (download_status, downloaded_at);

-- Only the server (secret key) touches this table; RLS on with no policies
-- blocks the publishable key entirely.
alter table public.videos enable row level security;

-- Private bucket for the downloaded MP4s.
insert into storage.buckets (id, name, public)
values ('videos', 'videos', false)
on conflict (id) do nothing;
