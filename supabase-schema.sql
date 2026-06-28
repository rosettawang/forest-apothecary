-- Laurelate Wellness Journal — schema (migration-safe)
-- SNAPSHOT as of 2026-06-27 — reflects the live Supabase database at this date.
-- Not auto-synced: if the live DB is changed directly, re-run/regenerate this to keep it true.
-- Run in Supabase → SQL Editor. Non-destructive: adds tables/columns, never drops data.
-- An older single-row "consultations" table already exists; this upgrades it in place.

-- ============================================================
-- PROFILES — SMS contact details, one row per user
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  phone text,
  sms_opt_in boolean not null default false,
  medications text,
  medical_history text,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists medications text;
alter table public.profiles add column if not exists medical_history text;
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_upsert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_upsert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- ============================================================
-- CONSULTATIONS — upgrade existing table to the thread model
-- ============================================================
create table if not exists public.consultations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- new columns (added only if missing)
alter table public.consultations add column if not exists title text not null default 'New consultation';
alter table public.consultations add column if not exists summary text;
alter table public.consultations add column if not exists kind text not null default 'acute';
alter table public.consultations add column if not exists status text;
alter table public.consultations add column if not exists archived boolean not null default false;
alter table public.consultations add column if not exists updated_at timestamptz not null default now();

-- ensure user_id auto-fills (a pre-existing legacy table won't get the column
-- default from "create table if not exists", so set it explicitly)
alter table public.consultations alter column user_id set default auth.uid();

-- relax legacy NOT NULLs so thread-style rows (no concern/herbs) can insert
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='consultations' and column_name='concern' and is_nullable='NO') then
    alter table public.consultations alter column concern drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='consultations' and column_name='herbs' and is_nullable='NO') then
    alter table public.consultations alter column herbs drop not null;
  end if;
end $$;

alter table public.consultations enable row level security;
drop policy if exists "Users can read own consultations" on public.consultations;
drop policy if exists "Users can insert own consultations" on public.consultations;
drop policy if exists "consults_select_own" on public.consultations;
drop policy if exists "consults_insert_own" on public.consultations;
drop policy if exists "consults_update_own" on public.consultations;
drop policy if exists "consults_delete_own" on public.consultations;
create policy "consults_select_own" on public.consultations for select using (auth.uid() = user_id);
create policy "consults_insert_own" on public.consultations for insert with check (auth.uid() = user_id);
create policy "consults_update_own" on public.consultations for update using (auth.uid() = user_id);
create policy "consults_delete_own" on public.consultations for delete using (auth.uid() = user_id);

-- ============================================================
-- MESSAGES — line-by-line conversation
-- ============================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user','apothecary')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_consultation_idx on public.messages(consultation_id, created_at);
alter table public.messages alter column user_id set default auth.uid();
alter table public.messages enable row level security;
drop policy if exists "messages_select_own" on public.messages;
drop policy if exists "messages_insert_own" on public.messages;
drop policy if exists "messages_update_own" on public.messages;
drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_select_own" on public.messages for select using (auth.uid() = user_id);
create policy "messages_insert_own" on public.messages for insert with check (auth.uid() = user_id);
create policy "messages_update_own" on public.messages for update using (auth.uid() = user_id);
create policy "messages_delete_own" on public.messages for delete using (auth.uid() = user_id);

-- ============================================================
-- REMINDERS — scheduled SMS check-ins
-- ============================================================
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid references public.consultations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  send_at timestamptz not null,
  message text not null,
  sent boolean not null default false,
  repeat text not null default 'none',   -- 'none' | 'daily'
  created_at timestamptz not null default now()
);
alter table public.reminders add column if not exists repeat text not null default 'none';
create index if not exists reminders_due_idx on public.reminders(send_at) where sent = false;
alter table public.reminders alter column user_id set default auth.uid();
alter table public.reminders enable row level security;
drop policy if exists "reminders_select_own" on public.reminders;
drop policy if exists "reminders_insert_own" on public.reminders;
drop policy if exists "reminders_update_own" on public.reminders;
drop policy if exists "reminders_delete_own" on public.reminders;
create policy "reminders_select_own" on public.reminders for select using (auth.uid() = user_id);
create policy "reminders_insert_own" on public.reminders for insert with check (auth.uid() = user_id);
create policy "reminders_update_own" on public.reminders for update using (auth.uid() = user_id);
create policy "reminders_delete_own" on public.reminders for delete using (auth.uid() = user_id);

-- ============================================================
-- updated_at trigger for consultations
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists consultations_touch on public.consultations;
create trigger consultations_touch before update on public.consultations
  for each row execute function public.touch_updated_at();
