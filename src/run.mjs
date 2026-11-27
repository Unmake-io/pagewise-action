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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRoutes } from './routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = (process.env.PAGEWISE_SITE_URL || '').replace(/\/$/, '');
const repo = path.resolve(process.env.PAGEWISE_REPO_DIR || process.env.GITHUB_WORKSPACE || '.');
const out = path.resolve(process.env.PAGEWISE_OUT || 'pagewise-report');
const mode = process.env.PAGEWISE_MODE || 'auto';
if (!site) { console.error('Pagewise: no site URL to scan.'); process.exit(1); }

// Which routes did this commit touch? A page file only affects its own route; anything shared
// (components, styles, layouts, lib, config) can affect every page, so it means a full scan.
function changedRoutes() {
  const base = process.env.PAGEWISE_BASE_SHA || 'HEAD~1';
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
  if (c && c.size === 0 && mode === 'auto') { console.log('Pagewise: nothing on the site changed in this commit, skipping.'); process.exit(0); }
  if (c && c.size) only = c;
}
console.log(only ? `Pagewise: incremental scan of ${only.size} route(s): ${[...only].join(', ')}` : 'Pagewise: full scan');

fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, ...(only ? { PAGEWISE_ONLY: [...only].join(',') } : {}) };
execFileSync(process.execPath, [path.join(here, 'scan.mjs'), repo, site, out], { stdio: 'inherit', env });
execFileSync(process.execPath, [path.join(here, 'analyze.mjs'), repo, out], { stdio: 'inherit', env });

const data = JSON.parse(fs.readFileSync(path.join(out, 'data.json'), 'utf8'));
const meta = { repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, environment: process.env.PAGEWISE_ENVIRONMENT || null, site, partial: !!only, routes: only ? [...only] : null };
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1));
const summary = `### Pagewise\n\n${data.stats.scanned} pages scanned on ${site}${only ? ` (incremental: ${[...only].join(', ')})` : ''}\n\n${data.issues.length} issues: ${Object.entries(data.issues.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(' · ')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

// Upload when a Pagewise API is configured; otherwise the workflow keeps the report as an artifact.
if (process.env.PAGEWISE_API_URL && process.env.PAGEWISE_TOKEN) {
  const res = await fetch(process.env.PAGEWISE_API_URL.replace(/\/$/, '') + '/api/scans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.PAGEWISE_TOKEN },
    body: JSON.stringify({ meta, data }),
  });
  if (!res.ok) { console.error('Pagewise: upload failed with status', res.status); process.exit(1); }
  console.log('Pagewise: report uploaded. Screenshots follow in the next step.');
}
