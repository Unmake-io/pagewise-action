// Pagewise prototype scanner: repo routes x live site.
// usage: node scan.mjs <repoDir> <siteOrigin> <outDir>
// env: PAGEWISE_ONLY (comma-separated routes to rescan), PAGEWISE_SAMPLES, PAGEWISE_CONCURRENCY, PAGEWISE_CHROME, VERCEL_BYPASS_SECRET
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { readRoutes, matchRoute } from './routes.mjs';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const [repo, origin, outDir] = process.argv.slice(2);
const SAMPLES_PER_DYNAMIC = Number(process.env.PAGEWISE_SAMPLES || 4);
const CONCURRENCY = Number(process.env.PAGEWISE_CONCURRENCY || 4);
const ONLY = process.env.PAGEWISE_ONLY ? new Set(process.env.PAGEWISE_ONLY.split(',').filter(Boolean)) : null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 PagewiseBot/0.1 (+https://github.com/Unmake-io/pagewise)';
const HEADERS = process.env.VERCEL_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true' } : {};
const fetchOpts = { headers: { 'user-agent': UA, ...HEADERS } };
fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });

const routes = readRoutes(repo);
const pub = routes.filter((r) => !r.isPrivate);

// 1. Sitemaps
async function sitemapUrls(u, seen = new Set()) {
  if (seen.has(u)) return [];
  seen.add(u);
  const xml = await (await fetch(u, fetchOpts)).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/.test(xml)) {
    const all = [];
    for (const l of locs) all.push(...(await sitemapUrls(l, seen)));
    return all;
  }
  return locs;
}
const robots = await (await fetch(origin + '/robots.txt', fetchOpts)).text();
const smList = [...robots.matchAll(/Sitemap:\s*(\S+)/gi)].map((m) => m[1]);
const sitemap = new Set();
for (const s of smList.length ? smList : [origin + '/sitemap.xml']) for (const u of await sitemapUrls(s)) sitemap.add(u.replace(/\/$/, '') || u);

const norm = (u) => { const x = new URL(u, origin); return (x.pathname.replace(/\/$/, '') || '/'); };

// 2. Map sitemap URLs to routes
const byRoute = new Map(pub.map((r) => [r.route, { ...r, sitemapUrls: [] }]));
const unmatched = [];
for (const u of sitemap) {
  const r = matchRoute(pub, norm(u));
  if (r) byRoute.get(r.route).sitemapUrls.push(norm(u)); else unmatched.push(norm(u));
}

// 3. Pick pages to scan
const queue = [];
for (const r of byRoute.values()) {
  if (ONLY && !ONLY.has(r.route)) continue;
  if (!r.dynamic) queue.push({ route: r.route, path: r.route, inSitemap: r.sitemapUrls.includes(r.route) });
  else r.sitemapUrls.slice(0, SAMPLES_PER_DYNAMIC).forEach((p) => queue.push({ route: r.route, path: p, inSitemap: true }));
}

// 4. Scan
const browser = await puppeteer.launch({ executablePath: process.env.PAGEWISE_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
let idx = 0;
async function worker() {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  if (Object.keys(HEADERS).length) await page.setExtraHTTPHeaders(HEADERS);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  while (idx < queue.length) {
    const q = queue[idx++];
    const id = q.path === '/' ? 'home' : q.path.slice(1).replace(/[^a-z0-9]+/gi, '-');
    try {
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
      const resp = await page.goto(origin + q.path, { waitUntil: 'networkidle2', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 600));
      const finalPath = norm(page.url());
      const data = await page.evaluate((orig) => {
        const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
        const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(orig)).map((h) => { const u = new URL(h); return u.pathname.replace(/\/$/, '') || '/'; });
        const buttons = [...document.querySelectorAll('button, a[class*="btn"], a[class*="button"], [role="button"]')]
          .filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 24 && cs.visibility !== 'hidden' && cs.display !== 'none' && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0); })
          .slice(0, 60)
          .map((el) => { const cs = getComputedStyle(el); return { sig: [cs.backgroundColor, cs.borderTopLeftRadius, cs.fontSize, cs.fontWeight, cs.height].join(' | '), bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, size: cs.fontSize, weight: cs.fontWeight, height: cs.height, text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40) }; });
        const fonts = {};
        document.querySelectorAll('h1,h2,h3,p,a,button,li,span').forEach((el) => { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); fonts[f] = (fonts[f] || 0) + 1; });
        const header = document.querySelector('header');
        const navLinks = header ? [...header.querySelectorAll('a[href]')].map((a) => (a.innerText || '').trim()).filter(Boolean) : [];
        return {
          title: document.title || null,
          description: meta('meta[name="description"]'),
          canonical: document.querySelector('link[rel="canonical"]')?.href || null,
          robots: meta('meta[name="robots"]'),
          ogTitle: meta('meta[property="og:title"]'),
          ogImage: meta('meta[property="og:image"]'),
          lang: document.documentElement.lang || null,
          h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim().slice(0, 120)),
          imgNoAlt: [...document.querySelectorAll('img:not([alt])')].length,
          links: [...new Set(links)],
          buttons, fonts, navLinks,
          height: document.documentElement.scrollHeight,
        };
      }, origin);
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), nodes: v.nodes.slice(0, 8).map((n) => ({ t: n.target.join(' '), s: (n.failureSummary || '').split('\n').slice(0, 2).join(' ') })), sample: v.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ') }));
      });
      // Full-page capture: scroll through to trigger lazy content, then shoot the whole page.
      await page.evaluate(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
      await new Promise((r) => setTimeout(r, 500));
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 0.75 });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(outDir, 'thumbs', id + '.jpg'), type: 'jpeg', quality: 70, fullPage: true, captureBeyondViewport: true });
      results.push({ ...q, id, status: resp?.status() ?? 0, finalPath, redirected: finalPath !== q.path, ...data, axe });
      process.stdout.write('.');
    } catch (e) {
      results.push({ ...q, id, status: 0, error: String(e.message || e).slice(0, 200) });
      process.stdout.write('x');
    }
  }
  await page.close();
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();

fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ origin, partial: !!ONLY, scannedRoutes: ONLY ? [...ONLY] : null, scannedAt: new Date().toISOString(), routes: [...byRoute.values()], unmatched, sitemapCount: sitemap.size, privateRoutes: routes.filter((r) => r.isPrivate).map((r) => ({ route: r.route, file: r.file })), pages: results }, null, 1));
console.log('\nscanned', results.length, 'pages; sitemap', sitemap.size, 'urls; unmatched', unmatched.length);
