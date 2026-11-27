// Turns raw scan output into Pagewise data: page tree, page settings, issues (deterministic rules only).
// usage: node analyze.mjs <repoDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, outDir] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(path.join(outDir, 'raw.json'), 'utf8'));
const pages = raw.pages.filter((p) => !p.error);
const routeInfo = new Map(raw.routes.map((r) => [r.route, r]));

// ---------- source hints (grep, no AI) ----------
const grepCache = new Map();
function grep(pattern) {
  if (grepCache.has(pattern)) return grepCache.get(pattern);
  let out = [];
  try {
    out = execFileSync('grep', ['-rnE', '--include=*.css', '--include=*.tsx', '--include=*.ts', '-e', pattern, 'app', 'components', 'lib'], { cwd: repo, encoding: 'utf8', maxBuffer: 1e7 })
      .split('\n').filter(Boolean).slice(0, 3).map((l) => { const [f, n, ...rest] = l.split(':'); return { file: f, line: Number(n), code: rest.join(':').trim().slice(0, 140) }; });
  } catch { out = []; }
  grepCache.set(pattern, out);
  return out;
}
function hintsFor(selector, summary) {
  const hints = [];
  const classes = [...(selector || '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((c) => !/^(available|active|open)$/.test(c));
  for (const c of classes.slice(-2).reverse()) {
    const h = grep(`\\.${c}([^a-zA-Z0-9_-]|$)`).filter((x) => x.file.endsWith('.css'));
    if (h.length) { hints.push(...h.slice(0, 2)); break; }
  }
  const fg = summary && summary.match(/foreground color: (#[0-9a-f]{6})/i);
  if (fg && hints.length < 2) {
    const v = grep(`--[a-zA-Z0-9-]+: *${fg[1]}`).filter((x) => x.file.endsWith('.css'));
    hints.push(...(v.length ? v : grep(fg[1]).filter((x) => x.file.endsWith('.css'))).slice(0, 1));
  }
  return hints.slice(0, 2);
}

// ---------- links graph ----------
const inbound = new Map();
for (const p of pages) for (const l of p.links || []) if (l !== p.path) { if (!inbound.has(l)) inbound.set(l, new Set()); inbound.get(l).add(p.path); }

// ---------- issues ----------
const issues = []; // {id, kind, severity, title, detail, pages[], selector, file, hints[], expected}
let n = 0;
const add = (o) => issues.push({ id: 'i' + (++n), ...o });

// SEO + structure, per page
const byTitle = {}, byDesc = {};
for (const p of pages) {
  if (p.redirected) continue;
  if (p.title) (byTitle[p.title] ||= []).push(p.path);
  if (p.description) (byDesc[p.description] ||= []).push(p.path);
}
for (const p of pages) {
  const file = routeInfo.get(p.route)?.file;
  if (p.redirected) {
    add({ kind: 'Structure', severity: 'medium', title: `Route ${p.path} redirects to ${p.finalPath}`, detail: `${file} exists but renders nothing: it only redirects. If that is intended, a redirect in next.config or vercel.json is clearer; otherwise the page is dead.`, pages: [p.path], file, expected: 'Redirect declared in config, or the file removed' });
    continue;
  }
  const noindex = p.robots && /noindex/.test(p.robots);
  if (!p.description) add({ kind: 'SEO', severity: 'high', title: 'Missing meta description', pages: [p.path], file, expected: 'A unique description of 70 to 160 characters' });
  else if (p.description.length < 70 || p.description.length > 165) add({ kind: 'SEO', severity: 'low', title: `Meta description is ${p.description.length} characters`, detail: `"${p.description}"`, pages: [p.path], file, expected: 'Between 70 and 160 characters' });
  if (p.title && p.title.length > 65) add({ kind: 'SEO', severity: 'low', title: `Title is ${p.title.length} characters, truncated in Google`, detail: `"${p.title}"`, pages: [p.path], file, expected: '65 characters max' });
  if (!p.ogImage) add({ kind: 'SEO', severity: 'medium', title: 'Missing Open Graph image', detail: 'Shares on LinkedIn, X or Slack will show a preview with no image.', pages: [p.path], file, expected: 'og:image set (1200×630)' });
  if (!p.canonical && !noindex) add({ kind: 'SEO', severity: 'medium', title: 'No canonical tag', pages: [p.path], file, expected: 'link rel="canonical" pointing to the page URL' });
  if ((p.h1 || []).length !== 1) add({ kind: 'SEO', severity: 'medium', title: `${(p.h1 || []).length} H1 headings on the page`, pages: [p.path], file, expected: 'Exactly one H1' });
  if (!p.inSitemap && !noindex) add({ kind: 'SEO', severity: 'medium', title: 'Indexable page missing from the sitemap', pages: [p.path], file: 'app/sitemap.ts', expected: 'Listed in the sitemap, or marked noindex' });
  // Orphans need the whole link graph: only judged on full scans.
  if (!raw.partial && !p.route.includes('[') && !(inbound.get(p.path)?.size) ) add({ kind: 'Structure', severity: noindex ? 'low' : 'medium', title: 'Orphan page: no internal links', detail: 'None of the scanned pages link to it. Visitors only find it if they know the URL.', pages: [p.path], file, expected: 'At least one link from the nav, the footer or a related page' });
}
if (!raw.partial) for (const [t, ps] of Object.entries(byTitle)) if (ps.length > 1) add({ kind: 'SEO', severity: 'high', title: 'Duplicate title across pages', detail: `"${t}"`, pages: ps, expected: 'A unique title per page' });
if (!raw.partial) for (const [d, ps] of Object.entries(byDesc)) if (ps.length > 1) add({ kind: 'SEO', severity: 'medium', title: `Same meta description on ${ps.length} pages`, detail: `"${d.slice(0, 120)}…"`, pages: ps, expected: 'A description specific to each page' });

// Accessibility, grouped by rule + selector across pages
const axeGroups = new Map();
for (const p of pages) if (!p.redirected) for (const v of p.axe || []) for (const nd of (v.nodes || v.targets.map((t) => ({ t, s: v.sample })))) {
  const t = nd.t.replace(/\[[^\]]*\]/g, '').replace(/:nth-child\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
  const colors = (nd.s.match(/foreground color: (#\w+), background color: (#\w+)/) || []).slice(1).join('/');
  const key = v.id + '::' + t + '::' + colors;
  if (!axeGroups.has(key)) axeGroups.set(key, { v, selector: t, pages: new Set(), count: 0, summary: nd.s });
  const g = axeGroups.get(key); g.pages.add(p.path); g.count++;
}
const AXE_FR = { 'color-contrast': 'Low text contrast', label: 'Form field without a label', 'link-in-text-block': 'Link in text told apart by colour only', 'scrollable-region-focusable': 'Scrollable area not reachable by keyboard', 'nested-interactive': 'Interactive element nested in another', 'aria-prohibited-attr': 'aria-label not allowed on this element' };
const sevOf = (i) => (i === 'critical' || i === 'serious' ? 'high' : i === 'moderate' ? 'medium' : 'low');
// Contrast: one issue per foreground colour (usually one token), listing every element that uses it.
const byFg = new Map();
for (const g of axeGroups.values()) {
  if (g.v.id !== 'color-contrast') continue;
  const fg = g.summary?.match(/foreground color: (#\w+)/)?.[1] || '?';
  if (!byFg.has(fg)) byFg.set(fg, []);
  byFg.get(fg).push(g);
}
for (const [fg, gs] of [...byFg.entries()].sort((a, b) => new Set(b[1].flatMap((g) => [...g.pages])).size - new Set(a[1].flatMap((g) => [...g.pages])).size)) {
  const all = new Set(gs.flatMap((g) => [...g.pages]));
  const els = gs.sort((a, b) => b.pages.size - a.pages.size).map((g) => {
    const r = g.summary.match(/contrast of ([\d.]+)/)?.[1], bg = g.summary.match(/background color: (#\w+)/)?.[1], exp = g.summary.match(/Expected contrast ratio of ([\d.]+:1)/)?.[1];
    return { selector: g.selector, pages: [...g.pages], ratio: r, bg, expected: exp, hints: hintsFor(g.selector, null) };
  });
  const ratios = els.map((e) => parseFloat(e.ratio)).filter(Boolean);
  const token = grep(`--[a-zA-Z0-9-]+: *${fg}`).filter((x) => x.file.endsWith('.css'));
  const tokName = token[0]?.code.match(new RegExp(`(--[a-zA-Z0-9-]+): *${fg}`))?.[1];
  add({ kind: 'Accessibility', severity: 'high', title: `Text in ${tokName ? tokName + ' ' : ''}${fg} is too light`, detail: `${els.length} elements on ${all.size} pages, contrast ${Math.min(...ratios)} to ${Math.max(...ratios)}:1 depending on the background. Fixing the colour at its source fixes all of them at once.`, pages: [...all], color: fg, token: tokName, hints: token.slice(0, 1), elements: els, expected: 'Contrast ≥ 4.5:1 (body text) or 3:1 (large text)', rule: 'color-contrast' });
}
for (const g of [...axeGroups.values()].filter((g) => g.v.id !== 'color-contrast').sort((a, b) => b.pages.size - a.pages.size)) {
  const m1 = g.summary?.match(/contrast of ([\d.]+)/), m2 = g.summary?.match(/foreground color: (#\w+)/), m3 = g.summary?.match(/background color: (#\w+)/), m4 = g.summary?.match(/Expected contrast ratio of ([\d.]+:1)/);
  const ratio = m1 && m2 && m3 && m4 ? [null, m1[1], m2[1], m3[1], m4[1]] : null;
  add({ kind: 'Accessibility', severity: sevOf(g.v.impact), title: AXE_FR[g.v.id] || g.v.help, detail: ratio ? `${ratio[1]}:1 (${ratio[2]} on ${ratio[3]}), expected ${ratio[4]}` : g.v.help, pages: [...g.pages], selector: g.selector, hints: hintsFor(g.selector, g.summary), expected: ratio ? `Contrast ≥ ${ratio[4]}` : `axe rule "${g.v.id}" passes`, rule: g.v.id });
}

// UI consistency: primary buttons (most common filled, non-white colour), header variants
const sigs = new Map();
for (const p of pages) if (!p.redirected) for (const b of p.buttons || []) {
  if (b.bg === 'rgb(255, 255, 255)' || b.bg === 'rgba(0, 0, 0, 0)') continue;
  if (!sigs.has(b.bg)) sigs.set(b.bg, new Map());
  const k = `${b.radius}|${b.height}|${b.size}|${b.weight}`;
  const m = sigs.get(b.bg); if (!m.has(k)) m.set(k, { pages: new Set(), texts: new Set() });
  m.get(k).pages.add(p.path); m.get(k).texts.add(b.text.replace(/\s+/g, ' '));
}
const primaryBg = [...sigs.entries()].sort((a, b) => [...b[1].values()].reduce((s, x) => s + x.pages.size, 0) - [...a[1].values()].reduce((s, x) => s + x.pages.size, 0))[0];
let designSystem = null;
if (primaryBg) {
  const [bg, variants] = primaryBg;
  const sorted = [...variants.entries()].sort((a, b) => b[1].pages.size - a[1].pages.size);
  designSystem = { primary: bg, variants: sorted.map(([k, v]) => { const [radius, height, size, weight] = k.split('|'); return { radius, height, size, weight, pages: v.pages.size, texts: [...v.texts].slice(0, 3) }; }) };
  const refs = sorted.filter(([, v]) => v.pages.size >= 10);
  for (const [k, v] of sorted) {
    if (v.pages.size >= 10 || !refs.length) continue;
    const [radius, height, size] = k.split('|');
    const near = refs.map(([rk]) => rk.split('|')).sort((a, b) => Math.abs(parseFloat(a[1]) - parseFloat(height)) - Math.abs(parseFloat(b[1]) - parseFloat(height)))[0];
    add({ kind: 'UI consistency', severity: 'medium', title: 'Primary button off the site’s variants', detail: `"${[...v.texts][0]}": radius ${radius}, height ${height}, text ${size}. The site’s primary buttons use radius ${near[0]}, height ${near[1]}, text ${near[2]}.`, pages: [...v.pages], expected: `Radius ${near[0]}, height ${near[1]}, text ${near[2]} (colour ${bg})`, hints: grep('min-height: ?' + parseFloat(height) + 'px').filter((x) => x.file.endsWith('.css')).slice(0, 2) });
  }
}
const navCount = {};
for (const p of pages) if (!p.redirected) { const k = (p.navLinks || []).length; navCount[k] = (navCount[k] || 0) + 1; }

// fonts
const fonts = {};
for (const p of pages) for (const [f, c] of Object.entries(p.fonts || {})) fonts[f] = (fonts[f] || 0) + c;

// ---------- tree ----------
const pageIssues = (pathName) => issues.filter((i) => i.pages.includes(pathName));
const scanned = new Map(pages.map((p) => [p.path, p]));
const tree = [];
const statics = raw.routes.filter((r) => !r.dynamic).sort((a, b) => a.route.localeCompare(b.route));
const dyn = raw.routes.filter((r) => r.dynamic).sort((a, b) => a.route.localeCompare(b.route));
for (const r of statics) {
  const p = scanned.get(r.route);
  tree.push({ type: 'page', group: p?.redirected ? 'Redirects' : 'Static pages', route: r.route, file: r.file, path: r.route, title: p?.title || r.route, issues: p ? pageIssues(r.route).length : 0 });
}
for (const r of dyn) {
  const samples = raw.pages.filter((p) => p.route === r.route);
  tree.push({ type: 'collection', group: 'Dynamic pages', route: r.route, file: r.file, count: r.sitemapUrls.length, hasStaticParams: r.hasStaticParams, samples: samples.map((s) => ({ path: s.path, title: s.title, issues: pageIssues(s.path).length })), issues: samples.reduce((s, x) => s + pageIssues(x.path).length, 0) });
}

const out = {
  site: raw.origin, repo: process.env.GITHUB_REPOSITORY || path.basename(path.resolve(repo)), scannedAt: raw.scannedAt,
  stats: { routes: raw.routes.length + raw.privateRoutes.length, publicRoutes: raw.routes.length, privateRoutes: raw.privateRoutes.length, sitemapUrls: raw.sitemapCount, scanned: pages.length, issues: issues.length },
  tree, privateRoutes: raw.privateRoutes,
  pages: Object.fromEntries(pages.map((p) => [p.path, {
    path: p.path, route: p.route, file: routeInfo.get(p.route)?.file, id: p.id, status: p.status, finalPath: p.finalPath, redirected: p.redirected,
    title: p.title, description: p.description, canonical: p.canonical, robots: p.robots, ogTitle: p.ogTitle, ogImage: p.ogImage, lang: p.lang, h1: p.h1,
    inSitemap: p.inSitemap, inbound: [...(inbound.get(p.path) || [])].length, outbound: (p.links || []).length, height: p.height,
    issues: pageIssues(p.path).map((i) => i.id),
  }])),
  issues, designSystem, fonts, navCount,
};
fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(out));
const k = {}; issues.forEach((i) => (k[i.kind] = (k[i.kind] || 0) + 1));
console.log('issues', issues.length, k);
