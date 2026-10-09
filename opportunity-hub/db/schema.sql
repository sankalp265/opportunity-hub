-- =====================================================================
-- OPPORTUNITY HUB — db/schema.sql
-- Paste this whole file into Supabase > SQL Editor > Run.
-- Safe to re-run: every statement is idempotent.
--
-- What it sets up
--   1. Enums, tables, indexes, triggers
--   2. handle_new_user(): a trigger on auth.users that creates a row in
--      public.profiles automatically every time someone signs up
--   3. Row Level Security policies on every table
--   4. Storage buckets (avatars, resumes) and their policies
--   5. Backfill: profiles for any users who signed up before this ran
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Enumerated types ----------
do $$ begin create type public.user_role as enum ('seeker', 'recruiter', 'admin'); exception when duplicate_object then null; end $$;
do $$ begin create type public.opportunity_type as enum ('job','internship','scholarship','fellowship','hackathon','course','event'); exception when duplicate_object then null; end $$;
do $$ begin create type public.work_mode as enum ('remote','onsite','hybrid'); exception when duplicate_object then null; end $$;
do $$ begin create type public.opportunity_status as enum ('draft','published','closed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.application_status as enum ('submitted','under_review','shortlisted','rejected','accepted','withdrawn'); exception when duplicate_object then null; end $$;
do $$ begin create type public.relationship_status as enum ('pending','accepted','declined','blocked'); exception when duplicate_object then null; end $$;

-- ---------- Helper functions ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  full_name        text not null default '' check (char_length(full_name) <= 120),
  headline         text check (char_length(headline) <= 160),
  bio              text check (char_length(bio) <= 2000),
  role             public.user_role not null default 'seeker',
  education_level  text,
  institution      text,
  graduation_year  int check (graduation_year between 1990 and 2100),
  skills           text[] not null default '{}',
  location         text,
  avatar_url       text,
  resume_path      text,
  linkedin_url     text,
  github_url       text,
  portfolio_url    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- Role helpers (security definer so RLS policies can call them without recursion)
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_recruiter()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('recruiter','admin'));
$$;

-- Create a profile automatically for every new auth user.
-- Only 'seeker' and 'recruiter' can be chosen at sign-up; admin is granted manually.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare chosen public.user_role := 'seeker';
begin
  if new.raw_user_meta_data ->> 'role' = 'recruiter' then
    chosen := 'recruiter';
  end if;
  insert into public.profiles (id, full_name, role)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
          chosen)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Block privilege escalation: only admins (or the SQL editor / service role) may change a role.
create or replace function public.protect_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can change a role';
  end if;
  return new;
end $$;
drop trigger if exists trg_profiles_protect_role on public.profiles;
create trigger trg_profiles_protect_role before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------- opportunities ----------
create table if not exists public.opportunities (
  id               uuid primary key default gen_random_uuid(),
  posted_by        uuid references public.profiles(id) on delete set null,
  title            text not null check (char_length(title) between 3 and 160),
  organization     text not null check (char_length(organization) between 2 and 160),
  description      text not null check (char_length(description) <= 10000),
  type             public.opportunity_type not null default 'job',
  category         text,
  location         text,
  work_mode        public.work_mode not null default 'onsite',
  is_paid          boolean not null default true,
  salary_min       numeric(12,2) check (salary_min >= 0),
  salary_max       numeric(12,2) check (salary_max >= 0),
  currency         text not null default 'INR' check (char_length(currency) = 3),
  experience_level text not null default 'entry',
  skills           text[] not null default '{}',
  apply_url        text,
  deadline         timestamptz,
  status           public.opportunity_status not null default 'published',
  featured         boolean not null default false,
  search_vector    tsvector,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint salary_range_valid check (salary_max is null or salary_min is null or salary_max >= salary_min)
);

create or replace function public.opportunities_search_update()
returns trigger language plpgsql as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.organization, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.skills, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.category, '') || ' ' || coalesce(new.location, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'D');
  return new;
end $$;
drop trigger if exists trg_opportunities_search on public.opportunities;
create trigger trg_opportunities_search before insert or update on public.opportunities
  for each row execute function public.opportunities_search_update();
drop trigger if exists trg_opportunities_updated on public.opportunities;
create trigger trg_opportunities_updated before update on public.opportunities
  for each row execute function public.set_updated_at();

-- ---------- saved_opportunities ----------
create table if not exists public.saved_opportunities (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);

-- ---------- applications ----------
create table if not exists public.applications (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  applicant_id   uuid not null references public.profiles(id) on delete cascade,
  status         public.application_status not null default 'submitted',
  cover_letter   text check (char_length(cover_letter) <= 5000),
  resume_path    text,
  answers        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint one_application_per_opportunity unique (opportunity_id, applicant_id)
);
drop trigger if exists trg_applications_updated on public.applications;
create trigger trg_applications_updated before update on public.applications
  for each row execute function public.set_updated_at();

create or replace function public.applications_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.opportunity_id <> old.opportunity_id or new.applicant_id <> old.applicant_id then
    raise exception 'opportunity_id and applicant_id are immutable';
  end if;
  -- Recruiters may only change status; applicants may only withdraw.
  if auth.uid() is not null and auth.uid() is distinct from old.applicant_id and not public.is_admin() then
    if new.cover_letter is distinct from old.cover_letter
       or new.resume_path is distinct from old.resume_path
       or new.answers is distinct from old.answers then
      raise exception 'Recruiters can only update the application status';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_applications_guard on public.applications;
create trigger trg_applications_guard before update on public.applications
  for each row execute function public.applications_guard();

-- ---------- relationships (connections between people) ----------
create table if not exists public.relationships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.relationship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint no_self_relationship check (requester_id <> addressee_id)
);
-- one relationship per pair, regardless of direction
create unique index if not exists relationships_pair_uniq
  on public.relationships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
drop trigger if exists trg_relationships_updated on public.relationships;
create trigger trg_relationships_updated before update on public.relationships
  for each row execute function public.set_updated_at();

create or replace function public.relationships_guard()
returns trigger language plpgsql as $$
begin
  if new.requester_id <> old.requester_id or new.addressee_id <> old.addressee_id then
    raise exception 'Participants are immutable';
  end if;
  return new;
end $$;
drop trigger if exists trg_relationships_guard on public.relationships;
create trigger trg_relationships_guard before update on public.relationships
  for each row execute function public.relationships_guard();

-- ---------- Indexes ----------
create index if not exists idx_profiles_role            on public.profiles (role);
create index if not exists idx_profiles_skills          on public.profiles using gin (skills);
create index if not exists idx_profiles_name            on public.profiles (lower(full_name));

create index if not exists idx_opps_status_created      on public.opportunities (status, created_at desc);
create index if not exists idx_opps_type                on public.opportunities (type) where status = 'published';
create index if not exists idx_opps_work_mode           on public.opportunities (work_mode) where status = 'published';
create index if not exists idx_opps_deadline            on public.opportunities (deadline) where status = 'published';
create index if not exists idx_opps_featured            on public.opportunities (featured) where featured and status = 'published';
create index if not exists idx_opps_posted_by           on public.opportunities (posted_by);
create index if not exists idx_opps_skills              on public.opportunities using gin (skills);
create index if not exists idx_opps_search              on public.opportunities using gin (search_vector);

create index if not exists idx_saved_opportunity        on public.saved_opportunities (opportunity_id);
create index if not exists idx_saved_user_created       on public.saved_opportunities (user_id, created_at desc);

create index if not exists idx_apps_applicant           on public.applications (applicant_id, created_at desc);
create index if not exists idx_apps_opportunity         on public.applications (opportunity_id, status);

create index if not exists idx_rel_requester            on public.relationships (requester_id, status);
create index if not exists idx_rel_addressee            on public.relationships (addressee_id, status);


alter table public.profiles             enable row level security;
alter table public.opportunities        enable row level security;
alter table public.saved_opportunities  enable row level security;
alter table public.applications         enable row level security;
alter table public.relationships        enable row level security;

-- ---------- profiles ----------
-- Signed-in users can browse profiles (needed for networking and recruiter review).
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (id = auth.uid() and role in ('seeker','recruiter'));
drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin" on public.profiles
  for delete to authenticated using (public.is_admin());

-- ---------- opportunities ----------
drop policy if exists "opps_select_published_public" on public.opportunities;
create policy "opps_select_published_public" on public.opportunities
  for select to anon, authenticated using (status = 'published');
drop policy if exists "opps_select_own_or_admin" on public.opportunities;
create policy "opps_select_own_or_admin" on public.opportunities
  for select to authenticated using (posted_by = auth.uid() or public.is_admin());
drop policy if exists "opps_insert_recruiter" on public.opportunities;
create policy "opps_insert_recruiter" on public.opportunities
  for insert to authenticated with check (public.is_recruiter() and posted_by = auth.uid());
drop policy if exists "opps_update_own_or_admin" on public.opportunities;
create policy "opps_update_own_or_admin" on public.opportunities
  for update to authenticated
  using (posted_by = auth.uid() or public.is_admin())
  with check (posted_by = auth.uid() or public.is_admin());
drop policy if exists "opps_delete_own_or_admin" on public.opportunities;
create policy "opps_delete_own_or_admin" on public.opportunities
  for delete to authenticated using (posted_by = auth.uid() or public.is_admin());

-- ---------- saved_opportunities ----------
drop policy if exists "saved_select_own" on public.saved_opportunities;
create policy "saved_select_own" on public.saved_opportunities
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "saved_insert_own" on public.saved_opportunities;
create policy "saved_insert_own" on public.saved_opportunities
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "saved_delete_own" on public.saved_opportunities;
create policy "saved_delete_own" on public.saved_opportunities
  for delete to authenticated using (user_id = auth.uid());

-- ---------- applications ----------
drop policy if exists "apps_select_applicant_poster_admin" on public.applications;
create policy "apps_select_applicant_poster_admin" on public.applications
  for select to authenticated using (
    applicant_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.opportunities o
               where o.id = applications.opportunity_id and o.posted_by = auth.uid())
  );
drop policy if exists "apps_insert_applicant" on public.applications;
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
drop policy if exists "apps_update_applicant" on public.applications;
create policy "apps_update_applicant" on public.applications
  for update to authenticated
  using (applicant_id = auth.uid())
  with check (applicant_id = auth.uid() and status in ('submitted','withdrawn'));
-- the poster (or admin) of the opportunity may move the application through the pipeline
drop policy if exists "apps_update_poster" on public.applications;
create policy "apps_update_poster" on public.applications
  for update to authenticated
  using (public.is_admin() or exists (select 1 from public.opportunities o
         where o.id = applications.opportunity_id and o.posted_by = auth.uid()))
  with check (public.is_admin() or exists (select 1 from public.opportunities o
         where o.id = applications.opportunity_id and o.posted_by = auth.uid()));
drop policy if exists "apps_delete_applicant" on public.applications;
create policy "apps_delete_applicant" on public.applications
  for delete to authenticated using (applicant_id = auth.uid());

-- ---------- relationships ----------
drop policy if exists "rel_select_participants" on public.relationships;
create policy "rel_select_participants" on public.relationships
  for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());
drop policy if exists "rel_insert_requester" on public.relationships;
create policy "rel_insert_requester" on public.relationships
  for insert to authenticated with check (requester_id = auth.uid() and status = 'pending');
drop policy if exists "rel_update_addressee" on public.relationships;
create policy "rel_update_addressee" on public.relationships
  for update to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid() and status in ('accepted','declined','blocked'));
drop policy if exists "rel_delete_participants" on public.relationships;
create policy "rel_delete_participants" on public.relationships
  for delete to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());


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
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');
drop policy if exists "avatars_owner_insert" on storage.objects;
create policy "avatars_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- resumes (private) ----------
drop policy if exists "resumes_owner_read" on storage.objects;
create policy "resumes_owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
-- recruiters can read a resume only if it was attached to an application on one of their postings
drop policy if exists "resumes_recruiter_read" on storage.objects;
create policy "resumes_recruiter_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resumes' and exists (
      select 1 from public.applications a
      join public.opportunities o on o.id = a.opportunity_id
      where a.resume_path = storage.objects.name and o.posted_by = auth.uid()
    )
  );
drop policy if exists "resumes_admin_read" on storage.objects;
create policy "resumes_admin_read" on storage.objects
  for select to authenticated using (bucket_id = 'resumes' and public.is_admin());
drop policy if exists "resumes_owner_insert" on storage.objects;
create policy "resumes_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "resumes_owner_update" on storage.objects;
create policy "resumes_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "resumes_owner_delete" on storage.objects;
create policy "resumes_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);


-- ---------------------------------------------------------------------
-- Backfill profiles for users that already exist in auth.users
-- ---------------------------------------------------------------------
insert into public.profiles (id, full_name, role)
select u.id,
       coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1)),
       case when u.raw_user_meta_data ->> 'role' = 'recruiter' then 'recruiter'::public.user_role else 'seeker'::public.user_role end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- Optional: make yourself an admin (replace the email, then uncomment)
-- update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'you@example.com');
