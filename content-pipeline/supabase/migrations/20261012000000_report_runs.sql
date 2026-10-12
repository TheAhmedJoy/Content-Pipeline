-- Reports now run in steps (upload, then generate) so each request fits Vercel's
-- function time limit. A row is created after the upload step and carries
-- everything the generate step needs, so generate can be retried on its own
-- without re-uploading.
alter table public.reports
  -- ready: files uploaded, waiting to generate | done: report saved | failed: gave up
  -- Existing rows are finished reports.
  add column status       text not null default 'done'
    check (status in ('ready', 'done', 'failed')),
  add column gemini_files jsonb,                       -- [{video_id, name, uri, mime_type}], cleared once deleted
  add column videos_json  jsonb,                       -- per-video JSON sent to Gemini, frozen at upload time
  add column prompt       text,                        -- prompt text used, frozen at upload time
  add column skipped      jsonb not null default '[]', -- [{id, reason}] videos whose upload failed
  add column attempts     integer not null default 0,  -- generate calls made so far
  add column error        text;                        -- last generate error

-- New runs start as ready; the default above only exists to backfill old rows.
alter table public.reports alter column status set default 'ready';
