// Pagewise Action entry point.
// Decides what to scan (everything, or only the routes a commit touched), runs the scanner and the analysis,
// then sends the report to Pagewise when an API is configured. Pagewise never changes the scanned repo.
//
// env (set by action.yml):
//   PAGEWISE_SITE_URL   deployed site to scan (required)
//   PAGEWISE_REPO_DIR   checkout of the repo (default: GITHUB_WORKSPACE)
//   PAGEWISE_OUT        report folder (default: ./pagewise-report)
//   PAGEWISE_MODE       "auto" (incremental when safe), "full" or "incremental"
//   PAGEWISE_BASE_SHA   commit to diff against (default: HEAD~1)
//   PAGEWISE_API_URL, PAGEWISE_TOKEN   optional upload target
//   PAGEWISE_KIND       "auto" (from the GitHub event), "production" or "review"
//   PAGEWISE_PREVIEW_URL  preview URL, or a template with {branch} (Vercel branch URL), for reviews
//   GITHUB_TOKEN        lets a review comment on the pull request (needs pull-requests: write)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRoutes } from './routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const prodSite = (process.env.PAGEWISE_SITE_URL || '').replace(/\/$/, '');
const event = (() => { try { return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { return {}; } })();
const evName = process.env.GITHUB_EVENT_NAME || '';
// Production or preview? Taken from the deployment event, so one workflow serves both.
function detectKind() {
  const k = process.env.PAGEWISE_KIND || 'auto';
  if (k !== 'auto') return k;
  if (evName === 'deployment_status') return /^production$/i.test(event.deployment?.environment || '') ? 'production' : 'review';
  if (evName === 'status') return (event.branches || []).some((b) => b.name === event.repository?.default_branch) ? 'production' : 'review';
  if (evName === 'pull_request') return 'review';
  return 'production';
}
const kind = detectKind();
const branch = event.branches?.[0]?.name || event.deployment?.ref || event.pull_request?.head?.ref || process.env.GITHUB_HEAD_REF || '';
// Vercel's branch URL: <project>-git-<branch slug>-<team>.vercel.app (branch lowercased, other characters as dashes).
const slug = (b) => b.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function previewUrl() {
  const fromEvent = event.deployment_status?.environment_url || event.deployment_status?.target_url;
  if (evName === 'deployment_status' && fromEvent && !/vercel\.com\//.test(fromEvent)) return fromEvent;
  const t = process.env.PAGEWISE_PREVIEW_URL || '';
  return t.includes('{branch}') ? (branch ? t.replace('{branch}', slug(branch)) : '') : t;
}
const site = (kind === 'review' ? previewUrl() : prodSite).replace(/\/$/, '');
if (kind === 'review' && !site) { console.log('Pagewise: preview deployment, but no preview URL to scan. Set the preview-url input (for example https://myapp-git-{branch}-myteam.vercel.app). Skipping.'); process.exit(0); }
const repo = path.resolve(process.env.PAGEWISE_REPO_DIR || process.env.GITHUB_WORKSPACE || '.');
const out = path.resolve(process.env.PAGEWISE_OUT || 'pagewise-report');
const mode = process.env.PAGEWISE_MODE || 'auto';
if (!site) { console.error('Pagewise: no site URL to scan.'); process.exit(1); }

// Which routes did this commit touch? A page file only affects its own route; anything shared
// (components, styles, layouts, lib, config) can affect every page, so it means a full scan.
function changedRoutes() {
  let base = process.env.PAGEWISE_BASE_SHA || 'HEAD~1';
  if (kind === 'review' && !process.env.PAGEWISE_BASE_SHA) {
    // A preview is compared with production: what changed since the branch left the default branch.
    const def = event.repository?.default_branch || 'main';
    try {
      execFileSync('git', ['fetch', '--no-tags', '--filter=blob:none', '--quiet', 'origin', def], { cwd: repo, stdio: 'ignore' });
      base = execFileSync('git', ['merge-base', 'FETCH_HEAD', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    } catch { return null; }
  }
  let files;
  try { files = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return null; }
  if (!files.length) return new Set();
  const routes = readRoutes(repo);
  const hit = new Set();
  for (const f of files) {
    if (/\.(md|test\.[jt]sx?)$/.test(f) || f.startsWith('.github/') || f.startsWith('supabase/')) continue;
    const r = routes.find((x) => path.dirname(x.file) === path.dirname(f) && /\/page\.(tsx|ts|jsx|js|mdx)$|\/[^/]+\.(css|module\.css)$/.test('/' + f));
    if (!r) return null; // shared file: rescan everything
    hit.add(r.route);
  }
  return hit;
}

let only = null;
if (mode !== 'full') {
  const c = changedRoutes();
  if (c && c.size === 0 && mode === 'auto') { console.log(kind === 'review' ? 'Pagewise: this branch changes nothing on the site, skipping the review.' : 'Pagewise: nothing on the site changed in this commit, skipping.'); process.exit(0); }
  if (c && c.size) only = c;
}
console.log(kind === 'review' ? `Pagewise: review of ${site} against ${prodSite}` : `Pagewise: production scan of ${site}`);
console.log(only ? `Pagewise: incremental scan of ${only.size} route(s): ${[...only].join(', ')}` : 'Pagewise: full scan');

fs.mkdirSync(out, { recursive: true });
if (!process.env.PAGEWISE_ENVIRONMENT) process.env.PAGEWISE_ENVIRONMENT = kind === 'review' ? 'Preview' : 'Production';
const env = { ...process.env, PAGEWISE_KIND: kind, PAGEWISE_PRODUCTION_URL: prodSite, ...(only ? { PAGEWISE_ONLY: [...only].join(',') } : {}) };
execFileSync(process.execPath, [path.join(here, 'scan.mjs'), repo, site, out], { stdio: 'inherit', env });
execFileSync(process.execPath, [path.join(here, 'analyze.mjs'), repo, out], { stdio: 'inherit', env });

const data = JSON.parse(fs.readFileSync(path.join(out, 'data.json'), 'utf8'));
const meta = { repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, environment: process.env.PAGEWISE_ENVIRONMENT || null, site, partial: !!only, routes: only ? [...only] : null };
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1));
const summary = `### Pagewise\n\n${data.stats.scanned} pages scanned on ${site}${only ? ` (incremental: ${[...only].join(', ')})` : ''}\n\n${data.issues.length} issues: ${Object.entries(data.issues.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(' · ')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

// A preview is never stored as the project's state: it is compared with production and reported on the pull request.
if (kind === 'review') {
  const { review } = await import('./review.mjs');
  await review({ data, site, prodSite, only, repo, out, event });
  process.exit(0);
}

// Upload when a Pagewise API is configured; otherwise the workflow keeps the report as an artifact.
if (process.env.PAGEWISE_API_URL && process.env.PAGEWISE_TOKEN) {
  const api = process.env.PAGEWISE_API_URL.replace(/\/$/, '');
  const auth = { authorization: 'Bearer ' + process.env.PAGEWISE_TOKEN };
  const res = await fetch(api + '/api/scans', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ meta, data }) });
  if (!res.ok) { console.error('Pagewise: upload failed with status', res.status, await res.text()); process.exit(1); }
  const { scanId, uploads, css } = await res.json();
  console.log('Pagewise: report stored (scan ' + scanId + '). Uploading snapshots…');
  // Snapshots and stylesheets go straight to storage with one-time tokens; Pagewise only records where they landed.
  const { put } = await import('@vercel/blob');
  const pool = async (items, fn) => { let i = 0; await Promise.all(Array.from({ length: 8 }, async () => { while (i < items.length) await fn(items[i++]); })); };
  const cssUrl = {};
  await pool(Object.entries(css || {}), async ([hash, u]) => {
    try { cssUrl[hash] = (await put(u.pathname, fs.readFileSync(path.join(out, 'css', hash + '.css')), { access: 'public', token: u.clientToken, contentType: 'text/css', addRandomSuffix: false, allowOverwrite: true })).url; }
    catch (e) { console.warn('Pagewise: stylesheet upload failed', hash, String(e.message || e)); }
  });
  const captures = {};
  await pool(Object.entries(uploads || {}), async ([pagePath, u]) => {
    const id = data.pages[pagePath].id, c = {};
    try {
      if (u.html) {
        const f = path.join(out, 'snapshots', id + '.html');
        if (fs.existsSync(f)) {
          const html = fs.readFileSync(f, 'utf8').replace(/__PW_CSS__\/([0-9a-f]+)\.css/g, (m, h) => cssUrl[h] || m);
          c.html = (await put(u.html.pathname, html, { access: 'public', token: u.html.clientToken, contentType: 'text/html', addRandomSuffix: true })).url;
        }
      }
      const img = path.join(out, 'thumbs', id + '.jpg');
      if (u.image && fs.existsSync(img)) c.image = (await put(u.image.pathname, fs.readFileSync(img), { access: 'public', token: u.image.clientToken, contentType: 'image/jpeg', addRandomSuffix: true })).url;
    } catch (e) { console.warn('Pagewise: upload failed for', pagePath, String(e.message || e)); }
    if (c.html || c.image) captures[pagePath] = c;
  });
  const c = await fetch(api + '/api/scans/' + scanId + '/captures', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ captures }) });
  console.log('Pagewise: ' + Object.keys(captures).length + ' page snapshots saved' + (c.ok ? '.' : ' (recording them failed: ' + c.status + ').'));
}
