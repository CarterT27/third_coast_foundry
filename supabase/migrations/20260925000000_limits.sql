-- Limits that hold even when someone skips the Worker. The browser's publishable key plus
-- the user's token can call Supabase's REST API directly, so every guardrail lives here.

-- ─── Usage quotas ────────────────────────────────────────────────────────────
-- One row per user, action and UTC day. No policies: users can't read or write it
-- except through use_quota() below.
create table public.usage (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null,
  day date not null,
  count int not null default 0,
  primary key (user_id, kind, day)
);

create index usage_kind_day_idx on public.usage (kind, day);

alter table public.usage enable row level security;

-- Counts one use of `p_kind` for the signed-in user. Returns 'ok', or 'user' / 'site' if a
-- per-user or site-wide limit is already used up (nothing is counted then). The limits are
-- hardcoded so a caller can't pass their own.
--
--   kind        per user/day   site/day   site/month   what it costs
--   search      3              10         90           10 Brave queries ($5 credit ≈ 1,000/month)
--   mentors     30             1000       -            scoring + blurb LLM calls
--   interview   150            5000       -            one LLM reply
--   finish      10             500        -            summary + up to 3 note LLM calls
--   document    30             1000       -            one note LLM call later
create function public.use_quota(p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  user_limit int;
  day_limit int;
  month_limit int;
begin
  if uid is null then return 'user'; end if;
  case p_kind
    when 'search'    then user_limit := 3;   day_limit := 10;   month_limit := 90;
    when 'mentors'   then user_limit := 30;  day_limit := 1000;
    when 'interview' then user_limit := 150; day_limit := 5000;
    when 'finish'    then user_limit := 10;  day_limit := 500;
    when 'document'  then user_limit := 30;  day_limit := 1000;
    else raise exception 'unknown quota kind: %', p_kind;
  end case;

  -- Serialize per kind so parallel requests can't both squeeze under a limit.
  perform pg_advisory_xact_lock(hashtext('use_quota:' || p_kind));

  if coalesce((select u.count from public.usage u where u.user_id = uid and u.kind = p_kind and u.day = today), 0) >= user_limit then
    return 'user';
  end if;
  if (select coalesce(sum(u.count), 0) from public.usage u where u.kind = p_kind and u.day = today) >= day_limit
     or (month_limit is not null and (
       select coalesce(sum(u.count), 0) from public.usage u
       where u.kind = p_kind and u.day >= date_trunc('month', today)::date
     ) >= month_limit) then
    return 'site';
  end if;

  insert into public.usage (user_id, kind, day, count) values (uid, p_kind, today, 1)
  on conflict (user_id, kind, day) do update set count = public.usage.count + 1;
  return 'ok';
end;
$$;

revoke execute on function public.use_quota(text) from public, anon;
grant execute on function public.use_quota(text) to authenticated;

-- ─── Search paging ───────────────────────────────────────────────────────────
-- Queries are generated at temperature 0, so searching again for the same context repeats
-- them. Each new search for the same context version asks Brave for the next page, and once
-- a search adds nobody new, no more searches run until the context changes.
alter table public.profiles
  add column search_version int,
  add column search_page int not null default 0,
  add column search_exhausted boolean not null default false;

create function public.record_search(p_version int, p_page int, p_exhausted boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.profiles (user_id, search_version, search_page, search_exhausted)
  values (auth.uid(), p_version, p_page, p_exhausted)
  on conflict (user_id) do update
    set search_version = excluded.search_version,
        search_page = excluded.search_page,
        search_exhausted = excluded.search_exhausted;
end;
$$;

revoke execute on function public.record_search(int, int, boolean) from public, anon;
grant execute on function public.record_search(int, int, boolean) to authenticated;

-- ─── Size limits ─────────────────────────────────────────────────────────────
-- NOT VALID: enforced on every new write, without failing on rows already stored.
-- raw_text matches MAX_DOCUMENT_CHARS; the Worker caps notes and messages well below these.
alter table public.documents
  add constraint documents_filename_len check (char_length(filename) <= 255) not valid,
  add constraint documents_raw_text_len check (char_length(raw_text) <= 100000) not valid,
  add constraint documents_context_len check (char_length(context) <= 30000) not valid,
  add constraint documents_messages_len check (
    messages is null or (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) <= 61
      and char_length(messages::text) <= 400000)
  ) not valid;

alter table public.mentors
  add constraint mentors_slug_len check (char_length(linkedin_slug) <= 200) not valid,
  add constraint mentors_name_len check (char_length(name) <= 300) not valid,
  add constraint mentors_headline_len check (char_length(headline) <= 500) not valid,
  add constraint mentors_snippet_len check (char_length(snippet) <= 1000) not valid,
  add constraint mentors_url_len check (char_length(url) <= 300) not valid,
  add constraint mentors_reason_len check (char_length(reason) <= 2000) not valid,
  add constraint mentors_blurb_len check (char_length(blurb) <= 4000) not valid;

-- ─── Rows per user ───────────────────────────────────────────────────────────
-- At most 1,000 people per user (100 pages of "Show 10 more"). New people past the cap are
-- skipped silently, so a search that hits it just finds nobody new; updates to people
-- already stored (upserts from scoring and blurbs) still go through.
create function public.cap_mentors() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.mentors m where m.user_id = new.user_id and m.linkedin_slug = new.linkedin_slug) then
    return new;
  end if;
  if (select count(*) from public.mentors m where m.user_id = new.user_id) >= 1000 then
    return null;
  end if;
  return new;
end;
$$;

create trigger mentors_cap
  before insert on public.mentors
  for each row execute function public.cap_mentors();
