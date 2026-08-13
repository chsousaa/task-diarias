create table if not exists public.access_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.team_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('editor','viewer')),
  created_at timestamptz not null default now()
);

alter table public.access_requests enable row level security;
alter table public.team_members enable row level security;

create policy "request_own_select" on public.access_requests for select using (auth.uid() = user_id);
create policy "owner_requests_select" on public.access_requests for select using (auth.uid() = '551c0e6f-5dfd-4d02-b8b4-18f19fcec28b'::uuid);
create policy "owner_requests_update" on public.access_requests for update using (auth.uid() = '551c0e6f-5dfd-4d02-b8b4-18f19fcec28b'::uuid) with check (auth.uid() = '551c0e6f-5dfd-4d02-b8b4-18f19fcec28b'::uuid);
create policy "member_own_select" on public.team_members for select using (auth.uid() = user_id or auth.uid() = owner_id);

create or replace function public.handle_new_access_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.id <> '551c0e6f-5dfd-4d02-b8b4-18f19fcec28b'::uuid then
    insert into public.access_requests(user_id,email) values (new.id,new.email)
    on conflict (user_id) do update set email=excluded.email,status='pending',requested_at=now(),decided_at=null;
  end if;
  return new;
end; $$;

drop trigger if exists on_auth_user_access_request on auth.users;
create trigger on_auth_user_access_request after insert on auth.users for each row execute function public.handle_new_access_request();

create or replace function public.handle_access_decision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() <> '551c0e6f-5dfd-4d02-b8b4-18f19fcec28b'::uuid then raise exception 'not allowed'; end if;
  new.decided_at = now();
  if new.status = 'approved' then
    insert into public.team_members(user_id,owner_id,role) values (new.user_id,'551c0e6f-5dfd-4d02-b8b4-18f19fcec28b','editor')
    on conflict (user_id) do update set owner_id=excluded.owner_id,role=excluded.role;
  elsif new.status = 'rejected' then
    delete from public.team_members where user_id=new.user_id;
  end if;
  return new;
end; $$;

drop trigger if exists on_access_decision on public.access_requests;
create trigger on_access_decision before update of status on public.access_requests for each row execute function public.handle_access_decision();

create policy "team_state_select" on public.app_state for select using (
  exists(select 1 from public.team_members m where m.user_id=auth.uid() and m.owner_id=app_state.user_id)
);
create policy "team_state_update" on public.app_state for update using (
  exists(select 1 from public.team_members m where m.user_id=auth.uid() and m.owner_id=app_state.user_id and m.role='editor')
) with check (
  exists(select 1 from public.team_members m where m.user_id=auth.uid() and m.owner_id=app_state.user_id and m.role='editor')
);
