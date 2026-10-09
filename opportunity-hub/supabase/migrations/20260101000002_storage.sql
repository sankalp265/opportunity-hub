-- =====================================================================
-- Opportunity Hub — migration 3/3: Storage buckets + policies
-- File path convention: <user_id>/<filename>
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true,  2097152,
     array['image/png','image/jpeg','image/webp']),
  ('resumes', 'resumes', false, 5242880,
     array['application/pdf','application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- avatars (public read, owner write) ----------
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- resumes (private) ----------
create policy "resumes_owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
-- recruiters can read a resume only if it was attached to an application on one of their postings
create policy "resumes_recruiter_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resumes' and exists (
      select 1 from public.applications a
      join public.opportunities o on o.id = a.opportunity_id
      where a.resume_path = storage.objects.name and o.posted_by = auth.uid()
    )
  );
create policy "resumes_admin_read" on storage.objects
  for select to authenticated using (bucket_id = 'resumes' and public.is_admin());
create policy "resumes_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
