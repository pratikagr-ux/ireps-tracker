-- IREPS tracker Supabase schema.
-- Run this once in the Supabase SQL Editor for the new ireps-tracker project.

-- lots: scraped IREPS auction data. Not sensitive (publicly listed on
-- ireps.gov.in already), so it's readable by anyone with the anon key.
-- Only the local scan-push script (using the service_role key, which
-- bypasses RLS) ever writes to it -- no insert/update/delete policy is
-- defined for anon/authenticated roles, so the browser can never write here.
create table if not exists lots (
  lot_no text primary key,
  lot_id text,
  railway text,
  depot text,
  qty_unit text,
  category text,
  min_incr text,
  material_descr text,
  publish_date text,
  next_auction text,
  status text not null default 'active',       -- active | expired
  change_tag text,                              -- new | updated | unchanged | expired
  detail jsonb,                                 -- full per-lot detail-popup fields, for client-side PDF generation
  content_hash text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table lots enable row level security;

create policy "lots are publicly readable"
  on lots for select
  using (true);

-- bookmarks: your private notes/target rate/secured rate/sold rate/expenses
-- per lot. Scoped to the signed-in user via RLS -- nobody else (not even
-- with the anon key) can read or write another user's bookmarks.
create table if not exists bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  lot_no text not null references lots(lot_no) on delete cascade,
  notes text,
  target_rate text,
  secured_rate text,
  sold_rate text,
  expenses text,
  bookmarked_at timestamptz not null default now(),
  primary key (user_id, lot_no)
);

alter table bookmarks enable row level security;

create policy "users manage their own bookmarks"
  on bookmarks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- scans: lightweight history of each scan run, for an "last scanned at" /
-- summary display in the UI. Public read (same reasoning as lots), writes
-- only via the service_role key.
create table if not exists scans (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  total_lots int not null default 0,
  new_count int not null default 0,
  updated_count int not null default 0,
  expired_count int not null default 0
);

alter table scans enable row level security;

create policy "scans are publicly readable"
  on scans for select
  using (true);

-- keywords: your saved watch-keywords for the "Keyword Matches" view (lots
-- of interest, regardless of whether you've bookmarked them yet). Scoped to
-- the signed-in user via RLS, same pattern as bookmarks.
create table if not exists keywords (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword text not null,
  created_at timestamptz not null default now(),
  unique (user_id, keyword)
);

alter table keywords enable row level security;

create policy "users manage their own keywords"
  on keywords for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
