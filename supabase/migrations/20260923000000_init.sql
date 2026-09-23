-- Three tables. Every row belongs to one user and row-level security keeps it that way.
-- The Worker queries with the user's own token, so these policies are the real guardrail.

create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  -- Bumped by trigger whenever any document's context changes. Scores and blurbs
  -- remember the version they were made for, so stale ones get recomputed.
  context_version int not null default 0
);

create table public.documents (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('resume', 'transcript', 'linkedin', 'interview')),
  filename text not null,
  size_bytes int not null default 0,
  raw_text text not null default '',      -- text extracted in the browser (lets us regenerate context later)
  context text not null default '',       -- LLM-written plaintext note read by every later step
  messages jsonb,                         -- interview transcript (kind = 'interview' only)
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create table public.mentors (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  linkedin_slug text not null,
  name text not null,
  headline text not null default '',
  snippet text not null default '',
  url text not null,
  score int,
  reason text,
  scored_version int,
  blurb text,
  blurb_version int,
  shown_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, linkedin_slug)
);

create index mentors_pool_idx on public.mentors (user_id, scored_version, score desc) where shown_at is null;

-- ─── Row-level security ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.mentors enable row level security;

-- profiles is read-only for users; only the trigger below writes it.
create policy "read own profile" on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

create policy "own documents" on public.documents
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own mentors" on public.mentors
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ─── Context versioning ──────────────────────────────────────────────────────
create function public.bump_context_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.context <> '' and (tg_op = 'INSERT' or new.context is distinct from old.context) then
    insert into public.profiles (user_id, context_version)
    values (new.user_id, 1)
    on conflict (user_id) do update set context_version = public.profiles.context_version + 1;
  end if;
  return new;
end;
$$;

create trigger documents_bump_context_version
  after insert or update of context on public.documents
  for each row execute function public.bump_context_version();
