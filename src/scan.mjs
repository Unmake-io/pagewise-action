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
const CONCURRENCY = Number(process.env.PAGEWISE_CONCURRENCY || 6);
const MAX_CAPTURE_HEIGHT = 16000; // px: longer pages are captured down to this height
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
  else r.sitemapUrls.slice(0, SAMPLES_PER_DYNAMIC).forEach((p, k) => queue.push({ route: r.route, path: p, inSitemap: true, sameTemplate: k > 0 }));
}

// 4. Scan
const browser = await puppeteer.launch({ executablePath: process.env.PAGEWISE_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
const sheetUrls = new Set();
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
      const t0 = Date.now(), t = {};
      // Wait for the page to load, then give the network a short, capped chance to settle: sites that keep
      // polling (analytics, chat widgets) would otherwise hold every page for the whole timeout.
      const resp = await page.goto(origin + q.path, { waitUntil: 'load', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 1500 }).catch(() => {});
      t.load = Date.now() - t0;
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
      t.read = Date.now() - t0 - t.load;
      // Pages from the same dynamic route share their template: the accessibility audit runs on the first one only.
      // Pages from the same dynamic route share their template: the costly colour-contrast rule runs on the first
      // one only; every other rule still runs on each page, since content (links, tables, code blocks) differs.
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async (same) => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: same ? { 'color-contrast': { enabled: false } } : {}, resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), nodes: v.nodes.slice(0, 8).map((n) => ({ t: n.target.join(' '), s: (n.failureSummary || '').split('\n').slice(0, 2).join(' ') })), sample: v.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ') }));
      }, !!q.sameTemplate);
      t.axe = Date.now() - t0 - t.load - t.read;
      // Page snapshot: the DOM as the browser built it, without scripts, with its stylesheets kept aside (shared
      // across pages). The viewer renders it in a sandboxed iframe. Pages with canvas or video, which a snapshot
      // cannot show, also get an image capture.
      // No scrolling needed: lazy images keep their src in the snapshot and load when the viewer shows them.
      const snap = await page.evaluate(() => {
        const doc = document.documentElement.cloneNode(true);
        doc.querySelectorAll('script, noscript, iframe, link[rel=preload], link[rel=modulepreload], link[rel=prefetch]').forEach((n) => n.remove());
        // freeze lazy images and form state into attributes
        const live = [...document.images], copies = [...doc.querySelectorAll('img')];
        copies.forEach((img, i) => { const src = live[i]?.currentSrc; if (src) { img.setAttribute('src', src); img.removeAttribute('srcset'); img.removeAttribute('loading'); } });
        const sheets = [...doc.querySelectorAll('link[rel=stylesheet]')].map((l) => { const href = new URL(l.getAttribute('href'), location.href).href; l.setAttribute('data-pw-css', href); return href; });
        const needsImage = !![...document.querySelectorAll('canvas, video')].find((el) => { const r = el.getBoundingClientRect(); return r.width > 120 && r.height > 80; });
        return { html: '<!DOCTYPE html>' + doc.outerHTML, sheets, needsImage, width: document.documentElement.scrollWidth };
      });
      const fullH = await page.evaluate(() => document.documentElement.scrollHeight);
      fs.mkdirSync(path.join(outDir, 'snapshots'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'snapshots', id + '.html'), snap.html);
      for (const href of snap.sheets) sheetUrls.add(href);
      if (snap.needsImage) {
        await page.evaluate(async (max) => { const h = Math.min(document.documentElement.scrollHeight, max); for (let y = 0; y < h; y += 1200) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); }, MAX_CAPTURE_HEIGHT);
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 0.75 });
        const shot = { path: path.join(outDir, 'thumbs', id + '.jpg'), type: 'jpeg', quality: 70, captureBeyondViewport: true };
        if (fullH > MAX_CAPTURE_HEIGHT) shot.clip = { x: 0, y: 0, width: 1280, height: MAX_CAPTURE_HEIGHT }; else shot.fullPage = true;
        await page.screenshot(shot);
      }
      t.capture = Date.now() - t0 - t.load - t.read - t.axe; t.total = Date.now() - t0;
      results.push({ ...q, id, status: resp?.status() ?? 0, finalPath, redirected: finalPath !== q.path, ...data, axe, timing: t, capturedHeight: Math.min(fullH, MAX_CAPTURE_HEIGHT), snapshot: true, image: snap.needsImage });
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

// Stylesheets: fetched once, url() made absolute, stored by content hash and linked from every snapshot.
const { createHash } = await import('node:crypto');
fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
const cssMap = {};
for (const href of sheetUrls) {
  try {
    const text = await (await fetch(href, fetchOpts)).text();
    const abs = text.replace(/url\((['"]?)(?!data:|https?:|#)([^'")]+)\1\)/g, (m, q, u) => `url(${q}${new URL(u, href).href}${q})`);
    const hash = createHash('sha1').update(abs).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(outDir, 'css', hash + '.css'), abs);
    cssMap[href] = hash;
  } catch { /* the snapshot keeps the original link */ }
}
for (const r of results) {
  if (!r.snapshot) continue;
  const f = path.join(outDir, 'snapshots', r.id + '.html');
  let html = fs.readFileSync(f, 'utf8');
  html = html.replace(/<link([^>]*?)data-pw-css="([^"]+)"([^>]*)>/g, (m, a, href, b) => cssMap[href] ? `<link rel="stylesheet" href="__PW_CSS__/${cssMap[href]}.css">` : m.replace(/href="[^"]*"/, `href="${href}"`));
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}${r.finalPath || r.path}">`);
  fs.writeFileSync(f, html);
  r.css = [...new Set([...html.matchAll(/__PW_CSS__\/([0-9a-f]+)\.css/g)].map((m) => m[1]))];
}

fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ origin, partial: !!ONLY, scannedRoutes: ONLY ? [...ONLY] : null, scannedAt: new Date().toISOString(), routes: [...byRoute.values()], unmatched, sitemapCount: sitemap.size, privateRoutes: routes.filter((r) => r.isPrivate).map((r) => ({ route: r.route, file: r.file })), pages: results }, null, 1));
const timed = results.filter((r) => r.timing).sort((a, b) => b.timing.total - a.timing.total);
const sum = (k) => Math.round(timed.reduce((n, r) => n + (r.timing[k] || 0), 0) / 1000);
console.log('\nscanned', results.length, 'pages; sitemap', sitemap.size, 'urls; unmatched', unmatched.length);
console.log(`browser time: load ${sum('load')}s · read ${sum('read')}s · axe ${sum('axe')}s · capture ${sum('capture')}s`);
console.log('slowest:', timed.slice(0, 5).map((r) => `${r.path} ${(r.timing.total / 1000).toFixed(1)}s`).join(', '));
