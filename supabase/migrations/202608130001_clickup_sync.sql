create table if not exists public.integration_sync_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sync_date date not null,
  copy_code text not null,
  offer_code text not null,
  task_name text not null,
  range_start integer not null,
  range_end integer not null,
  clickup_task_id text,
  status text not null default 'pending' check (status in ('pending','created','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, sync_date, copy_code)
);

alter table public.integration_sync_log enable row level security;
create policy "own_sync_log_select" on public.integration_sync_log for select using (auth.uid() = user_id);
