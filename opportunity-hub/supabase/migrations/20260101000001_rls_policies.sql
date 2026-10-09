-- =====================================================================
-- Opportunity Hub — migration 2/3: Row Level Security
-- =====================================================================
alter table public.profiles             enable row level security;
alter table public.opportunities        enable row level security;
alter table public.saved_opportunities  enable row level security;
alter table public.applications         enable row level security;
alter table public.relationships        enable row level security;

-- ---------- profiles ----------
-- Signed-in users can browse profiles (needed for networking and recruiter review).
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (id = auth.uid() and role in ('seeker','recruiter'));
create policy "profiles_update_self_or_admin" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
create policy "profiles_delete_admin" on public.profiles
  for delete to authenticated using (public.is_admin());

-- ---------- opportunities ----------
create policy "opps_select_published_public" on public.opportunities
  for select to anon, authenticated using (status = 'published');
create policy "opps_select_own_or_admin" on public.opportunities
  for select to authenticated using (posted_by = auth.uid() or public.is_admin());
create policy "opps_insert_recruiter" on public.opportunities
  for insert to authenticated with check (public.is_recruiter() and posted_by = auth.uid());
create policy "opps_update_own_or_admin" on public.opportunities
  for update to authenticated
  using (posted_by = auth.uid() or public.is_admin())
  with check (posted_by = auth.uid() or public.is_admin());
create policy "opps_delete_own_or_admin" on public.opportunities
  for delete to authenticated using (posted_by = auth.uid() or public.is_admin());

-- ---------- saved_opportunities ----------
create policy "saved_select_own" on public.saved_opportunities
  for select to authenticated using (user_id = auth.uid());
create policy "saved_insert_own" on public.saved_opportunities
  for insert to authenticated with check (user_id = auth.uid());
create policy "saved_delete_own" on public.saved_opportunities
  for delete to authenticated using (user_id = auth.uid());

-- ---------- applications ----------
create policy "apps_select_applicant_poster_admin" on public.applications
  for select to authenticated using (
    applicant_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.opportunities o
               where o.id = applications.opportunity_id and o.posted_by = auth.uid())
  );
create policy "apps_insert_applicant" on public.applications
  for insert to authenticated with check (
    applicant_id = auth.uid()
    and status = 'submitted'
    and exists (select 1 from public.opportunities o
                where o.id = opportunity_id
                  and o.status = 'published'
                  and (o.deadline is null or o.deadline > now())
                  and o.posted_by is distinct from auth.uid())
  );
-- applicants may withdraw / edit their own submission
create policy "apps_update_applicant" on public.applications
  for update to authenticated
  using (applicant_id = auth.uid())
  with check (applicant_id = auth.uid() and status in ('submitted','withdrawn'));
-- the poster (or admin) of the opportunity may move the application through the pipeline
create policy "apps_update_poster" on public.applications
  for update to authenticated
  using (public.is_admin() or exists (select 1 from public.opportunities o
         where o.id = applications.opportunity_id and o.posted_by = auth.uid()))
  with check (public.is_admin() or exists (select 1 from public.opportunities o
         where o.id = applications.opportunity_id and o.posted_by = auth.uid()));
create policy "apps_delete_applicant" on public.applications
  for delete to authenticated using (applicant_id = auth.uid());

-- ---------- relationships ----------
create policy "rel_select_participants" on public.relationships
  for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy "rel_insert_requester" on public.relationships
  for insert to authenticated with check (requester_id = auth.uid() and status = 'pending');
create policy "rel_update_addressee" on public.relationships
  for update to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid() and status in ('accepted','declined','blocked'));
create policy "rel_delete_participants" on public.relationships
  for delete to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
