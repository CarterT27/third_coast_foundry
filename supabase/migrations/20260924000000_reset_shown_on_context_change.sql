-- When the context changes (edited interview, re-uploaded document), the mentors already
-- shown were picked for the old context. Clear shown_at so the results step starts over and
-- everyone found so far is rescored against the new context (and can be shown again).
create or replace function public.bump_context_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.context <> '' and (tg_op = 'INSERT' or new.context is distinct from old.context) then
    insert into public.profiles (user_id, context_version)
    values (new.user_id, 1)
    on conflict (user_id) do update set context_version = public.profiles.context_version + 1;
    update public.mentors set shown_at = null where user_id = new.user_id and shown_at is not null;
  end if;
  return new;
end;
$$;
