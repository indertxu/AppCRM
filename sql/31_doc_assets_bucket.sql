-- =====================================================================
-- 31_doc_assets_bucket.sql — storage for the pictures of proposals and contracts
-- =====================================================================
-- Proposal / contract templates keep their pictures (photos, logos, the pages
-- kept from a PowerPoint or PDF) in the Storage bucket "brand". Until now no
-- script created it, so every upload failed and the pictures were dropped.
--
-- This script:
--   * creates the bucket "brand" (public: the pictures show in the documents
--     clients open), max 15 MB a file, pictures only
--   * lets signed-in users upload, replace and delete files in it
--   * lets anyone read them (the documents are shared as links)
--
-- Safe to run more than once. Nothing else changes.
-- Without it the app still works: pictures are then kept inside the template.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand', 'brand', true, 15728640,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'image/bmp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "brand: anyone reads"            on storage.objects;
drop policy if exists "brand: signed-in users upload"  on storage.objects;
drop policy if exists "brand: signed-in users replace" on storage.objects;
drop policy if exists "brand: signed-in users delete"  on storage.objects;

create policy "brand: anyone reads" on storage.objects
  for select using (bucket_id = 'brand');

create policy "brand: signed-in users upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'brand');

create policy "brand: signed-in users replace" on storage.objects
  for update to authenticated using (bucket_id = 'brand') with check (bucket_id = 'brand');

create policy "brand: signed-in users delete" on storage.objects
  for delete to authenticated using (bucket_id = 'brand');

-- result: the bucket and its rules
select b.id, b.public, b.file_size_limit,
       (select count(*) from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname like 'brand:%') as policies
from storage.buckets b where b.id = 'brand';
