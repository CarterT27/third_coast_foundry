-- Deleting a document changes the context just like editing one: bump the version so
-- everyone is rescored without it, and clear shown_at so the results step starts over.
create function public.bump_context_version_on_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, context_version)
  values (old.user_id, 1)
  on conflict (user_id) do update set context_version = public.profiles.context_version + 1;
  update public.mentors set shown_at = null where user_id = old.user_id and shown_at is not null;
  return old;
end;
$$;

create trigger documents_bump_context_version_on_delete
  after delete on public.documents
  for each row execute function public.bump_context_version_on_delete();
