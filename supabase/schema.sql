-- Library 3D Navigation - Supabase schema
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- Prerequisite: enable Anonymous sign-ins (Dashboard > Authentication > Providers > Anonymous).

-- ---------------------------------------------------------------------------
-- Profiles: one row per authenticated user (anonymous or email)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  blind_mode boolean not null default false,
  created_at timestamptz not null default now(),
  constraint display_name_length check (char_length(display_name) between 2 and 24)
);

create unique index if not exists profiles_display_name_key
  on public.profiles (lower(display_name));

-- ---------------------------------------------------------------------------
-- Devices: known ESP8266 sensor nodes
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id text primary key,                    -- e.g. 'NAV-001', 'NAV-REF'
  role text not null default 'user' check (role in ('user', 'reference')),
  label text,
  last_seen timestamptz
);

-- ---------------------------------------------------------------------------
-- Pairings: which user currently owns which sensor node
-- ---------------------------------------------------------------------------
create table if not exists public.pairings (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id text not null references public.devices (id) on delete cascade,
  active boolean not null default true,
  paired_at timestamptz not null default now()
);

create unique index if not exists pairings_one_active_device
  on public.pairings (device_id) where active;
create unique index if not exists pairings_one_active_user
  on public.pairings (user_id) where active;

-- ---------------------------------------------------------------------------
-- Friendships: request/accept graph
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint no_self_friend check (requester <> addressee)
);

create unique index if not exists friendships_unique_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

-- ---------------------------------------------------------------------------
-- Sessions: written by the position engine (service role) for audit/capacity
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete set null,
  device_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Site config: geo anchors and tunables (single row, id = 1)
-- ---------------------------------------------------------------------------
create table if not exists public.site_config (
  id int primary key default 1 check (id = 1),
  origin_lat double precision,
  origin_lng double precision,
  xaxis_lat double precision,
  xaxis_lng double precision,
  max_devices int not null default 5,
  updated_at timestamptz not null default now()
);

insert into public.site_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Keywords: optional server-side extension of the built-in intent dictionary.
-- The web app fetches these at startup and merges them with its local list.
-- zone_id refers to ids in web/data/map_model.json (e.g. '5F-C').
-- ---------------------------------------------------------------------------
create table if not exists public.keywords (
  id bigint generated always as identity primary key,
  term text not null,
  aliases text[] not null default '{}',
  zone_id text,
  intent text check (intent in ('zone', 'nearest_reading', 'nearest_restroom', 'newspapers')),
  created_at timestamptz not null default now()
);

insert into public.keywords (term, aliases, zone_id, intent) values
  ('machine learning', array['deep learning', 'ai books', '機器學習', '人工智慧'], '5F-C', 'zone'),
  ('cooking', array['recipes', 'cuisine', '食譜', '烹飪'], '5F-D', 'zone'),
  ('investment', array['stocks', 'finance books', '投資', '理財'], '5F-E', 'zone')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.devices     enable row level security;
alter table public.pairings    enable row level security;
alter table public.friendships enable row level security;
alter table public.sessions    enable row level security;
alter table public.site_config enable row level security;
alter table public.keywords    enable row level security;

-- Profiles: any signed-in user can read (needed for friend search); owner writes.
create policy "profiles readable by authenticated"
  on public.profiles for select to authenticated using (true);
create policy "profiles insert own"
  on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles update own"
  on public.profiles for update to authenticated using (auth.uid() = id);

-- Devices: readable by signed-in users (for pairing pickers).
create policy "devices readable by authenticated"
  on public.devices for select to authenticated using (true);
create policy "devices insert by authenticated"
  on public.devices for insert to authenticated with check (true);

-- Pairings: owner manages own pairing rows.
create policy "pairings readable by owner"
  on public.pairings for select to authenticated using (auth.uid() = user_id);
create policy "pairings insert own"
  on public.pairings for insert to authenticated with check (auth.uid() = user_id);
create policy "pairings update own"
  on public.pairings for update to authenticated using (auth.uid() = user_id);

-- Friendships: visible to and manageable by the two parties involved.
create policy "friendships visible to parties"
  on public.friendships for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);
create policy "friendships insert as requester"
  on public.friendships for insert to authenticated
  with check (auth.uid() = requester);
create policy "friendships respond as addressee"
  on public.friendships for update to authenticated
  using (auth.uid() = addressee or auth.uid() = requester);
create policy "friendships delete by parties"
  on public.friendships for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- Sessions: engine writes with the service-role key (bypasses RLS); users read own.
create policy "sessions readable by owner"
  on public.sessions for select to authenticated using (auth.uid() = user_id);

-- Site config: everyone reads; only service role writes (no insert/update policy).
create policy "site config readable by all"
  on public.site_config for select to anon, authenticated using (true);

-- Keywords: everyone reads; managed from the dashboard or service role.
create policy "keywords readable by all"
  on public.keywords for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Realtime: broadcast friendship changes so the web app updates live
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;
end $$;
