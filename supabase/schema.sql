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

-- Phase 3: turn bookmarks into a full Watchlist -- status through the
-- shortlist -> inspect -> EMD -> auction-day flow, plus the fields needed
-- to compare landing cost before bidding.
alter table bookmarks add column if not exists watch_status text not null default 'watching';
alter table bookmarks add column if not exists team text;
alter table bookmarks add column if not exists inspection_status text not null default 'pending';
alter table bookmarks add column if not exists inspection_notes text;
alter table bookmarks add column if not exists emd_required boolean not null default false;
alter table bookmarks add column if not exists emd_amount text;
alter table bookmarks add column if not exists emd_paid boolean not null default false;
alter table bookmarks add column if not exists last_bid text;
alter table bookmarks add column if not exists won_by text;
alter table bookmarks add column if not exists lifting_expense text;
alter table bookmarks add column if not exists transport_expense text;

-- Phase 5: external_lots -- manual tracking for auctions run on sites other
-- than IREPS (MSTC, MJunction, ...) that we don't scrape. Carries the same
-- watch/inspection/EMD/auction-day fields as bookmarks, plus the basic lot
-- description fields that a scraped `lots` row would normally supply.
-- Scoped to the signed-in user via RLS, same pattern as bookmarks/keywords.
create table if not exists external_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'MSTC',
  external_lot_no text,
  title text not null,
  location text,
  category text,
  qty_unit text,
  auction_date date,
  source_url text,
  notes text,
  watch_status text not null default 'watching',
  team text,
  inspection_status text not null default 'pending',
  inspection_notes text,
  emd_required boolean not null default false,
  emd_amount text,
  emd_paid boolean not null default false,
  target_rate text,
  lifting_expense text,
  transport_expense text,
  last_bid text,
  sold_rate text,
  won_by text,
  created_at timestamptz not null default now()
);

alter table external_lots enable row level security;

create policy "users manage their own external lots"
  on external_lots for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Phase 6: awarded_lots -- lots you actually won, carried from auction
-- through payment and delivery. Self-contained (not FK'd to lots/bookmarks/
-- external_lots) since a win can come from any of those sources, or be
-- entered directly. Scoped to the signed-in user via RLS.
create table if not exists awarded_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'IREPS',
  lot_no text,
  title text not null,
  location text,
  category text,
  qty_unit text,
  sold_rate text,
  awarded_date date,
  status text not null default 'awarded',
  payment_due_date date,
  payment_status text not null default 'pending',
  amount_paid text,
  delivery_due_date date,
  qty_lifted text,
  qty_balance text,
  expenses text,
  notes text,
  created_at timestamptz not null default now()
);

alter table awarded_lots enable row level security;

create policy "users manage their own awarded lots"
  on awarded_lots for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Document uploads for awarded lots (contracts, delivery challans, payment
-- receipts, ...). Private bucket; objects are stored under
-- "<user_id>/<award_id>/<filename>" so the RLS policy below can scope
-- access per user by the first path segment.
insert into storage.buckets (id, name, public)
values ('award-documents', 'award-documents', false)
on conflict (id) do nothing;

create policy "users manage their own award documents"
  on storage.objects for all
  using (bucket_id = 'award-documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'award-documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- Phase 7: lifted_material -- a ledger of individual lifting/gate-pass
-- events against an awarded lot. award_id links back to awarded_lots when
-- logged from there (set null if that award is later deleted, so the
-- lifting record itself isn't lost); lot_no/title are denormalized so an
-- entry still reads fine on its own. Scoped to the signed-in user via RLS.
create table if not exists lifted_material (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  award_id bigint references awarded_lots(id) on delete set null,
  lot_no text,
  title text not null,
  lifted_date date,
  qty text,
  vehicle_no text,
  transporter text,
  gate_pass_no text,
  destination text,
  notes text,
  created_at timestamptz not null default now()
);

alter table lifted_material enable row level security;

create policy "users manage their own lifted material"
  on lifted_material for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
