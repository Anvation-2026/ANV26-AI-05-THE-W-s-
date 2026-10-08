-- SignalTwin storage schema for Supabase.
-- The API reaches these tables with the service role key, which bypasses row level security.
-- Row level security is still on for every table, with policies for signed-in owners, so the tables are
-- safe if they are ever exposed through the Data API or used from a signed-in browser.
-- There is one anonymous owner today: owner_id is null. When accounts exist, the API fills owner_id.

create table public.videos (
  id text primary key,
  owner_id uuid references auth.users (id) on delete cascade,
  sha256 text not null unique,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index videos_owner_id_idx on public.videos (owner_id);
create index videos_created_at_idx on public.videos (created_at);

create table public.jobs (
  id text primary key,
  owner_id uuid references auth.users (id) on delete cascade,
  video_id text not null default '',
  cache_key text not null,
  state text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_owner_id_idx on public.jobs (owner_id);
create index jobs_cache_key_state_idx on public.jobs (cache_key, state);
create index jobs_video_id_idx on public.jobs (video_id);
create index jobs_state_idx on public.jobs (state);

create table public.job_events (
  id bigint generated always as identity primary key,
  job_id text not null references public.jobs (id) on delete cascade,
  seq integer not null,
  type text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);

create table public.results (
  cache_key text primary key,
  video_id text not null default '',
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);
create index results_video_id_idx on public.results (video_id);

create table public.junction (
  id text primary key,
  owner_id uuid references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index junction_owner_id_idx on public.junction (owner_id);

-- Next event number for a job, taken in one statement so two writers cannot pick the same one.
create function public.append_job_event(p_job_id text, p_type text, p_data jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_seq integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_job_id));
  select coalesce(max(seq), 0) + 1 into next_seq from public.job_events where job_id = p_job_id;
  insert into public.job_events (job_id, seq, type, data) values (p_job_id, next_seq, p_type, p_data);
  return next_seq;
end;
$$;
revoke all on function public.append_job_event(text, text, jsonb) from public, anon, authenticated;

-- Row level security. No policy for anon: signed-out visitors can read and write nothing.
alter table public.videos enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.results enable row level security;
alter table public.junction enable row level security;

create policy "owners read their videos" on public.videos for select to authenticated using ((select auth.uid()) = owner_id);
create policy "owners delete their videos" on public.videos for delete to authenticated using ((select auth.uid()) = owner_id);
create policy "owners read their jobs" on public.jobs for select to authenticated using ((select auth.uid()) = owner_id);
create policy "owners read their job events" on public.job_events for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_id and j.owner_id = (select auth.uid())));
create policy "owners read their junction" on public.junction for select to authenticated using ((select auth.uid()) = owner_id);
create policy "owners write their junction" on public.junction for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "owners update their junction" on public.junction for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
-- results has no owner column (it is keyed by content), so no policy: only the service role reads it.

-- Private buckets. Files are reached through the API, never by public URL.
-- Free projects limit each file to 50 MB; raise the limit on a paid plan before accepting larger videos.
insert into storage.buckets (id, name, public, file_size_limit)
values ('videos', 'videos', false, 52428800), ('results', 'results', false, 524288000)
on conflict (id) do nothing;
