// Turns raw scan output into Pagewise data: page tree, page settings, issues (deterministic rules only).
// usage: node analyze.mjs <repoDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint } from './fingerprint.mjs';

const [repo, outDir] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(path.join(outDir, 'raw.json'), 'utf8'));
const pages = raw.pages.filter((p) => !p.error);
const REVIEW = !!raw.review;
const prodHost = (() => { try { return new URL(process.env.PAGEWISE_PRODUCTION_URL || raw.origin).host; } catch { return ''; } })();
const isProd = !REVIEW && /^prod/i.test(process.env.PAGEWISE_ENVIRONMENT || 'production');
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

const fileHint = (url) => { try { const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/[-_.][0-9a-f]{8,}(?=\.)/, ''); return name.length > 3 ? grep(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).slice(0, 1) : []; } catch { return []; } };

// ---------- links graph ----------
const inbound = new Map();
for (const p of pages) for (const l of p.links || []) if (l !== p.path) { if (!inbound.has(l)) inbound.set(l, new Set()); inbound.get(l).add(p.path); }

// ---------- issues ----------
const issues = []; // {id, kind, severity, title, detail, pages[], selector, file, hints[], expected}
let n = 0;
const add = (o) => issues.push({ id: 'i' + (++n), ...o });
const pl = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

const sitemapFile = ['app/sitemap.ts', 'app/sitemap.js', 'app/sitemap.xml', 'public/sitemap.xml', 'src/app/sitemap.ts'].find((f) => fs.existsSync(path.join(repo, f))) || 'the sitemap';
const robotsFile = ['app/robots.ts', 'app/robots.js', 'public/robots.txt', 'src/app/robots.ts'].find((f) => fs.existsSync(path.join(repo, f))) || 'robots.txt';
const linkHints = (target) => grep(`href=[{"'\`]*${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`#?]`).slice(0, 2);

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
  const noindex = /noindex/i.test(p.robots || '') || (!REVIEW && /noindex/i.test(p.xRobots || ''));
  if (!p.description) add({ kind: 'SEO', severity: 'high', title: 'Missing meta description', pages: [p.path], file, expected: 'A unique description of 70 to 160 characters' });
  else if (p.description.length < 70 || p.description.length > 165) add({ kind: 'SEO', severity: 'low', title: `Meta description is ${p.description.length} characters`, detail: `"${p.description}"`, pages: [p.path], file, expected: 'Between 70 and 160 characters' });
  if (p.title && p.title.length > 65) add({ kind: 'SEO', severity: 'low', title: `Title is ${p.title.length} characters, truncated in Google`, detail: `"${p.title}"`, pages: [p.path], file, expected: '65 characters max' });
  if (!p.canonical && !noindex) add({ kind: 'SEO', severity: 'medium', title: 'No canonical tag', pages: [p.path], file, expected: 'link rel="canonical" pointing to the page URL' });
  if ((p.h1 || []).length !== 1) add({ kind: 'SEO', severity: 'medium', title: `${(p.h1 || []).length} H1 headings on the page`, pages: [p.path], file, expected: 'Exactly one H1' });
  if (!p.inSitemap && !noindex && raw.site?.sitemapFound !== false) add({ kind: 'Indexing', severity: 'medium', title: 'Indexable page missing from the sitemap', pages: [p.path], file: sitemapFile, expected: 'Listed in the sitemap, or marked noindex' });
  // Orphans need the whole link graph: only judged on full scans.
  if (!raw.partial && !p.route.includes('[') && !(inbound.get(p.path)?.size) ) add({ kind: 'Structure', severity: noindex ? 'low' : 'medium', title: 'Orphan page: no internal links', detail: 'None of the scanned pages link to it. Visitors only find it if they know the URL.', pages: [p.path], file, expected: 'At least one link from the nav, the footer or a related page' });
}
if (!raw.partial) for (const [t, ps] of Object.entries(byTitle)) if (ps.length > 1) add({ kind: 'SEO', severity: 'high', title: 'Duplicate title across pages', detail: `"${t}"`, pages: ps, expected: 'A unique title per page' });
if (!raw.partial) for (const [d, ps] of Object.entries(byDesc)) if (ps.length > 1) add({ kind: 'SEO', severity: 'medium', title: `Same meta description on ${ps.length} pages`, detail: `"${d.slice(0, 120)}…"`, pages: ps, expected: 'A description specific to each page' });

// ---------- Indexing: what search engines are told, and whether it holds ----------
const site = raw.site || {};
const checked = site.checked || {};
const live0 = pages.filter((p) => !p.redirected);
const isNoindex = (p) => /noindex/i.test(p.robots || '') || (!REVIEW && /noindex/i.test(p.xRobots || ''));
if (site.robotsBlocksAll && !REVIEW) add({ kind: 'Indexing', severity: 'high', title: 'robots.txt blocks every search engine', detail: '"User-agent: *" is followed by "Disallow: /": no page of the site can be crawled.', pages: ['/'], file: robotsFile, expected: 'Disallow only private paths (/app, /api…), or nothing', rule: 'robots-blocks-all' });
const hidden = live0.filter(isNoindex);
if (isProd && live0.length >= 5 && hidden.length / live0.length > 0.5) add({ kind: 'Indexing', severity: 'high', title: `Most of the production site is set to noindex (${hidden.length} of ${live0.length} pages)`, detail: 'Usually a staging setting left on in production (a NOINDEX environment variable, a robots meta in the root layout, an X-Robots-Tag header).', pages: hidden.map((p) => p.path), hints: grep('noindex').slice(0, 2), expected: 'index on public pages in production; noindex only on previews', rule: 'site-noindex' });
else {
  const contradict = hidden.filter((p) => p.inSitemap);
  if (contradict.length) add({ kind: 'Indexing', severity: 'high', title: `Pages in the sitemap are set to noindex (${contradict.length})`, detail: 'The sitemap asks search engines to index them, the page tells them not to. One of the two is wrong.', pages: contradict.map((p) => p.path), file: sitemapFile, hints: grep('noindex').slice(0, 1), expected: 'Indexed and in the sitemap, or noindex and out of it', rule: 'sitemap-noindex' });
}
const smChecked = Object.entries(checked).filter(([, c]) => c.fromSitemap);
const smMissing = smChecked.filter(([, c]) => c.status === 404 || c.status === 410);
const smRedirect = smChecked.filter(([, c]) => c.chain?.length);
const smFailing = smChecked.filter(([, c]) => c.status === 0 || c.status >= 500);
const smNoindex = smChecked.filter(([, c]) => c.status === 200 && !REVIEW && /noindex/i.test(c.xRobots || ''));
const ex = (list) => list.slice(0, 5).map(([p, c]) => p + (c.chain?.length ? ' → ' + new URL(c.final).pathname : '')).join(' · ');
if (smMissing.length) add({ kind: 'Indexing', severity: 'high', title: `Sitemap lists ${pl(smMissing.length, 'page')} that do not exist`, detail: ex(smMissing), pages: smMissing.map(([p]) => p), file: sitemapFile, expected: 'Only URLs that answer 200', rule: 'sitemap-404' });
if (smRedirect.length) add({ kind: 'Indexing', severity: 'medium', title: `Sitemap lists ${pl(smRedirect.length, 'redirecting URL')}`, detail: ex(smRedirect), pages: smRedirect.map(([p]) => p), file: sitemapFile, expected: 'The final URL of each page, not the one that redirects', rule: 'sitemap-redirect' });
if (smFailing.length) add({ kind: 'Indexing', severity: 'medium', title: `Sitemap URLs failing (${smFailing.length})`, detail: smFailing.slice(0, 5).map(([p, c]) => `${p} ${c.status || 'no answer'}`).join(' · '), pages: smFailing.map(([p]) => p), file: sitemapFile, expected: 'Every sitemap URL answers 200', rule: 'sitemap-error' });
if (smNoindex.length) add({ kind: 'Indexing', severity: 'high', title: `Sitemap URLs sent with a noindex header (${smNoindex.length})`, detail: ex(smNoindex), pages: smNoindex.map(([p]) => p), file: sitemapFile, expected: 'No X-Robots-Tag noindex on pages listed in the sitemap', rule: 'sitemap-noindex-header' });
const otherHosts = Object.entries(site.sitemapHosts || {}).filter(([h]) => h !== prodHost);
if (otherHosts.length && !REVIEW) add({ kind: 'Indexing', severity: 'high', title: `Sitemap lists URLs on another domain: ${otherHosts.map(([h]) => h).join(', ')}`, detail: otherHosts.map(([h, n]) => `${pl(n, 'URL')} on ${h}`).join(' · ') + `. Search engines ignore sitemap URLs outside ${prodHost}.`, pages: ['/'], file: sitemapFile, hints: grep(otherHosts[0][0].replace(/\./g, '\\.')).slice(0, 2), expected: `Every URL on https://${prodHost}`, rule: 'sitemap-host' });
if (site.sitemapFound === false && !raw.partial) add({ kind: 'Indexing', severity: 'medium', title: 'No sitemap found', detail: 'Neither robots.txt nor /sitemap.xml points to one.', pages: ['/'], expected: 'app/sitemap.ts, declared in robots.txt', rule: 'no-sitemap' });
// Internal links, grouped by target: one broken target is one fix, wherever it is linked from.
for (const [target, c] of Object.entries(checked)) {
  if (!c.from?.length) continue;
  if (c.status === 404 || c.status === 410) add({ kind: 'Indexing', severity: 'high', title: `Broken link to ${target}`, detail: `Linked from ${pl(c.from.length, 'page')}, answers ${c.status}.`, pages: c.from, selector: `a[href="${target}"]`, hints: linkHints(target), expected: 'Link to an existing page, or remove it', rule: 'broken-link' });
  else if (c.chain?.length && !target.startsWith('/api/')) {
    const fin = (() => { try { const u = new URL(c.final); return u.host === new URL(raw.origin).host ? u.pathname : c.final; } catch { return c.final; } })();
    add({ kind: 'Indexing', severity: 'low', title: `Links go through a redirect: ${target} → ${fin}`, detail: `Linked from ${pl(c.from.length, 'page')}.` + (c.chain.length > 1 ? ` ${c.chain.length} redirects in a row.` : ''), pages: c.from, selector: `a[href="${target}"]`, hints: linkHints(target), expected: `Link straight to ${fin}`, rule: 'link-redirect' });
  }
}
// Redirect chains (two hops or more) wherever they were met.
const chains = new Map();
for (const p of pages) if ((p.hops || []).length > 1) chains.set(p.path, [...p.hops.map((h) => new URL(h).pathname), p.finalPath]);
for (const [p, c] of Object.entries(checked)) if ((c.chain || []).length > 1) chains.set(p, [...c.chain.map((h) => new URL(h).pathname), (() => { try { return new URL(c.final).pathname; } catch { return c.final; } })()]);
for (const [p, ch] of chains) add({ kind: 'Indexing', severity: 'medium', title: `Redirect chain: ${ch.join(' → ')}`, detail: `${ch.length - 1} redirects before the page. Each one slows visitors and dilutes search ranking.`, pages: [p], hints: grep(ch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter((x) => /next\.config|vercel\.json|middleware|proxy/.test(x.file)).slice(0, 2), expected: `One redirect, straight to ${ch[ch.length - 1]}`, rule: 'redirect-chain' });
// Canonicals pointing elsewhere.
const canonOther = new Map(), canonPage = [];
for (const p of live0) {
  if (!p.canonical || isNoindex(p)) continue;
  let u; try { u = new URL(p.canonical); } catch { continue; }
  if (u.host !== prodHost) { if (!canonOther.has(u.host)) canonOther.set(u.host, []); canonOther.get(u.host).push(p.path); }
  else if ((u.pathname.replace(/\/$/, '') || '/') !== p.path && !p.route.includes('[')) canonPage.push([p.path, u.pathname]);
}
for (const [h, ps] of canonOther) add({ kind: 'Indexing', severity: 'high', title: `Canonical points to another domain: ${h}`, detail: `${pl(ps.length, 'page')} tell search engines that the real page lives on ${h}.`, pages: ps, hints: grep(h.replace(/\./g, '\\.')).slice(0, 2), expected: `Canonical on https://${prodHost}`, rule: 'canonical-host' });
if (canonPage.length) add({ kind: 'Indexing', severity: 'low', title: `Canonical points to another page on ${pl(canonPage.length, 'page')}`, detail: canonPage.slice(0, 5).map(([a, b]) => `${a} → ${b}`).join(' · ') + '. Fine for duplicates, a mistake for real pages: they will not appear in search.', pages: canonPage.map(([a]) => a), expected: 'Each page canonical to itself unless it duplicates another', rule: 'canonical-other' });

// ---------- Security: headers, transport, exposed files, secrets in client code, cookies before consent ----------
const secHint = (re) => ['next.config.ts', 'next.config.js', 'next.config.mjs', 'vercel.json', 'middleware.ts', 'proxy.ts', 'src/middleware.ts'].filter((f) => fs.existsSync(path.join(repo, f))).map((f) => {
  const lines = fs.readFileSync(path.join(repo, f), 'utf8').split('\n'); const n = lines.findIndex((l) => re.test(l));
  return n >= 0 ? { file: f, line: n + 1, code: lines[n].trim().slice(0, 140) } : null;
}).filter(Boolean).slice(0, 2);
const headerWhere = () => { const h = secHint(/headers\s*\(|"headers"|\.headers\.set/); return h.length ? h : secHint(/./).slice(0, 1).map((x) => ({ ...x, line: 1, code: 'add a headers() entry for all routes' })); };
if (isProd) {
  const withHdr = live0.filter((p) => p.headers && p.status === 200);
  const missing = (name, test = (v) => !!v) => withHdr.filter((p) => !test(p.headers[name], p.headers)).map((p) => p.path);
  const site = (ps) => (ps.length === withHdr.length ? 'every page' : `${pl(ps.length, 'page')}`);
  const sec = site;
  const hsts = missing('strict-transport-security', (v) => v && (+(v.match(/max-age=(\d+)/i)?.[1] || 0)) >= 15552000);
  if (hsts.length) add({ kind: 'Security', severity: 'medium', title: `HSTS missing or shorter than 6 months on ${sec(hsts)}`, detail: 'Strict-Transport-Security tells browsers to always use HTTPS, so a first visit cannot be downgraded.', pages: hsts, hints: headerWhere(), expected: 'Strict-Transport-Security: max-age=63072000; includeSubDomains; preload', rule: 'hsts' });
  const csp = (h) => h['content-security-policy'] || '';
  const noCsp = withHdr.filter((p) => !csp(p.headers)).map((p) => p.path);
  if (noCsp.length) { const ro = withHdr.filter((p) => !csp(p.headers) && p.headers['content-security-policy-report-only']).length;
    add({ kind: 'Security', severity: 'medium', title: `No Content-Security-Policy on ${sec(noCsp)}`, detail: (ro ? 'Only a report-only policy is sent, so nothing is enforced. ' : '') + 'A CSP limits which scripts can run, the main defence against injected scripts (XSS).', pages: noCsp, hints: headerWhere(), expected: "Content-Security-Policy with at least default-src 'self', script-src with nonces or hashes, frame-ancestors 'self', object-src 'none'", rule: 'csp-missing' }); }
  const weak = withHdr.filter((p) => { const c = csp(p.headers); const src = (c.match(/script-src([^;]*)/) || c.match(/default-src([^;]*)/) || [])[1] || ''; return c && /'unsafe-inline'/.test(src) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(src); }).map((p) => p.path);
  if (weak.length) add({ kind: 'Security', severity: 'low', title: `CSP allows any inline script on ${sec(weak)}`, detail: "script-src has 'unsafe-inline' without nonces or hashes, so the policy does not stop injected scripts.", pages: weak, hints: secHint(/unsafe-inline/), expected: "Nonces or hashes for inline scripts (Next.js supports CSP nonces in middleware), no 'unsafe-inline'", rule: 'csp-unsafe-inline' });
  const frame = withHdr.filter((p) => !/frame-ancestors/.test(csp(p.headers)) && !/deny|sameorigin/i.test(p.headers['x-frame-options'] || '')).map((p) => p.path);
  if (frame.length) add({ kind: 'Security', severity: 'medium', title: `Pages can be framed by any site on ${sec(frame)}`, detail: 'Without X-Frame-Options or a CSP frame-ancestors rule, another site can load the page in a hidden frame and trick visitors into clicking (clickjacking).', pages: frame, hints: headerWhere(), expected: "X-Frame-Options: SAMEORIGIN, or CSP frame-ancestors 'self' (list the domains that may embed it, if any)", rule: 'clickjacking' });
  const sniff = missing('x-content-type-options', (v) => /nosniff/i.test(v || ''));
  if (sniff.length) add({ kind: 'Security', severity: 'low', title: `X-Content-Type-Options missing on ${sec(sniff)}`, detail: 'Browsers may guess file types and run a file as a script.', pages: sniff, hints: headerWhere(), expected: 'X-Content-Type-Options: nosniff', rule: 'nosniff' });
  const ref = missing('referrer-policy', (v) => v && !/unsafe-url|no-referrer-when-downgrade/i.test(v));
  if (ref.length) add({ kind: 'Security', severity: 'low', title: `No strict Referrer-Policy on ${sec(ref)}`, detail: 'Full URLs (with their query strings) can leak to the sites your pages link to.', pages: ref, hints: headerWhere(), expected: 'Referrer-Policy: strict-origin-when-cross-origin', rule: 'referrer-policy' });
  const perm = missing('permissions-policy');
  if (perm.length) add({ kind: 'Security', severity: 'low', title: `No Permissions-Policy on ${sec(perm)}`, detail: 'Embedded content can ask for the camera, microphone or location.', pages: perm, hints: headerWhere(), expected: 'Permissions-Policy: camera=(), microphone=(), geolocation=()', rule: 'permissions-policy' });
  const powered = withHdr.filter((p) => p.headers['x-powered-by']).map((p) => p.path);
  if (powered.length) add({ kind: 'Security', severity: 'low', title: `X-Powered-By header reveals the stack on ${sec(powered)}`, detail: `"${withHdr.find((p) => p.headers['x-powered-by']).headers['x-powered-by']}". Free information for anyone probing the site.`, pages: powered, hints: secHint(/poweredByHeader/), expected: 'poweredByHeader: false in next.config', rule: 'x-powered-by' });
}
const S = site.security || {};
if (S.httpRedirect && !(S.httpRedirect.status >= 300 && S.httpRedirect.status < 400 && /^https:/.test(S.httpRedirect.location || ''))) add({ kind: 'Security', severity: 'high', title: 'http:// does not redirect to https://', detail: `http://${prodHost}/ answers ${S.httpRedirect.status || 'nothing'} instead of redirecting.`, pages: ['/'], expected: '301 or 308 from http:// to https://', rule: 'https-redirect' });
const insecure = new Map();
for (const p of live0) for (const u of p.perf?.insecure || []) { if (!insecure.has(u)) insecure.set(u, []); insecure.get(u).push(p.path); }
if (insecure.size) add({ kind: 'Security', severity: 'high', title: `Insecure http:// resources on ${pl(new Set([...insecure.values()].flat()).size, 'page')}`, detail: [...insecure.keys()].slice(0, 4).join(' · ') + '. Browsers block or flag them (mixed content).', pages: [...new Set([...insecure.values()].flat())], hints: fileHint([...insecure.keys()][0]), expected: 'https:// for every image, script, style and frame', rule: 'mixed-content' });
for (const f of S.exposed || []) add({ kind: 'Security', severity: 'high', title: `${f} is publicly readable`, detail: f.startsWith('/.env') ? 'It holds environment variables, often API keys and database passwords. Rotate every secret it contains.' : f.startsWith('/.git') ? 'The git repository can be downloaded, with its whole history.' : 'This file should never be served.', pages: ['/'], expected: `${f} answers 404: remove it from public/ or block it`, rule: 'exposed-file', selector: f });
for (const a of S.adminLogin || []) add({ kind: 'Security', severity: 'low', title: `Admin login page reachable at ${a}`, detail: 'A public sign-in form on a predictable path draws password-guessing bots.', pages: ['/'], expected: 'Admin behind SSO or an allowlist, or on an unlisted path with rate limiting', rule: 'admin-path', selector: a });
if (S.cors && S.cors.allowOrigin === 'https://pagewise-cors-check.example' && /true/i.test(S.cors.credentials || '')) add({ kind: 'Security', severity: 'high', title: 'CORS trusts any website, with credentials', detail: 'The site echoes back any Origin and allows credentials: another site can read signed-in visitors’ responses.', pages: ['/'], hints: secHint(/Access-Control-Allow-Origin|allowOrigin|cors/i), expected: 'Access-Control-Allow-Origin limited to your own domains', rule: 'cors' });
else if (S.cors && S.cors.allowOrigin === '*') add({ kind: 'Security', severity: 'low', title: 'Pages allow cross-origin reads from any site', detail: 'Access-Control-Allow-Origin: * on HTML pages is rarely needed.', pages: ['/'], hints: secHint(/Access-Control-Allow-Origin/i), expected: 'No CORS header on pages, or your own domains only', rule: 'cors-wildcard' });
if ((S.sourceMaps || []).length) add({ kind: 'Security', severity: 'low', title: 'Source maps are public', detail: `${S.sourceMaps[0]}${S.sourceMaps.length > 1 ? ` and ${S.sourceMaps.length - 1} more` : ''}. Anyone can read the original source code of the front end.`, pages: ['/'], hints: secHint(/productionBrowserSourceMaps|sourcemap/i), expected: 'productionBrowserSourceMaps off, or maps uploaded to your error tracker only', rule: 'source-maps' });
const secretsBy = new Map();
for (const x of S.secrets || []) { if (!secretsBy.has(x.type)) secretsBy.set(x.type, []); secretsBy.get(x.type).push(x); }
for (const [type, xs] of secretsBy) add({ kind: 'Security', severity: /test/i.test(type) ? 'medium' : 'high', title: `${type} exposed in the site’s code`, detail: `${pl(xs.length, 'occurrence')}, for example ${xs[0].value} in ${xs[0].where.replace(raw.origin, '')}. Anyone can read it in the browser: move it to the server and rotate it now.`, pages: ['/'], hints: grep(type.includes('Supabase') ? 'SERVICE_ROLE|sb_secret' : type.includes('Stripe') ? 'sk_live|sk_test|STRIPE_SECRET' : 'NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN)').slice(0, 2), expected: 'Secrets only in server code and server-only environment variables (never NEXT_PUBLIC_)', rule: 'secret-exposed', selector: type });
// Cookies set before any consent (the scanner never answers banners).
const TRACKERS = [[/^_ga($|_)|^_gid$|^_gat/, 'Google Analytics'], [/^_gcl_/, 'Google Ads'], [/^(IDE|test_cookie|NID|ANID)$/, 'Google advertising'], [/^_fbp$|^_fbc$|^fr$/, 'Meta'], [/^_hj/, 'Hotjar'], [/^_clck$|^_clsk$|^MUID$|^CLID$/, 'Microsoft Clarity'], [/^_uet/, 'Microsoft Ads'], [/^li_|^bcookie$|^lidc$|^UserMatchHistory$|^AnalyticsSyncHistory$/, 'LinkedIn'], [/^_ttp$|^_tt_/, 'TikTok'], [/^hubspotutk$|^__hs/, 'HubSpot'], [/^ajs_/, 'Segment'], [/^mp_.*mixpanel/, 'Mixpanel'], [/^_pk_/, 'Matomo'], [/^intercom-/, 'Intercom'], [/^_scid|^sc_at$/, 'Snapchat'], [/^_pin_unauth$/, 'Pinterest'], [/^ph_.*_posthog$/, 'PostHog'], [/^amp_/, 'Amplitude']];
const tracked = new Map();
for (const p of live0) for (const c of p.cookies || []) { const t = TRACKERS.find(([re]) => re.test(c.name)); if (!t) continue; if (!tracked.has(t[1])) tracked.set(t[1], { names: new Set(), pages: new Set() }); tracked.get(t[1]).names.add(c.name); tracked.get(t[1]).pages.add(p.path); }
if (tracked.size && isProd) add({ kind: 'Security', severity: 'high', title: `Tracking cookies set before consent: ${[...tracked.keys()].join(', ')}`, detail: [...tracked].map(([k, v]) => `${k} (${[...v.names].slice(0, 3).join(', ')})`).join(' · ') + '. Pagewise never answers the cookie banner, so these were set without consent (GDPR / ePrivacy).', pages: [...new Set([...tracked.values()].flatMap((v) => [...v.pages]))], hints: grep('gtag|googletagmanager|fbq|hotjar|clarity').slice(0, 2), expected: 'Analytics and ad cookies only after the visitor accepts (consent mode, or load the tags after consent)', rule: 'cookies-before-consent' });
const firstParty = live0.flatMap((p) => (p.cookies || []).filter((c) => prodHost.endsWith(c.domain.replace(/^\./, ''))).map((c) => ({ ...c, page: p.path })));
const weakCookies = firstParty.filter((c) => !c.secure || !c.sameSite);
if (weakCookies.length && isProd) add({ kind: 'Security', severity: 'low', title: `Cookies without Secure or SameSite: ${[...new Set(weakCookies.map((c) => c.name))].slice(0, 4).join(', ')}`, detail: 'Cookies should only travel over HTTPS and not with requests from other sites.', pages: [...new Set(weakCookies.map((c) => c.page))], expected: 'Secure; SameSite=Lax (HttpOnly for session cookies)', rule: 'cookie-flags' });
const home = live0.find((p) => p.path === '/');
if (home && isProd && !(home.legal || []).some((l) => /privacy|confidentialit|datenschutz|privacidad/i.test(l.text + ' ' + l.href))) add({ kind: 'Security', severity: 'medium', title: 'No privacy policy link on the home page', detail: 'Visitors (and the GDPR) expect it one click away, usually in the footer.', pages: ['/'], file: routeInfo.get('/')?.file, expected: 'A privacy policy link in the footer of every page', rule: 'privacy-link' });

// ---------- Sharing: how each page looks when posted on X, LinkedIn or Slack ----------
const imgInfo = site.shareImages || {};
const pageFile = (pth) => routeInfo.get(pages.find((p) => p.path === pth)?.route)?.file;
const shareOf = (p) => {
  const s = p.share || {};
  const img = s.twImage || s.ogImage;
  const info = img ? imgInfo[img] || null : null;
  return { title: s.twTitle || s.ogTitle || p.title, description: s.twDescription || s.ogDescription || p.description, image: img && /^https?:/.test(img) ? img : null, imageRaw: img, info, card: s.card, siteName: s.ogSiteName, icon: s.icon, ogTitle: s.ogTitle, ogDescription: s.ogDescription };
};
const noImg = [], relImg = new Map(), broken = new Map(), small = new Map(), ratio = new Map(), heavy = new Map(), noCard = [], noOgText = [];
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
for (const p of live0) {
  if (isNoindex(p) && !p.share?.ogImage) continue;
  const sh = shareOf(p);
  if (!sh.imageRaw) noImg.push(p.path);
  else if (!sh.image) push(relImg, sh.imageRaw, p.path);
  else if (sh.info) {
    const i = sh.info;
    if (i.status !== 200 || !/^image\//.test(i.type || '')) push(broken, sh.image, p.path);
    else {
      if (i.w && i.h && (i.w < 600 || i.h < 315)) push(small, sh.image, p.path);
      else if (i.w && i.h && Math.abs(i.w / i.h - 1.91) > 0.3) push(ratio, sh.image, p.path);
      if (i.bytes > 5 * 1024 * 1024) push(heavy, sh.image, p.path);
    }
  }
  if (sh.image && !/summary_large_image/.test(sh.card || '')) noCard.push(p.path);
  if (!sh.ogTitle || !sh.ogDescription) noOgText.push(p.path);
}
const nm = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || u).slice(0, 50) || u; } catch { return String(u).slice(0, 50); } };
if (noImg.length) add({ kind: 'Sharing', severity: 'medium', title: `No share image on ${pl(noImg.length, 'page')}`, detail: 'Posted on X, LinkedIn or Slack, these pages show a bare link with no picture.', pages: noImg, file: noImg.length === 1 ? pageFile(noImg[0]) : undefined, expected: 'og:image of 1200×630 (an opengraph-image file next to the page works)', rule: 'og-image-missing' });
for (const [u, ps] of relImg) add({ kind: 'Sharing', severity: 'high', title: `Share image URL is relative: ${u.slice(0, 60)}`, detail: 'Social networks need a full https:// URL: they ignore this image.', pages: ps, hints: grep('metadataBase').slice(0, 1), expected: 'An absolute URL (set metadataBase in the root layout)', rule: 'og-image-relative' });
for (const [u, ps] of broken) add({ kind: 'Sharing', severity: 'high', title: `Share image does not load: ${nm(u)}`, detail: `${imgInfo[u]?.status || 'no answer'}${imgInfo[u]?.type ? ', ' + imgInfo[u].type : ''}. The preview falls back to no image.`, pages: ps, hints: fileHint(u), expected: 'The image answers 200 with an image content type', rule: 'og-image-broken', src: u });
for (const [u, ps] of small) add({ kind: 'Sharing', severity: 'medium', title: `Share image too small: ${nm(u)} (${imgInfo[u].w}×${imgInfo[u].h})`, detail: 'X and LinkedIn show small images as a thumbnail, or not at all.', pages: ps, hints: fileHint(u), expected: '1200×630', rule: 'og-image-small', src: u });
for (const [u, ps] of ratio) add({ kind: 'Sharing', severity: 'low', title: `Share image is not landscape 1.91:1: ${nm(u)} (${imgInfo[u].w}×${imgInfo[u].h})`, detail: 'X, LinkedIn and Slack crop it to 1.91:1.', pages: ps, hints: fileHint(u), expected: '1200×630', rule: 'og-image-ratio', src: u });
for (const [u, ps] of heavy) add({ kind: 'Sharing', severity: 'medium', title: `Share image over 5 MB: ${nm(u)}`, detail: 'X and LinkedIn drop images this heavy.', pages: ps, hints: fileHint(u), expected: 'Under 1 MB', rule: 'og-image-heavy', src: u });
if (noCard.length) add({ kind: 'Sharing', severity: 'medium', title: `No large card on X for ${pl(noCard.length, 'page')}`, detail: 'Without twitter:card = summary_large_image, X shows a small square thumbnail instead of the full image.', pages: noCard, hints: grep('twitter').slice(0, 1), expected: 'twitter:card set to summary_large_image', rule: 'twitter-card' });
if (noOgText.length) add({ kind: 'Sharing', severity: 'low', title: `Share title or description missing on ${pl(noOgText.length, 'page')}`, detail: 'Networks fall back to the page title and description, or show nothing (LinkedIn).', pages: noOgText, file: noOgText.length === 1 ? pageFile(noOgText[0]) : undefined, expected: 'og:title and og:description on every page', rule: 'og-text' });

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
// ---------- Performance (deterministic: weights, sizes and structure; timings only past generous limits) ----------
const live = pages.filter((p) => !p.redirected && p.perf);
const kb = (n) => Math.round(n / 1024);
const imgs = new Map();
for (const p of live) for (const im of p.perf.images || []) { const k = im.src.split('?')[0]; if (!imgs.has(k)) imgs.set(k, { ...im, pages: new Set() }); imgs.get(k).pages.add(p.path); }
for (const [src, im] of imgs) {
  const name = src.split('/').pop().slice(0, 60);
  if (im.bytes > 250 * 1024) add({ kind: 'Performance', severity: im.bytes > 800 * 1024 ? 'high' : 'medium', title: `Heavy image: ${name} (${kb(im.bytes)} KB)`, detail: `Loaded on ${pl(im.pages.size, 'page')}, shown ${im.shown}px wide.`, pages: [...im.pages], selector: im.sel, hints: fileHint(src), expected: 'Under 200 KB: compressed, WebP or AVIF, sized to how it is shown', rule: 'heavy-image', src });
  if (im.natural > 800 && im.natural > im.shown * 2.5) add({ kind: 'Performance', severity: 'low', title: `Oversized image: ${name}`, detail: `${im.natural}px wide for ${im.shown}px on screen.`, pages: [...im.pages], selector: im.sel, hints: fileHint(src), expected: `About ${im.shown * 2}px wide (srcset / sizes, or next/image with sizes)`, rule: 'oversized-image', src });
  if (im.noDims && !im.lazy) add({ kind: 'Performance', severity: 'low', title: `Image without width and height: ${name}`, detail: 'The page shifts when it loads, which also disturbs agents clicking on the page.', pages: [...im.pages], selector: im.sel, hints: fileHint(src), expected: 'width and height attributes, or a CSS aspect-ratio', rule: 'image-dimensions', src });
}
const blockers = new Map();
for (const p of live) for (const b of p.perf.blocking || []) { if (!blockers.has(b)) blockers.set(b, new Set()); blockers.get(b).add(p.path); }
for (const [src, ps] of blockers) add({ kind: 'Performance', severity: 'medium', title: `Render-blocking script: ${src.split('/').pop().slice(0, 50)}`, detail: 'Loaded in <head> without async or defer: the page waits for it before showing anything.', pages: [...ps], hints: fileHint(src), expected: 'async or defer, or next/script with strategy="afterInteractive"', rule: 'render-blocking', src });
const total = (p) => Object.values(p.perf.bytes).reduce((a, b) => a + b, 0);
const heavyPages = live.filter((p) => total(p) > 2.5 * 1024 * 1024);
if (heavyPages.length) add({ kind: 'Performance', severity: 'medium', title: `${pl(heavyPages.length, 'page')} weigh more than 2.5 MB`, detail: heavyPages.slice(0, 6).map((p) => `${p.path} ${kb(total(p))} KB`).join(' · '), pages: heavyPages.map((p) => p.path), expected: 'Under 2.5 MB per page (images, scripts and fonts included)', rule: 'page-weight' });
const jsPages = live.filter((p) => p.perf.bytes.script > 500 * 1024);
if (jsPages.length) add({ kind: 'Performance', severity: 'medium', title: `${pl(jsPages.length, 'page')} load more than 500 KB of JavaScript`, detail: jsPages.slice(0, 6).map((p) => `${p.path} ${kb(p.perf.bytes.script)} KB`).join(' · '), pages: jsPages.map((p) => p.path), expected: 'Under 500 KB of JavaScript: split heavy components, load them on demand', rule: 'js-weight' });
const shiftsBy = new Map();
for (const p of live) if (p.perf.cls > 0.1) { const top = Object.entries(p.perf.shifts || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'page'; if (!shiftsBy.has(top)) shiftsBy.set(top, { pages: [], max: 0 }); const g = shiftsBy.get(top); g.pages.push(p.path); g.max = Math.max(g.max, p.perf.cls); }
for (const [el, g] of shiftsBy) add({ kind: 'Performance', severity: g.max > 0.25 ? 'high' : 'medium', title: 'Layout shifts while the page loads', detail: `Cumulative layout shift up to ${g.max.toFixed(2)}, mostly caused by ${el}.`, pages: g.pages, selector: el, hints: hintsFor(el, null), expected: 'CLS under 0.1: reserve space for images, embeds and late content', rule: 'cls' });
const slow = live.filter((p) => p.perf.lcp > 4000);
if (slow.length) add({ kind: 'Performance', severity: 'low', title: `Main content shows late on ${pl(slow.length, 'page')}`, detail: slow.slice(0, 5).map((p) => `${p.path} ${(p.perf.lcp / 1000).toFixed(1)} s (${p.perf.lcpEl || 'element'})`).join(' · ') + '. Measured in CI, so compare between scans rather than to the second.', pages: slow.map((p) => p.path), expected: 'Largest contentful paint under 2.5 s', rule: 'lcp' });

// ---------- Agents: can an AI agent read and use the site? ----------
if (raw.site?.aiBlocked?.length) add({ kind: 'Agents', severity: 'high', title: `AI crawlers blocked in robots.txt: ${raw.site.aiBlocked.join(', ')}`, detail: 'These agents cannot read the site, so assistants will not cite or recommend it.', pages: ['/'], hints: grep('robots').filter((x) => /robots/.test(x.file)).slice(0, 1), expected: 'Allow the AI crawlers you want to be found by', rule: 'ai-blocked' });
if (raw.site && !raw.site.llmsTxt && !raw.partial) add({ kind: 'Agents', severity: 'low', title: 'No llms.txt', detail: 'A short index of the site for language models: what it is, its key pages.', pages: ['/'], expected: '/llms.txt listing the main pages with one line each', rule: 'llms-txt' });
const jsOnly = live.filter((p) => p.agents && p.agents.renderedText > 500 && (p.agents.rawText || 0) < p.agents.renderedText * 0.5);
if (jsOnly.length) add({ kind: 'Agents', severity: 'high', title: `Content only visible with JavaScript on ${pl(jsOnly.length, 'page')}`, detail: jsOnly.slice(0, 5).map((p) => `${p.path}: ${Math.round(100 * (p.agents.rawText || 0) / p.agents.renderedText)}% of the text in the HTML`).join(' · ') + '. Agents and crawlers that do not run JavaScript see an almost empty page.', pages: jsOnly.map((p) => p.path), expected: 'Text rendered on the server (server components, static generation)', rule: 'js-only-content' });
const fakes = new Map();
for (const p of live) for (const [k, n] of Object.entries(p.agents?.fakeButtons || {})) { if (!fakes.has(k)) fakes.set(k, { pages: new Set(), n: 0 }); const g = fakes.get(k); g.pages.add(p.path); g.n += n; }
for (const [k, g] of fakes) add({ kind: 'Agents', severity: 'medium', title: 'Clickable element that is not a button or a link', detail: `${k}: pointer cursor but no button, link or role, ${pl(g.n, 'time')}. Agents and keyboard users do not see it as something to click.`, pages: [...g.pages], selector: k, hints: hintsFor(k, null), expected: '<button> or <a href>, or role="button" with tabindex and keyboard support', rule: 'fake-button' });
const badLd = live.filter((p) => (p.agents?.jsonld || []).some((x) => !x.ok));
if (badLd.length) add({ kind: 'Agents', severity: 'high', title: 'Invalid structured data (JSON-LD)', detail: 'The JSON-LD block does not parse, so search engines and agents ignore it.', pages: badLd.map((p) => p.path), expected: 'Valid JSON in every application/ld+json script', rule: 'jsonld-invalid' });
const noLd = live.filter((p) => !p.route.includes('[') && !(p.agents?.jsonld || []).length);
if (noLd.length && !raw.partial) add({ kind: 'Agents', severity: 'low', title: `No structured data on ${pl(noLd.length, 'page')}`, detail: 'Structured data tells agents what a page is (product, article, FAQ, organisation).', pages: noLd.map((p) => p.path), expected: 'A JSON-LD block describing the page (Organization, Product, Article, FAQPage…)', rule: 'jsonld-missing' });

// fonts
const fonts = {};
for (const p of pages) for (const [f, c] of Object.entries(p.fonts || {})) fonts[f] = (fonts[f] || 0) + c;

// ---------- DESIGN.md: the rules an agent reads before touching the UI ----------
// Everything comes from what the live site uses, counted; nothing is invented. The most common variant becomes the
// rule, the others are listed as drift.
const toRgb = (v) => {
  v = String(v || '').trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map((c) => c + c).join(''); const n = (i) => parseInt(h.slice(i, i + 2), 16); return `${n(0)},${n(2)},${n(4)}` + (h.length === 8 && n(6) !== 255 ? ',' + +(n(6) / 255).toFixed(2) : ''); }
  m = v.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]; return `${m[1]},${m[2]},${m[3]}` + (a !== 1 ? ',' + +a.toFixed(2) : ''); }
  return null;
};
const hex = (rgb) => { const [r, g, b, a] = rgb.split(',').map(Number); return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('') + (a !== undefined ? ` at ${Math.round(a * 100)}%` : ''); };
const defs = new Map(); // token -> {file, line}
try {
  for (const l of execFileSync('grep', ['-rnoE', '--include=*.css', '-e', '--[a-zA-Z0-9-]+ *:', '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 5e7 }).split('\n')) {
    const m = l.match(/^\.\/(.+?):(\d+):(--[\w-]+)/); if (m && !m[1].includes('node_modules') && !defs.has(m[3])) defs.set(m[3], `${m[1]}:${m[2]}`);
  }
} catch {}
// Tokens the repo declares itself (framework internals such as --tw-* are left out when the repo has its own).
const tok = Object.entries(raw.tokens || {}).filter(([n, t]) => t.uses > 0 && Object.keys(t.values).length && !n.startsWith('--tw-') && (!defs.size || defs.has(n)));
const kindOf = (name, v) => toRgb(v) || /^(oklch|hsl|color-mix|lab|lch)\(/.test(v) ? 'colour' : /radius|round/.test(name) ? 'radius' : /font|family/.test(name) && !/size|weight/.test(name) ? 'font' : /space|gap|pad|margin|gutter|actions/.test(name) ? 'spacing' : /shadow/.test(name) ? 'shadow' : /size|text|leading|line/.test(name) ? 'type' : 'other';
const groups = {};
const colourToken = new Map(); // rgb -> token
for (const [name, t] of tok.sort((a, b) => b[1].uses - a[1].uses)) {
  const [scope, value] = Object.entries(t.values)[0];
  const k = kindOf(name, value);
  (groups[k] ||= []).push({ name, value, scope, uses: t.uses, def: defs.get(name) });
  const rgb = toRgb(value); if (rgb && !colourToken.has(rgb)) colourToken.set(rgb, name);
}
const sum = (key) => { const m = {}; for (const p of pages) for (const [k, n] of Object.entries(p.design?.[key] || {})) m[k] = (m[k] || 0) + n; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
const share = (list) => { const t = list.reduce((a, [, n]) => a + n, 0) || 1; return (n) => Math.round((100 * n) / t); };
const textC = sum('text'), bgC = sum('bg'), sizes = sum('size'), radii = sum('radius');
const fileCache = {};
let hardcoded = [];
try {
  const out = execFileSync('grep', ['-rnoE', '--include=*.css', '-e', '#[0-9a-fA-F]{3,8}\\b|rgba?\\([^)]*\\)', '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 5e7 });
  const byFile = new Map();
  for (const l of out.split('\n')) { const m = l.match(/^\.\/(.+?):(\d+):(.+)$/); if (!m || m[1].includes('node_modules')) continue; const line = execLine(m[1], +m[2]); if (/^\s*--/.test(line)) continue; if (!byFile.has(m[1])) byFile.set(m[1], { n: 0, first: `${m[1]}:${m[2]}`, sample: m[3] }); byFile.get(m[1]).n++; }
  hardcoded = [...byFile.entries()].sort((a, b) => b[1].n - a[1].n);
} catch {}
function execLine(file, n) { try { return (fileCache[file] ||= fs.readFileSync(path.join(repo, file), 'utf8').split('\n'))[n - 1] || ''; } catch { return ''; } }
const name = (rgb) => colourToken.get(rgb) ? `\`${colourToken.get(rgb)}\`` : 'no token';
const md = [];
const host = (() => { try { return new URL(raw.origin).host; } catch { return raw.origin; } })();
md.push(`# Design rules: ${host}`, '', `Measured by Pagewise on ${pages.length} pages of ${raw.origin} (${raw.scannedAt.slice(0, 10)}). Read this before changing any page. Every value below is what the site already uses most; when a change needs something new, add a token first.`, '');
md.push('## Rules', '');
md.push('- Colours, radii, spacing and fonts come from the tokens below (`var(--…)`), never from a literal value.');
if (designSystem?.variants?.length) { const v = designSystem.variants[0]; md.push(`- A primary action uses the primary button: background ${toRgb(designSystem.primary) ? hex(toRgb(designSystem.primary)) : designSystem.primary} (${name(toRgb(designSystem.primary))}), radius ${v.radius}, height ${v.height}, text ${v.size} weight ${v.weight}. Other variants below are drift unless they belong to a separate part of the site (app vs marketing).`); }
if (sizes.length) md.push(`- Text sizes: ${sizes.slice(0, 6).map(([s]) => s).join(', ')}. Use one of these before adding a new size.`);
md.push('- Body text contrast at least 4.5:1, large text 3:1.', '- One H1 per page; a title under 65 characters; a meta description of 70 to 160 characters; a canonical URL.', '- Every page has a share image of 1200×630 and twitter:card summary_large_image.', '- Images have alt text and width/height; links and buttons are real `<a href>` and `<button>` elements.');
const fail = issues.filter((i) => i.rule === 'color-contrast' && i.token);
if (fail.length) md.push(`- Do not use ${fail.map((i) => `\`${i.token}\``).join(', ')} for body text on light backgrounds: it fails contrast today.`);
md.push('');
const tokTable = (k, title, n = 24) => { const g = groups[k]; if (!g?.length) return; md.push(`## ${title}`, '', '| Token | Value | Uses | Declared in |', '|---|---|---|---|'); for (const t of g.slice(0, n)) md.push(`| \`${t.name}\` | \`${t.value.replace(/\|/g, '\\|')}\`${t.scope !== ':root' ? ` (${t.scope})` : ''} | ${t.uses} | ${t.def || '–'} |`); md.push(''); };
tokTable('colour', 'Colour tokens'); 
if (textC.length) { const pc = share(textC); md.push('### Text colours in use', '', '| Colour | Share of text | Token |', '|---|---|---|'); for (const [c, n] of textC.slice(0, 8)) { const r = toRgb(c); md.push(`| ${r ? hex(r) : c} | ${pc(n)}% | ${r ? name(r) : '–'} |`); } md.push(''); }
if (bgC.length) { const pc = share(bgC); md.push('### Backgrounds in use', '', '| Colour | Share | Token |', '|---|---|---|'); for (const [c, n] of bgC.slice(0, 6)) { const r = toRgb(c); md.push(`| ${r ? hex(r) : c} | ${pc(n)}% | ${r ? name(r) : '–'} |`); } md.push(''); }
md.push('## Typography', '');
const fontList = Object.entries(fonts).sort((a, b) => b[1] - a[1]).slice(0, 4);
if (fontList.length) md.push(`Fonts: ${fontList.map(([f, n], i) => `${f}${i === 0 ? ' (main)' : ''}`).join(', ')}.`, '');
if (sizes.length) { const pc = share(sizes); md.push('| Size | Share of text |', '|---|---|'); for (const [z, n] of sizes.slice(0, 8)) md.push(`| ${z} | ${pc(n)}% |`); md.push(''); }
tokTable('font', 'Font tokens'); tokTable('type', 'Type tokens', 16);
if (designSystem?.variants?.length) {
  md.push('## Buttons', '', '| | Radius | Height | Text | Pages | Example |', '|---|---|---|---|---|---|');
  designSystem.variants.slice(0, 6).forEach((v, i) => md.push(`| ${i === 0 ? '**Primary (rule)**' : 'Other variant'} | ${v.radius} | ${v.height} | ${v.size} / ${v.weight} | ${v.pages} | ${(v.texts[0] || '').replace(/\|/g, '')} |`));
  md.push('');
}
tokTable('radius', 'Radius tokens', 12);
if (radii.length) md.push(`Radii in use: ${radii.slice(0, 6).map(([r]) => r).join(', ')}.`, '');
tokTable('spacing', 'Spacing tokens', 16); tokTable('shadow', 'Shadow tokens', 8);
if (hardcoded.length) { md.push('## Hard-coded colours in the CSS', '', 'Literal colours outside token declarations. Replace them with the matching token when you touch these files.', '', '| File | Count | First one |', '|---|---|---|'); for (const [f, h] of hardcoded.slice(0, 10)) md.push(`| ${f} | ${h.n} | ${h.first} \`${h.sample}\` |`); md.push(''); }
const drift = issues.filter((i) => ['UI consistency', 'Accessibility'].includes(i.kind)).slice(0, 12);
if (drift.length) { md.push('## Known drift', '', 'Open Pagewise findings that break these rules today.', ''); for (const i of drift) md.push(`- ${i.title}${i.expected ? `: expected ${i.expected}` : ''}`); md.push(''); }
const designRules = md.join('\n');
fs.writeFileSync(path.join(outDir, 'DESIGN.md'), designRules);

const navCount = {};
for (const p of pages) if (!p.redirected) { const k = (p.navLinks || []).length; navCount[k] = (navCount[k] || 0) + 1; }


for (const i of issues) i.fingerprint = fingerprint(i);

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
    xRobots: p.xRobots, headers: p.headers || null, cookies: (p.cookies || []).map((c) => c.name), share: p.redirected ? null : (() => { const sh = shareOf(p); return { title: sh.title, description: sh.description, image: sh.image, w: sh.info?.w || null, h: sh.info?.h || null, ok: sh.info ? sh.info.status === 200 : null, card: sh.card || null, siteName: sh.siteName || null, icon: sh.icon || null }; })(),
    inSitemap: p.inSitemap, inbound: [...(inbound.get(p.path) || [])].length, outbound: (p.links || []).length, height: p.height,
    snapshot: !!p.snapshot, image: !!p.image, css: p.css || [], timing: p.timing,
    perf: p.perf ? { ttfb: p.perf.ttfb, lcp: p.perf.lcp, cls: p.perf.cls, requests: p.perf.requests, bytes: p.perf.bytes, thirdParty: (p.perf.thirdParty || []).length } : null,
    agents: p.agents ? { rawText: p.agents.rawText, renderedText: p.agents.renderedText, jsonld: (p.agents.jsonld || []).flatMap((x) => x.types) } : null,
    issues: pageIssues(p.path).map((i) => i.id),
  }])),
  issues, designSystem, designRules, fonts, navCount, agentReadiness: raw.site ? { llmsTxt: raw.site.llmsTxt, aiBlocked: raw.site.aiBlocked } : null,
};
fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(out));
const k = {}; issues.forEach((i) => (k[i.kind] = (k[i.kind] || 0) + 1));
console.log('issues', issues.length, k);
