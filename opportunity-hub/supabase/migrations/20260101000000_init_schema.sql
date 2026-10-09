-- =====================================================================
-- Opportunity Hub — migration 1/3: schema, types, tables, indexes, triggers
-- Run order: 20260101000000 -> 20260101000001 -> 20260101000002
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- Enumerated types ----------
create type public.user_role           as enum ('seeker', 'recruiter', 'admin');
create type public.opportunity_type    as enum ('job','internship','scholarship','fellowship','hackathon','course','event');
create type public.work_mode           as enum ('remote','onsite','hybrid');
create type public.opportunity_status  as enum ('draft','published','closed');
create type public.application_status  as enum ('submitted','under_review','shortlisted','rejected','accepted','withdrawn');
create type public.relationship_status as enum ('pending','accepted','declined','blocked');

-- ---------- Helper functions ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles ----------
create table public.profiles (
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

create trigger on_auth_user_created
  after insert on auth.users
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
create trigger trg_profiles_protect_role before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------- opportunities ----------
create table public.opportunities (
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
create trigger trg_opportunities_search before insert or update on public.opportunities
  for each row execute function public.opportunities_search_update();
create trigger trg_opportunities_updated before update on public.opportunities
  for each row execute function public.set_updated_at();

-- ---------- saved_opportunities ----------
create table public.saved_opportunities (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);

-- ---------- applications ----------
create table public.applications (
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
create trigger trg_applications_guard before update on public.applications
  for each row execute function public.applications_guard();

-- ---------- relationships (connections between people) ----------
create table public.relationships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.relationship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint no_self_relationship check (requester_id <> addressee_id)
);
-- one relationship per pair, regardless of direction
create unique index relationships_pair_uniq
  on public.relationships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
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
create trigger trg_relationships_guard before update on public.relationships
  for each row execute function public.relationships_guard();

-- ---------- Indexes ----------
create index idx_profiles_role            on public.profiles (role);
create index idx_profiles_skills          on public.profiles using gin (skills);
create index idx_profiles_name            on public.profiles (lower(full_name));

create index idx_opps_status_created      on public.opportunities (status, created_at desc);
create index idx_opps_type                on public.opportunities (type) where status = 'published';
create index idx_opps_work_mode           on public.opportunities (work_mode) where status = 'published';
create index idx_opps_deadline            on public.opportunities (deadline) where status = 'published';
create index idx_opps_featured            on public.opportunities (featured) where featured and status = 'published';
create index idx_opps_posted_by           on public.opportunities (posted_by);
create index idx_opps_skills              on public.opportunities using gin (skills);
create index idx_opps_search              on public.opportunities using gin (search_vector);

create index idx_saved_opportunity        on public.saved_opportunities (opportunity_id);
create index idx_saved_user_created       on public.saved_opportunities (user_id, created_at desc);

create index idx_apps_applicant           on public.applications (applicant_id, created_at desc);
create index idx_apps_opportunity         on public.applications (opportunity_id, status);

create index idx_rel_requester            on public.relationships (requester_id, status);
create index idx_rel_addressee            on public.relationships (addressee_id, status);
