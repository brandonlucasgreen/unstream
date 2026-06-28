-- Migration 009: App events table for product analytics
-- Stores anonymized product usage events from web, extension, and Mac app.
-- No PII stored: IP addresses are never saved; session_hash is a one-way
-- SHA-256 of (ip + user_agent + date) for same-session deduplication only.

create table app_events (
  id bigserial primary key,
  event_type text not null,   -- 'search', 'platform_click', 'extension_activated', 'page_view', 'release_alert'
  app text not null,          -- 'web', 'extension', 'mac'
  context jsonb not null default '{}',
  -- context fields (by event type):
  --   search:              { has_results: bool, result_count: int }
  --   platform_click:      { platform: text }
  --   extension_activated: { streaming_service: text }
  --   page_view:           { page: text }
  --   release_alert:       { platform: text }
  session_hash text,          -- anonymous daily session ID (never raw IP/UA)
  created_at timestamptz not null default now()
);

-- Efficient queries for dashboard (time range + type filters)
create index idx_app_events_created_at on app_events(created_at desc);
create index idx_app_events_type_app on app_events(event_type, app, created_at desc);

-- RLS: public can insert (event recording), only service role can read (dashboard)
alter table app_events enable row level security;

create policy "Public insert app events" on app_events
  for insert with check (true);

-- Dashboard reads go through the service role client, which bypasses RLS
