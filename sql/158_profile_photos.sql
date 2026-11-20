-- 158 · Profile photos (Enterprise; additive — Base can read it too)
-- Settings › Your account: each person can put a photo instead of their initials. The app shows it wherever a
-- person's circle is drawn (the dock, tickets, the team, the org chart…). Stored in the public bucket "avatars"
-- under <user id>/<random>.jpg; only you can add, change or remove your own.

alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists avatars_own_write on storage.objects;
create policy avatars_own_write on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- the bucket is public (the photos load by their link); listing is only your own folder
drop policy if exists avatars_own_read on storage.objects;
create policy avatars_own_read on storage.objects for select
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
