-- Fitrm client booking. Run this once in the Supabase SQL editor.
-- The app keeps working without it. Booking requests stay closed until this exists.
-- No client list is exposed. Trainers can read and update only their own requests.
-- Inserts come from the server function, which uses the service role.

create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null,
  slug text not null,
  client_name text not null,
  client_phone text,
  client_email text,
  slot_start text not null,
  duration_min integer not null default 60,
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now()
);

create index if not exists booking_requests_trainer_status_idx
  on public.booking_requests (trainer_id, status, created_at desc);

alter table public.booking_requests enable row level security;

drop policy if exists booking_requests_select_own on public.booking_requests;
create policy booking_requests_select_own on public.booking_requests
  for select using (auth.uid() = trainer_id);

drop policy if exists booking_requests_update_own on public.booking_requests;
create policy booking_requests_update_own on public.booking_requests
  for update using (auth.uid() = trainer_id) with check (auth.uid() = trainer_id);

-- No insert or delete policy for signed-in users or anonymous visitors.
-- The /api/book function inserts with the service role, which bypasses these rules.

create table if not exists public.booking_rate (
  id bigint generated always as identity primary key,
  slug text not null,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists booking_rate_lookup_idx
  on public.booking_rate (slug, ip_hash, created_at desc);

alter table public.booking_rate enable row level security;
-- No policies: only the service role can read or write rate rows.
