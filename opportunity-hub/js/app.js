/* Opportunity Hub — single-page app on Supabase (Auth, Postgres + RLS, Storage) */
(() => {
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);
const state = { session: null, profile: null, saved: new Set() };
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const PAGE = 12;

const TYPES = { job:'Job', internship:'Internship', scholarship:'Scholarship', fellowship:'Fellowship', hackathon:'Hackathon', course:'Course', event:'Event' };
const MODES = { remote:'Remote', onsite:'On-site', hybrid:'Hybrid' };
const APP_STATUS = { submitted:'Submitted', under_review:'Under review', shortlisted:'Shortlisted', rejected:'Not selected', accepted:'Accepted', withdrawn:'Withdrawn' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const money = (o) => {
  if (!o.is_paid) return 'Unpaid / free';
  if (o.salary_min == null && o.salary_max == null) return 'Paid';
  const f = n => new Intl.NumberFormat('en-IN', { style:'currency', currency:o.currency, maximumFractionDigits:0 }).format(n);
  return o.salary_min === o.salary_max || o.salary_max == null ? f(o.salary_min) : `${f(o.salary_min)} – ${f(o.salary_max)}`;
};
const daysLeft = d => d ? Math.ceil((new Date(d) - Date.now()) / 864e5) : null;
const deadlineTag = d => {
  const n = daysLeft(d);
  if (n === null) return '<span class="tag">Rolling</span>';
  if (n < 0) return '<span class="tag bad">Closed</span>';
  if (n <= 7) return `<span class="tag warn">Closes in ${n === 0 ? 'under a day' : n + (n === 1 ? ' day' : ' days')}</span>`;
  return `<span class="tag">Closes ${new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short' })}</span>`;
};
const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}
const fail = (e, fallback = 'Something went wrong. Try again.') => { console.error(e); toast(e?.message || fallback, true); };

function modal(html) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dlg">${html}</div>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.showModal();
  return d;
}
const go = h => { location.hash = h; };
const loading = () => { app.innerHTML = `<div class="wrap section"><div class="cards">${'<div class="skeleton"></div>'.repeat(6)}</div></div>`; };
const isRecruiter = () => ['recruiter', 'admin'].includes(state.profile?.role);

function requireAuth() {
  if (state.session) return true;
  go('#/login?next=' + encodeURIComponent(location.hash));
  return false;
}
function qs() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

/* ---------- auth + profile ---------- */
async function loadProfile() {
  if (!state.session) { state.profile = null; state.saved = new Set(); return; }
  const uid = state.session.user.id;
  let p = null;
  for (let i = 0; i < 4 && !p; i++) {            // trigger may take a moment right after sign-up
    const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    p = data; if (!p) await new Promise(r => setTimeout(r, 400));
  }
  if (!p) {                                       // fallback if the DB trigger was not installed
    const u = state.session.user, meta = u.user_metadata || {};
    const { data } = await sb.from('profiles').insert({ id: uid, full_name: meta.full_name || (u.email || '').split('@')[0],
      role: meta.role === 'recruiter' ? 'recruiter' : 'seeker' }).select().maybeSingle();
    p = data;
  }
  state.profile = p;
  const { data: s } = await sb.from('saved_opportunities').select('opportunity_id').eq('user_id', uid);
  state.saved = new Set((s || []).map(r => r.opportunity_id));
}

function renderHeader() {
  const h = location.hash || '#/';
  const cur = (p, exact) => (h === p || h.startsWith(p + '?') || (!exact && p !== '#/' && h.startsWith(p + '/'))) ? ' aria-current="page"' : '';
  const links = [
    `<a href="#/"${cur('#/', true)}>Home</a>`,
    `<a href="#/explore"${cur('#/explore')}>Explore</a>`,
    state.session ? `<a href="#/dashboard"${cur('#/dashboard', true)}>My applications</a><a href="#/dashboard/saved"${cur('#/dashboard/saved')}>Saved</a>` : '',
    state.session ? `<a href="#/network"${cur('#/network')}>Network</a>` : '',
    isRecruiter() ? `<a href="#/manage"${cur('#/manage')}>My postings</a><a href="#/post"${cur('#/post')}>Post</a>` : '',
    state.session ? `<a href="#/profile"${cur('#/profile')}>Profile</a><button id="signout" type="button">Sign out</button>`
                  : `<a href="#/login"${cur('#/login')}>Sign in</a><a class="btn sm" href="#/signup">Create account</a>`,
  ].join('');
  $('#header').innerHTML = `<div class="wrap nav">
    <a class="brand" href="#/"><i></i>Opportunity Hub</a>
    <button class="btn ghost sm menu-btn" id="menu" aria-expanded="false" aria-controls="navlinks" aria-label="Open menu" type="button">Menu</button>
    <nav class="nav-links" id="navlinks" aria-label="Main">${links}</nav></div>`;
}

/* ---------- shared UI ---------- */
function oppCard(o) {
  const saved = state.saved.has(o.id);
  return `<article class="card flat">
    <div class="tags"><span class="tag">${TYPES[o.type]}</span><span class="tag">${MODES[o.work_mode]}</span>${o.is_paid ? '<span class="tag paid">Paid</span>' : ''}${o.featured ? '<span class="tag warn">Featured</span>' : ''}</div>
    <h3><a href="#/opportunity/${o.id}">${esc(o.title)}</a></h3>
    <p class="org">${esc(o.organization)}${o.location ? ' · ' + esc(o.location) : ''}</p>
    <div class="tags">${(o.skills || []).slice(0, 4).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
    <div class="actions">${deadlineTag(o.deadline)}
      <button class="icon-btn" data-save="${o.id}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save'} ${esc(o.title)}">${saved ? 'Saved' : 'Save'}</button></div>
  </article>`;
}
const empty = (title, body, cta = '') => `<div class="empty"><h3>${esc(title)}</h3><p style="margin-inline:auto">${esc(body)}</p>${cta}</div>`;

/* ---------- views ---------- */
async function viewHome() {
  app.innerHTML = `<section class="hero"><div class="wrap hero-grid">
    <div>
      <h1>Find what's worth applying to before the deadline passes.</h1>
      <p class="lead">Jobs, internships, scholarships, fellowships and hackathons for students and early-career people, all in one searchable place.</p>
      <form class="search" id="homeSearch" role="search">
        <label for="hq" class="sr" style="position:absolute;left:-999px">Search opportunities</label>
        <input id="hq" name="q" placeholder="Try “data analyst”, “scholarship”, “React”…" autocomplete="off">
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="chips" aria-label="Browse by type">${Object.entries(TYPES).map(([k, v]) => `<a class="chip" href="#/explore?type=${k}">${v}s</a>`).join('')}</div>
    </div>
    <aside class="board" aria-label="Closing soon"><h2>Closing soon</h2><div id="soon"><div class="skeleton" style="min-height:220px;opacity:.25"></div></div></aside>
  </div></section>
  <section class="section wrap"><div class="row spread"><h2>Featured</h2><a href="#/explore">See all opportunities</a></div><div class="cards" id="featured"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></section>`;
  $('#homeSearch').addEventListener('submit', e => { e.preventDefault(); go('#/explore?q=' + encodeURIComponent($('#hq').value.trim())); });
  const nowIso = new Date().toISOString();
  const [soon, feat] = await Promise.all([
    sb.from('opportunities').select('id,title,organization,deadline').eq('status', 'published').gte('deadline', nowIso).order('deadline').limit(5),
    sb.from('opportunities').select('*').eq('status', 'published').eq('featured', true).order('created_at', { ascending: false }).limit(6),
  ]);
  $('#soon').innerHTML = soon.error ? '<p>Could not load deadlines.</p>' : (soon.data.length ? soon.data.map(o => {
    const n = Math.max(daysLeft(o.deadline), 0);
    return `<a class="stub" href="#/opportunity/${o.id}"><div class="stub-days">${n}<small>${n === 1 ? 'DAY' : 'DAYS'}</small></div><div><div class="stub-title">${esc(o.title)}</div><div class="stub-org">${esc(o.organization)}</div></div></a>`;
  }).join('') : '<p>No deadlines this week.</p>');
  $('#featured').innerHTML = feat.error ? empty('Could not load opportunities', 'Check that the SQL migrations have been run in Supabase.')
    : feat.data.length ? feat.data.map(oppCard).join('') : empty('Nothing featured yet', 'Run supabase/seed.sql for sample data, or post the first opportunity.');
}

async function viewExplore() {
  const p = qs(); const page = Math.max(parseInt(p.page || '1', 10), 1);
  app.innerHTML = `<div class="wrap"><div class="page-head"><h1 style="font-size:2.2rem">Explore opportunities</h1></div>
  <form class="filters" id="filters" role="search">
    <div class="search-wide"><label class="sr" style="position:absolute;left:-999px" for="fq">Keyword</label><input id="fq" name="q" placeholder="Title, company or skill" value="${esc(p.q || '')}"></div>
    <select name="type" aria-label="Type"><option value="">All types</option>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select name="mode" aria-label="Work mode"><option value="">Any mode</option>${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${p.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select name="paid" aria-label="Pay"><option value="">Paid or unpaid</option><option value="1" ${p.paid === '1' ? 'selected' : ''}>Paid only</option></select>
    <button class="btn" type="submit">Apply filters</button></form>
  <div id="results" class="cards"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="pager" id="pager"></div></div>`;
  $('#filters').addEventListener('submit', e => {
    e.preventDefault();
    const f = new URLSearchParams(new FormData(e.target)); for (const [k, v] of [...f]) if (!v) f.delete(k);
    go('#/explore' + (f.toString() ? '?' + f : ''));
  });
  let q = sb.from('opportunities').select('*', { count: 'exact' }).eq('status', 'published')
    .or(`deadline.is.null,deadline.gte.${new Date().toISOString()}`);
  if (p.type) q = q.eq('type', p.type);
  if (p.mode) q = q.eq('work_mode', p.mode);
  if (p.paid === '1') q = q.eq('is_paid', true);
  const term = (p.q || '').replace(/[,()%*\\]/g, ' ').trim();
  if (term) q = q.or(`title.ilike.%${term}%,organization.ilike.%${term}%,description.ilike.%${term}%,skills.cs.{${term.split(/\s+/)[0]}}`);
  const { data, count, error } = await q.order('featured', { ascending: false }).order('created_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1);
  if (error) return void ($('#results').innerHTML = empty('Could not load results', error.message));
  $('#results').innerHTML = data.length ? data.map(oppCard).join('') : empty('No matches', 'Try fewer filters or a broader keyword.', '<a class="btn ghost" href="#/explore">Clear filters</a>');
  const pages = Math.ceil((count || 0) / PAGE);
  const link = n => { const u = new URLSearchParams(p); u.set('page', n); return '#/explore?' + u; };
  $('#pager').innerHTML = pages > 1 ? `${page > 1 ? `<a class="btn ghost sm" href="${link(page - 1)}">Previous</a>` : ''}<span class="muted small">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn ghost sm" href="${link(page + 1)}">Next</a>` : ''}` : '';
}

async function viewDetail(id) {
  const { data: o, error } = await sb.from('opportunities').select('*').eq('id', id).maybeSingle();
  if (error || !o) return void (app.innerHTML = `<div class="wrap section">${empty('Opportunity not found', 'It may have been closed or removed.', '<a class="btn" href="#/explore">Browse opportunities</a>')}</div>`);
  let applied = null;
  if (state.session) {
    const { data } = await sb.from('applications').select('*').eq('opportunity_id', id).eq('applicant_id', state.session.user.id).maybeSingle();
    applied = data;
  }
  const closed = o.status !== 'published' || (daysLeft(o.deadline) !== null && daysLeft(o.deadline) < 0);
  const own = state.session && o.posted_by === state.session.user.id;
  const ext = safeUrl(o.apply_url);
  const saved = state.saved.has(o.id);
  document.title = `${o.title} — Opportunity Hub`;
  app.innerHTML = `<div class="wrap detail"><article>
    <p class="small"><a href="#/explore">Back to explore</a></p>
    <div class="tags"><span class="tag">${TYPES[o.type]}</span><span class="tag">${MODES[o.work_mode]}</span>${deadlineTag(o.deadline)}</div>
    <h1 style="font-size:clamp(1.8rem,4vw,2.6rem);margin-top:.6rem">${esc(o.title)}</h1>
    <p class="muted">${esc(o.organization)}${o.location ? ' · ' + esc(o.location) : ''}</p>
    <h2 style="font-size:1.2rem;margin-top:1.5rem">About this opportunity</h2>
    <p class="prose">${esc(o.description)}</p>
    ${o.skills?.length ? `<h2 style="font-size:1.2rem">Skills</h2><div class="tags">${o.skills.map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
  </article>
  <aside class="panel stack">
    <ul class="facts"><li><span>Pay</span><strong>${esc(money(o))}</strong></li><li><span>Category</span><strong>${esc(o.category || '—')}</strong></li>
      <li><span>Level</span><strong>${esc(o.experience_level)}</strong></li><li><span>Deadline</span><strong>${o.deadline ? fmtDate(o.deadline) : 'Rolling'}</strong></li></ul>
    ${applied ? `<div class="tag paid" style="text-align:center;padding:.5rem">Your application: ${APP_STATUS[applied.status]}</div>
        ${applied.status !== 'withdrawn' ? '<button class="btn ghost" id="withdraw" type="button">Withdraw application</button>' : ''}`
      : own ? '<p class="muted small">You posted this opportunity.</p>'
      : closed ? '<button class="btn" disabled>Applications closed</button>'
      : '<button class="btn" id="apply" type="button">Apply on Opportunity Hub</button>'}
    ${ext && !closed ? `<a class="btn ghost" href="${esc(ext)}" target="_blank" rel="noopener noreferrer">Visit official page</a>` : ''}
    <button class="icon-btn" data-save="${o.id}" aria-pressed="${saved}" type="button">${saved ? 'Saved' : 'Save for later'}</button>
  </aside></div>`;
  $('#apply')?.addEventListener('click', () => openApply(o));
  $('#withdraw')?.addEventListener('click', async () => {
    const { error } = await sb.from('applications').update({ status: 'withdrawn' }).eq('id', applied.id);
    error ? fail(error) : (toast('Application withdrawn'), viewDetail(id));
  });
}

function openApply(o) {
  if (!requireAuth()) return;
  const d = modal(`<h2>Apply to ${esc(o.title)}</h2><p class="muted small">${esc(o.organization)}</p>
    <form id="applyForm"><div class="field"><label for="cl">Cover letter <span class="muted">(optional)</span></label><textarea id="cl" name="cover" maxlength="5000" placeholder="Why are you a good fit?"></textarea></div>
    <div class="field"><label for="rf">Resume</label><input id="rf" type="file" accept=".pdf,.doc,.docx">
    <p class="hint">${state.profile?.resume_path ? 'Leave empty to use the resume saved on your profile.' : 'PDF or Word, up to 5 MB.'}</p></div>
    <div class="row spread"><button class="btn ghost" type="button" value="cancel" id="cancel">Cancel</button><button class="btn" type="submit">Submit application</button></div></form>`);
  $('#cancel', d).onclick = () => d.close();
  $('#applyForm', d).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      let path = state.profile?.resume_path || null;
      const file = $('#rf', d).files[0];
      if (file) path = await uploadResume(file);
      const { error } = await sb.from('applications').insert({ opportunity_id: o.id, applicant_id: state.session.user.id, cover_letter: new FormData(e.target).get('cover') || null, resume_path: path });
      if (error) throw error;
      d.close(); toast('Application submitted'); viewDetail(o.id);
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

async function uploadResume(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Resume must be 5 MB or smaller.');
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${state.session.user.id}/resume-${Date.now()}.${ext}`;
  const { error } = await sb.storage.from('resumes').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

function viewAuth(mode) {
  if (state.session) return go('#/dashboard');
  const signup = mode === 'signup';
  app.innerHTML = `<div class="wrap"><div class="auth panel">
    <h1 style="font-size:2rem">${signup ? 'Create your account' : 'Welcome back'}</h1>
    <form id="authForm" novalidate>
      ${signup ? `<div class="field"><label for="fn">Full name</label><input id="fn" name="name" required autocomplete="name"></div>
      <div class="seg" role="radiogroup" aria-label="I am a"><label><input type="radio" name="role" value="seeker" checked><span>I'm looking</span></label><label><input type="radio" name="role" value="recruiter"><span>I'm hiring</span></label></div>` : ''}
      <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" required minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}">
        ${signup ? '<p class="hint">At least 8 characters.</p>' : ''}</div>
      <button class="btn" style="width:100%" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="small" style="margin-top:1rem">${signup ? 'Already registered? <a href="#/login">Sign in</a>' : `New here? <a href="#/signup">Create an account</a> · <a href="#" id="forgot">Forgot password?</a>`}</p>
  </div></div>`;
  $('#forgot')?.addEventListener('click', async e => {
    e.preventDefault();
    const email = $('#em').value.trim();
    if (!email) return toast('Enter your email first.', true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    error ? fail(error) : toast('Password reset link sent. Check your inbox.');
  });
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target); const btn = e.submitter; btn.disabled = true;
    const email = f.get('email').trim(), password = f.get('password');
    if (password.length < 8) { toast('Password needs at least 8 characters.', true); btn.disabled = false; return; }
    const res = signup
      ? await sb.auth.signUp({ email, password, options: { data: { full_name: f.get('name').trim(), role: f.get('role') }, emailRedirectTo: location.origin + location.pathname } })
      : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (res.error) return fail(res.error);
    if (signup && !res.data.session) { toast('Check your email to confirm your account, then sign in.'); return go('#/login'); }
    const next = qs().next; go(next ? decodeURIComponent(next) : signup ? '#/dashboard/all?welcome=1' : '#/dashboard');
  });
}

async function viewDashboard(tab = 'applications') {
  if (!requireAuth()) return;
  const uid = state.session.user.id;
  app.innerHTML = `<div class="wrap"><div class="page-head"><h1 style="font-size:2.2rem">Hi, ${esc((state.profile?.full_name || '').split(' ')[0] || 'there')}</h1></div>
    ${qs().welcome ? '<div class="panel" style="margin-bottom:1.2rem;border-color:var(--brand-2)"><strong>Welcome to Opportunity Hub!</strong> <span class="muted">Here is every open opportunity to get you started. Complete your <a href="#/profile">profile</a> with skills to get better matches.</span></div>' : ''}<nav class="tabs" aria-label="Dashboard"><a href="#/dashboard" ${tab === 'applications' ? 'aria-current="page"' : ''}>Applications</a><a href="#/dashboard/saved" ${tab === 'saved' ? 'aria-current="page"' : ''}>Saved</a><a href="#/dashboard/all" ${tab === 'all' ? 'aria-current="page"' : ''}>All opportunities</a></nav><div id="dash"></div></div>`;
  if (tab === 'all') {
    const { data, error } = await sb.from('opportunities').select('*').eq('status', 'published')
      .or(`deadline.is.null,deadline.gte.${new Date().toISOString()}`).order('featured', { ascending: false }).order('created_at', { ascending: false }).limit(60);
    if (error) return fail(error);
    $('#dash').innerHTML = data.length ? `<p class="muted">${data.length} open opportunities. <a href="#/explore">Search and filter</a></p><div class="cards">${data.map(oppCard).join('')}</div>`
      : empty('No opportunities yet', 'Run db/sample_opportunities.sql in Supabase to add sample listings.');
    return;
  }
  if (tab === 'saved') {
    const { data, error } = await sb.from('saved_opportunities').select('created_at, opportunities(*)').eq('user_id', uid).order('created_at', { ascending: false });
    if (error) return fail(error);
    const rows = data.filter(r => r.opportunities);
    $('#dash').innerHTML = rows.length ? `<div class="cards">${rows.map(r => oppCard(r.opportunities)).join('')}</div>` : empty('Nothing saved yet', 'Tap Save on any opportunity to keep it here.', '<a class="btn" href="#/explore">Explore opportunities</a>');
  } else {
    const { data, error } = await sb.from('applications').select('*, opportunities(id,title,organization,deadline)').eq('applicant_id', uid).order('created_at', { ascending: false });
    if (error) return fail(error);
    $('#dash').innerHTML = data.length ? `<div class="list">${data.map(a => `<div class="item"><div><h3 style="margin:0"><a href="#/opportunity/${a.opportunities?.id}">${esc(a.opportunities?.title || 'Removed opportunity')}</a></h3>
      <span class="muted small">${esc(a.opportunities?.organization || '')} · applied ${fmtDate(a.created_at)}</span></div>
      <span class="tag ${a.status === 'accepted' || a.status === 'shortlisted' ? 'paid' : a.status === 'rejected' || a.status === 'withdrawn' ? 'bad' : ''}">${APP_STATUS[a.status]}</span></div>`).join('')}</div>`
      : empty('No applications yet', 'When you apply through Opportunity Hub, you can track every one here.', '<a class="btn" href="#/explore">Find something to apply to</a>');
    $('#dash').insertAdjacentHTML('beforeend', '<section style="margin-top:2.5rem"><div class="row spread"><h2>Picked for you</h2><button class="btn ghost sm" id="reshuffle" type="button">Shuffle</button></div><div class="cards" id="picks"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div></section>');
    const showPicks = async () => {
      const picks = await pickedForYou(6);
      $('#picks').innerHTML = picks.length ? picks.map(oppCard).join('') : empty('No opportunities yet', 'Run supabase/seed.sql for sample listings, or ask a recruiter to post some.');
    };
    $('#reshuffle').addEventListener('click', showPicks);
    showPicks();
  }
}

async function viewProfile() {
  if (!requireAuth()) return;
  const p = state.profile; if (!p) return void (app.innerHTML = '<div class="wrap section">Profile is still being created. Refresh in a moment.</div>');
  app.innerHTML = `<div class="wrap"><div class="page-head row">${p.avatar_url ? `<img class="avatar lg" src="${esc(p.avatar_url)}" alt="">` : `<div class="avatar lg">${esc(initials(p.full_name))}</div>`}
    <div><h1 style="font-size:2rem;margin:0">${esc(p.full_name || 'Your profile')}</h1><span class="tag">${esc(p.role)}</span></div></div>
    <form class="panel" id="pf" style="max-width:760px">
      <div class="grid2"><div class="field"><label for="a">Full name</label><input id="a" name="full_name" required maxlength="120" value="${esc(p.full_name)}"></div>
      <div class="field"><label for="b">Headline</label><input id="b" name="headline" maxlength="160" placeholder="Final-year CS student" value="${esc(p.headline)}"></div></div>
      <div class="field"><label for="c">About you</label><textarea id="c" name="bio" maxlength="2000">${esc(p.bio)}</textarea></div>
      <div class="grid2"><div class="field"><label for="d">Institution</label><input id="d" name="institution" value="${esc(p.institution)}"></div>
      <div class="field"><label for="e">Graduation year</label><input id="e" name="graduation_year" type="number" min="1990" max="2100" value="${esc(p.graduation_year)}"></div>
      <div class="field"><label for="f">Education level</label><select id="f" name="education_level">${['', 'High school', 'Diploma', 'Undergraduate', 'Postgraduate', 'PhD', 'Self-taught'].map(v => `<option ${p.education_level === v || (!p.education_level && !v) ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="g">Location</label><input id="g" name="location" value="${esc(p.location)}"></div></div>
      <div class="field"><label for="h">Skills</label><input id="h" name="skills" placeholder="Python, SQL, Figma" value="${esc((p.skills || []).join(', '))}"><p class="hint">Separate with commas.</p></div>
      <div class="grid2"><div class="field"><label for="i">LinkedIn</label><input id="i" name="linkedin_url" type="url" value="${esc(p.linkedin_url)}"></div>
      <div class="field"><label for="j">GitHub</label><input id="j" name="github_url" type="url" value="${esc(p.github_url)}"></div></div>
      <div class="field"><label for="k">Portfolio</label><input id="k" name="portfolio_url" type="url" value="${esc(p.portfolio_url)}"></div>
      <div class="grid2"><div class="field"><label for="av">Profile photo</label><input id="av" type="file" accept="image/png,image/jpeg,image/webp"><p class="hint">PNG, JPG or WebP, up to 2 MB.</p></div>
      <div class="field"><label for="rs">Resume</label><input id="rs" type="file" accept=".pdf,.doc,.docx"><p class="hint" id="rsHint">${p.resume_path ? 'A resume is saved. <a href="#" id="viewResume">Open it</a>. Uploading replaces it.' : 'PDF or Word, up to 5 MB.'}</p></div></div>
      <button class="btn" type="submit">Save profile</button></form></div>`;
  $('#viewResume')?.addEventListener('click', async e => { e.preventDefault(); await openResume(p.resume_path); });
  $('#pf').addEventListener('submit', async e => {
    e.preventDefault(); const btn = e.submitter; btn.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(e.target));
      const upd = { full_name: f.full_name.trim(), headline: f.headline || null, bio: f.bio || null, institution: f.institution || null, education_level: f.education_level || null,
        graduation_year: f.graduation_year ? +f.graduation_year : null, location: f.location || null, linkedin_url: safeUrl(f.linkedin_url) || null, github_url: safeUrl(f.github_url) || null,
        portfolio_url: safeUrl(f.portfolio_url) || null, skills: f.skills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30) };
      const av = $('#av').files[0];
      if (av) {
        if (av.size > 2 * 1024 * 1024) throw new Error('Photo must be 2 MB or smaller.');
        const path = `${p.id}/avatar-${Date.now()}.${av.type.split('/')[1]}`;
        const up = await sb.storage.from('avatars').upload(path, av, { contentType: av.type });
        if (up.error) throw up.error;
        upd.avatar_url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      }
      const rs = $('#rs').files[0];
      if (rs) upd.resume_path = await uploadResume(rs);
      const { data, error } = await sb.from('profiles').update(upd).eq('id', p.id).select().single();
      if (error) throw error;
      state.profile = data; toast('Profile saved'); viewProfile();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
async function openResume(path) {
  const { data, error } = await sb.storage.from('resumes').createSignedUrl(path, 120);
  error ? fail(error) : window.open(data.signedUrl, '_blank', 'noopener');
}

async function viewNetwork() {
  if (!requireAuth()) return;
  const me = state.session.user.id;
  app.innerHTML = `<div class="wrap"><div class="page-head"><h1 style="font-size:2.2rem">Your network</h1></div>
    <form class="search" id="ps" role="search" style="max-width:560px"><input name="q" aria-label="Search people" placeholder="Search people by name"><button class="btn" type="submit">Search</button></form>
    <div id="found" class="list" style="margin-bottom:2rem"></div><div id="net"></div></div>`;
  const { data: rels, error } = await sb.from('relationships').select('*, requester:profiles!relationships_requester_id_fkey(id,full_name,headline,avatar_url), addressee:profiles!relationships_addressee_id_fkey(id,full_name,headline,avatar_url)')
    .or(`requester_id.eq.${me},addressee_id.eq.${me}`).neq('status', 'declined').order('created_at', { ascending: false });
  if (error) return fail(error);
  const person = (u, extra = '') => `<div class="item"><div class="row">${u.avatar_url ? `<img class="avatar" src="${esc(u.avatar_url)}" alt="">` : `<div class="avatar">${esc(initials(u.full_name))}</div>`}<div><strong>${esc(u.full_name)}</strong><div class="muted small">${esc(u.headline || '')}</div></div></div><div class="row">${extra}</div></div>`;
  const incoming = rels.filter(r => r.status === 'pending' && r.addressee_id === me);
  const sent = rels.filter(r => r.status === 'pending' && r.requester_id === me);
  const conns = rels.filter(r => r.status === 'accepted');
  $('#net').innerHTML = `<h2>Requests</h2><div class="list">${incoming.length ? incoming.map(r => person(r.requester, `<button class="btn sm" data-rel="accepted" data-id="${r.id}">Accept</button><button class="btn ghost sm" data-rel="declined" data-id="${r.id}">Decline</button>`)).join('') : '<p class="muted">No pending requests.</p>'}</div>
    ${sent.length ? `<h2 style="margin-top:2rem">Sent</h2><div class="list">${sent.map(r => person(r.addressee, `<button class="btn ghost sm" data-rel="remove" data-id="${r.id}">Cancel</button>`)).join('')}</div>` : ''}
    <h2 style="margin-top:2rem">Connections (${conns.length})</h2><div class="list">${conns.length ? conns.map(r => person(r.requester_id === me ? r.addressee : r.requester, `<button class="btn ghost sm" data-rel="remove" data-id="${r.id}">Remove</button>`)).join('') : empty('No connections yet', 'Search for classmates, mentors and recruiters above.')}</div>`;
  const known = new Set(rels.flatMap(r => [r.requester_id, r.addressee_id]));
  $('#ps').addEventListener('submit', async e => {
    e.preventDefault();
    const t = new FormData(e.target).get('q').replace(/[,()%*\\]/g, ' ').trim(); if (t.length < 2) return toast('Type at least 2 letters.', true);
    const { data, error } = await sb.from('profiles').select('id,full_name,headline,avatar_url').ilike('full_name', `%${t}%`).neq('id', me).limit(10);
    if (error) return fail(error);
    $('#found').innerHTML = data.length ? data.map(u => person(u, known.has(u.id) ? '<span class="muted small">Already connected or pending</span>' : `<button class="btn sm" data-connect="${u.id}">Connect</button>`)).join('') : '<p class="muted">No one found with that name.</p>';
  });
}

async function viewPost(id) {
  if (!requireAuth()) return;
  if (!isRecruiter()) return void (app.innerHTML = `<div class="wrap section">${empty('Recruiter accounts only', 'Create a recruiter account to post opportunities.')}</div>`);
  let o = {};
  if (id) { const { data } = await sb.from('opportunities').select('*').eq('id', id).maybeSingle(); o = data || {}; }
  const sel = (name, map, cur) => `<select id="${name}" name="${name}">${Object.entries(map).map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  app.innerHTML = `<div class="wrap"><div class="page-head"><h1 style="font-size:2.2rem">${id ? 'Edit opportunity' : 'Post an opportunity'}</h1></div>
  <form class="panel" id="postForm" style="max-width:760px">
    <div class="grid2"><div class="field"><label for="title">Title</label><input id="title" name="title" required minlength="3" maxlength="160" value="${esc(o.title)}"></div>
    <div class="field"><label for="organization">Organization</label><input id="organization" name="organization" required maxlength="160" value="${esc(o.organization)}"></div>
    <div class="field"><label for="type">Type</label>${sel('type', TYPES, o.type || 'job')}</div>
    <div class="field"><label for="work_mode">Work mode</label>${sel('work_mode', MODES, o.work_mode || 'onsite')}</div>
    <div class="field"><label for="category">Category</label><input id="category" name="category" value="${esc(o.category)}" placeholder="Engineering, Design…"></div>
    <div class="field"><label for="location">Location</label><input id="location" name="location" value="${esc(o.location)}"></div></div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" required maxlength="10000" style="min-height:200px">${esc(o.description)}</textarea></div>
    <div class="grid2"><div class="field"><label for="salary_min">Pay from</label><input id="salary_min" name="salary_min" type="number" min="0" value="${esc(o.salary_min)}"></div>
    <div class="field"><label for="salary_max">Pay to</label><input id="salary_max" name="salary_max" type="number" min="0" value="${esc(o.salary_max)}"></div>
    <div class="field"><label for="currency">Currency</label><input id="currency" name="currency" maxlength="3" value="${esc(o.currency || 'INR')}"></div>
    <div class="field"><label for="deadline">Deadline</label><input id="deadline" name="deadline" type="date" value="${o.deadline ? o.deadline.slice(0, 10) : ''}"></div></div>
    <div class="field"><label for="skills">Skills</label><input id="skills" name="skills" placeholder="React, SQL" value="${esc((o.skills || []).join(', '))}"></div>
    <div class="field"><label for="apply_url">External apply link <span class="muted">(optional)</span></label><input id="apply_url" name="apply_url" type="url" value="${esc(o.apply_url)}"></div>
    <div class="field"><label><input type="checkbox" name="is_paid" ${o.is_paid === false ? '' : 'checked'}> Paid opportunity</label></div>
    <div class="field"><label for="status">Visibility</label>${sel('status', { published:'Published', draft:'Draft (only you)', closed:'Closed' }, o.status || 'published')}</div>
    <button class="btn" type="submit">${id ? 'Save changes' : 'Publish opportunity'}</button></form></div>`;
  $('#postForm').addEventListener('submit', async e => {
    e.preventDefault(); const btn = e.submitter; btn.disabled = true;
    const f = new FormData(e.target);
    const num = v => v === '' || v == null ? null : +v;
    const row = { title: f.get('title').trim(), organization: f.get('organization').trim(), description: f.get('description').trim(), type: f.get('type'), work_mode: f.get('work_mode'),
      category: f.get('category') || null, location: f.get('location') || null, salary_min: num(f.get('salary_min')), salary_max: num(f.get('salary_max')),
      currency: (f.get('currency') || 'INR').toUpperCase(), deadline: f.get('deadline') ? new Date(f.get('deadline') + 'T23:59:59').toISOString() : null,
      skills: f.get('skills').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20), apply_url: safeUrl(f.get('apply_url')) || null, is_paid: f.get('is_paid') === 'on', status: f.get('status') };
    const res = id ? await sb.from('opportunities').update(row).eq('id', id).select().single() : await sb.from('opportunities').insert({ ...row, posted_by: state.session.user.id }).select().single();
    btn.disabled = false;
    if (res.error) return fail(res.error);
    toast(id ? 'Changes saved' : 'Opportunity published'); go('#/manage');
  });
}

async function viewManage() {
  if (!requireAuth()) return;
  if (!isRecruiter()) return void go('#/dashboard');
  const { data, error } = await sb.from('opportunities').select('id,title,organization,status,deadline,created_at, applications(count)').eq('posted_by', state.session.user.id).order('created_at', { ascending: false });
  if (error) return fail(error);
  app.innerHTML = `<div class="wrap"><div class="page-head row spread"><h1 style="font-size:2.2rem;margin:0">My postings</h1><a class="btn" href="#/post">Post an opportunity</a></div>
    <div class="list">${data.length ? data.map(o => `<div class="item"><div><h3 style="margin:0">${esc(o.title)}</h3><span class="muted small">${esc(o.organization)} · ${o.status}</span></div>
      <div class="row"><a class="btn ghost sm" href="#/manage/${o.id}">${o.applications?.[0]?.count || 0} applicants</a><a class="btn ghost sm" href="#/post/${o.id}">Edit</a><button class="btn danger sm" data-del="${o.id}">Delete</button></div></div>`).join('')
      : empty('No postings yet', 'Post your first opportunity and applicants will appear here.', '<a class="btn" href="#/post">Post an opportunity</a>')}</div></div>`;
}

async function viewApplicants(id) {
  if (!requireAuth()) return;
  const [{ data: o }, { data: apps, error }] = await Promise.all([
    sb.from('opportunities').select('title').eq('id', id).maybeSingle(),
    sb.from('applications').select('*, profiles:applicant_id(id,full_name,headline,institution,skills,linkedin_url,portfolio_url)').eq('opportunity_id', id).neq('status', 'withdrawn').order('created_at', { ascending: false }),
  ]);
  if (error) return fail(error);
  app.innerHTML = `<div class="wrap"><div class="page-head"><p class="small"><a href="#/manage">Back to postings</a></p><h1 style="font-size:2rem">Applicants for ${esc(o?.title || '')}</h1></div>
    <div class="list">${apps.length ? apps.map(a => `<div class="item"><div style="min-width:240px;flex:1"><strong>${esc(a.profiles?.full_name)}</strong><div class="muted small">${esc(a.profiles?.headline || '')}${a.profiles?.institution ? ' · ' + esc(a.profiles.institution) : ''}</div>
      <div class="tags" style="margin-top:.4rem">${(a.profiles?.skills || []).slice(0, 5).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
      ${a.cover_letter ? `<details style="margin-top:.5rem"><summary>Cover letter</summary><p class="prose small">${esc(a.cover_letter)}</p></details>` : ''}</div>
      <div class="row">${a.resume_path ? `<button class="btn ghost sm" data-resume="${esc(a.resume_path)}">Resume</button>` : ''}
      <select data-status="${a.id}" aria-label="Status for ${esc(a.profiles?.full_name)}">${['submitted', 'under_review', 'shortlisted', 'accepted', 'rejected'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${APP_STATUS[s]}</option>`).join('')}</select></div></div>`).join('')
      : empty('No applicants yet', 'Share the listing to get more eyes on it.')}</div></div>`;
}

/* ---------- mobile menu ---------- */
function setMenu(open) {
  const n = $('#navlinks'), b = $('#menu'); if (!n || !b) return;
  n.classList.toggle('open', open);
  b.setAttribute('aria-expanded', open);
  b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  b.textContent = open ? 'Close' : 'Menu';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
document.addEventListener('click', e => { if (!e.target.closest('.nav')) setMenu(false); });

/* ---------- recommended (random) opportunities ---------- */
async function pickedForYou(n = 6) {
  const nowFilter = `deadline.is.null,deadline.gte.${new Date().toISOString()}`;
  const skills = state.profile?.skills || [];
  let pool = [];
  if (skills.length) {                                   // skill matches first
    const { data } = await sb.from('opportunities').select('*').eq('status', 'published').or(nowFilter).overlaps('skills', skills).limit(30);
    pool = data || [];
  }
  const { data: more } = await sb.from('opportunities').select('*').eq('status', 'published').or(nowFilter).order('created_at', { ascending: false }).limit(40);
  const seen = new Set(pool.map(o => o.id));
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  return [...shuffle(pool), ...shuffle((more || []).filter(o => !seen.has(o.id)))].slice(0, n);
}

/* ---------- global events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('button, a'); if (!t) return;
  if (t.id === 'signout') { await sb.auth.signOut(); return go('#/'); }
  if (t.id === 'menu') { setMenu(!$('#navlinks').classList.contains('open')); return; }
  if (t.closest('#navlinks')) setMenu(false);
  if (t.dataset.save) {
    e.preventDefault(); if (!requireAuth()) return;
    const id = t.dataset.save, on = state.saved.has(id), uid = state.session.user.id;
    const { error } = on ? await sb.from('saved_opportunities').delete().eq('user_id', uid).eq('opportunity_id', id)
                         : await sb.from('saved_opportunities').insert({ user_id: uid, opportunity_id: id });
    if (error) return fail(error);
    on ? state.saved.delete(id) : state.saved.add(id);
    document.querySelectorAll(`[data-save="${id}"]`).forEach(b => { b.setAttribute('aria-pressed', !on); b.textContent = !on ? 'Saved' : (b.closest('.card') ? 'Save' : 'Save for later'); });
    toast(on ? 'Removed from saved' : 'Saved');
    if (location.hash.startsWith('#/dashboard/saved') && on) route();
  }
  if (t.dataset.connect) {
    const { error } = await sb.from('relationships').insert({ requester_id: state.session.user.id, addressee_id: t.dataset.connect });
    error ? fail(error) : (toast('Request sent'), viewNetwork());
  }
  if (t.dataset.rel) {
    const r = t.dataset.rel;
    const { error } = r === 'remove' ? await sb.from('relationships').delete().eq('id', t.dataset.id) : await sb.from('relationships').update({ status: r }).eq('id', t.dataset.id);
    error ? fail(error) : viewNetwork();
  }
  if (t.dataset.del && confirm('Delete this opportunity and all of its applications? This cannot be undone.')) {
    const { error } = await sb.from('opportunities').delete().eq('id', t.dataset.del);
    error ? fail(error) : (toast('Opportunity deleted'), viewManage());
  }
  if (t.dataset.resume) openResume(t.dataset.resume);
});
document.addEventListener('change', async e => {
  const s = e.target.closest('[data-status]'); if (!s) return;
  const { error } = await sb.from('applications').update({ status: s.value }).eq('id', s.dataset.status);
  error ? fail(error) : toast('Status updated');
});

/* ---------- router ---------- */
async function route() {
  const hash = location.hash || '#/'; const path = hash.split('?')[0];
  document.title = 'Opportunity Hub — jobs, internships, scholarships and more';
  renderHeader(); loading();
  let m;
  try {
    if (path === '#/' || path === '#') await viewHome();
    else if (path === '#/explore') await viewExplore();
    else if ((m = path.match(/^#\/opportunity\/([\w-]+)$/))) await viewDetail(m[1]);
    else if (path === '#/login') viewAuth('login');
    else if (path === '#/signup') viewAuth('signup');
    else if (path === '#/dashboard') await viewDashboard('applications');
    else if (path === '#/dashboard/saved') await viewDashboard('saved');
    else if (path === '#/dashboard/all') await viewDashboard('all');
    else if (path === '#/profile') await viewProfile();
    else if (path === '#/network') await viewNetwork();
    else if (path === '#/post') await viewPost();
    else if ((m = path.match(/^#\/post\/([\w-]+)$/))) await viewPost(m[1]);
    else if (path === '#/manage') await viewManage();
    else if ((m = path.match(/^#\/manage\/([\w-]+)$/))) await viewApplicants(m[1]);
    else app.innerHTML = `<div class="wrap section">${empty('Page not found', 'That address does not exist.', '<a class="btn" href="#/">Go home</a>')}</div>`;
  } catch (err) { fail(err); }
  setMenu(false); window.scrollTo(0, 0); app.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

sb.auth.onAuthStateChange(async (event, session) => {
  const changed = (state.session?.user?.id) !== (session?.user?.id);
  state.session = session;
  if (event === 'PASSWORD_RECOVERY') {
    const pw = prompt('Enter a new password (8+ characters):');
    if (pw && pw.length >= 8) { const { error } = await sb.auth.updateUser({ password: pw }); error ? fail(error) : toast('Password updated'); }
  }
  if (changed || event === 'INITIAL_SESSION') { setTimeout(async () => { await loadProfile(); route(); }, 0); }
});
})();
