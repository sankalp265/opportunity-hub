# Opportunity Hub

Career and opportunity discovery for students, freshers and early-career professionals.
Static front end (HTML/CSS/JS, no build step) on Supabase: Auth, Postgres with Row Level Security, and Storage.

## 1. Set up Supabase (once)

0. Fastest: paste `db/schema.sql` into the **SQL Editor** and run it (one file, re-runnable, includes everything below).
1. Or run these files in order:
   1. `supabase/migrations/20260101000000_init_schema.sql`  (types, tables, indexes, triggers)
   2. `supabase/migrations/20260101000001_rls_policies.sql` (Row Level Security)
   3. `supabase/migrations/20260101000002_storage.sql`      (buckets and storage policies)
   4. `db/sample_opportunities.sql` (18 sample listings; re-runnable)
   
   Or with the CLI: `supabase link --project-ref jyldgvweqpsvjdcpmlni && supabase db push`.
2. **Authentication > URL Configuration**: set *Site URL* to where you host the app
   (and add `http://localhost:8080` under Redirect URLs for local testing).
3. **Authentication > Providers > Email**: keep enabled. Turn off "Confirm email" for quick testing, or leave it on for production.
4. Make yourself an admin (optional), in the SQL editor:
   `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'you@example.com');`

## 2. Run it

```bash
cd opportunity-hub
python3 -m http.server 8080      # then open http://localhost:8080
```
Deploy the folder as-is to Netlify, Vercel, Cloudflare Pages, GitHub Pages or Supabase hosting.
Credentials live in `js/config.js`.

## Data model

| Table | Purpose |
|---|---|
| `profiles` | One row per auth user (auto-created by trigger). Role: seeker, recruiter, admin. Skills, resume path, avatar. |
| `opportunities` | Jobs, internships, scholarships, fellowships, hackathons, courses, events. Full-text `search_vector`. |
| `saved_opportunities` | A user's bookmarks (composite PK). |
| `applications` | One per user per opportunity, with status pipeline, cover letter, resume path. |
| `relationships` | Connections between people (pending / accepted / declined / blocked), one row per pair. |

Storage buckets: `avatars` (public read) and `resumes` (private; owner, plus recruiters of the posting the resume was submitted to).

## Security model

- RLS is enabled on every table; the browser only ever holds the publishable key.
- Anyone can read published opportunities. Everything else needs sign-in.
- Users can only read/write their own saves, applications and profile; recruiters see applicants for their own postings only.
- Triggers block role escalation, changing an application's owner, and recruiters editing an applicant's content.
- Never place a `service_role` or secret key in front-end code.
