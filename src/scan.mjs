// Calque prototype scanner: repo routes x live site.
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
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 CalqueBot/0.1 (+https://github.com/Unmake-io/calque)';
const HEADERS = process.env.VERCEL_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true' } : {};
const fetchOpts = { headers: { 'user-agent': UA, ...HEADERS } };
// Review of a preview deployment: the site's own absolute URLs (sitemap, robots) point at production, so they are
// read on the preview instead, by path.
const REVIEW = process.env.PAGEWISE_KIND === 'review';
const here = (u) => { try { const x = new URL(u, origin); return REVIEW ? origin + x.pathname + x.search : x.href; } catch { return u; } };
fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });

const routes = readRoutes(repo);
const pub = routes.filter((r) => !r.isPrivate);

// 1. Sitemaps
async function sitemapUrls(u, seen = new Set()) {
  if (seen.has(u)) return [];
  seen.add(u);
  let xml = '';
  try { xml = await (await fetch(here(u), fetchOpts)).text(); } catch { return []; }
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/.test(xml)) {
    const all = [];
    for (const l of locs) all.push(...(await sitemapUrls(l, seen)));
    return all;
  }
  return locs;
}
let robots = '';
try { const r = await fetch(origin + '/robots.txt', fetchOpts); robots = r.ok ? await r.text() : ''; } catch {}
const smList = [...robots.matchAll(/Sitemap:\s*(\S+)/gi)].map((m) => m[1]);
const sitemap = new Set();
const sitemapHosts = new Map(); // host -> count, to catch a sitemap listing another domain (www, a preview, staging)
for (const s of smList.length ? smList : [origin + '/sitemap.xml']) for (const u of await sitemapUrls(s)) {
  sitemap.add(u.replace(/\/$/, '') || u);
  try { const h = new URL(u).host; sitemapHosts.set(h, (sitemapHosts.get(h) || 0) + 1); } catch {}
}

const norm = (u) => { const x = new URL(u, origin); return (x.pathname.replace(/\/$/, '') || '/'); };

// 2. Map sitemap URLs to routes
const byRoute = new Map(pub.map((r) => [r.route, { ...r, sitemapUrls: [] }]));
const unmatched = [];
for (const u of sitemap) {
  const r = matchRoute(pub, norm(u));
  if (r) byRoute.get(r.route).sitemapUrls.push(norm(u)); else unmatched.push(norm(u));
}

// 3. Pick pages to scan
const queue = []; queue.next = 0;
for (const r of byRoute.values()) {
  if (ONLY && !ONLY.has(r.route)) continue;
  if (!r.dynamic) queue.push({ route: r.route, path: r.route, inSitemap: r.sitemapUrls.includes(r.route) });
  else r.sitemapUrls.slice(0, SAMPLES_PER_DYNAMIC).forEach((p, k) => queue.push({ route: r.route, path: p, inSitemap: true, sameTemplate: k > 0 }));
}

// 4. Scan
const browser = await puppeteer.launch({ executablePath: process.env.PAGEWISE_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
const sheetUrls = new Set();
// Each worker takes pages from a list; signed-in pages use their own browser context holding the test account session.
async function worker(list = queue, ctx = browser, cookies = null) {
  const page = await ctx.newPage();
  if (cookies) await page.setCookie(...cookies);
  await page.setUserAgent(UA);
  if (Object.keys(HEADERS).length) await page.setExtraHTTPHeaders(HEADERS);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // Cookies: the scanner never answers a consent banner, so any cookie found here was set before consent.
  const cdp = await page.createCDPSession();
  const seenCookies = new Set();
  while (list.next < list.length) {
    const q = list[list.next++];
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
          legal: [...document.querySelectorAll('a[href]')].filter((a) => /privacy|confidentialit|datenschutz|privacidad|cookie|mentions|legal|impressum|terms|cgu|cgv/i.test((a.innerText || '') + ' ' + a.getAttribute('href'))).slice(0, 12).map((a) => ({ text: (a.innerText || '').trim().slice(0, 40), href: a.href })),
          share: {
            ogTitle: meta('meta[property="og:title"]'), ogDescription: meta('meta[property="og:description"]'),
            ogImage: meta('meta[property="og:image"]'), ogImageRaw: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
            ogImageW: Number(meta('meta[property="og:image:width"]')) || null, ogImageH: Number(meta('meta[property="og:image:height"]')) || null,
            ogUrl: meta('meta[property="og:url"]'), ogSiteName: meta('meta[property="og:site_name"]'), ogType: meta('meta[property="og:type"]'),
            card: meta('meta[name="twitter:card"]'), twTitle: meta('meta[name="twitter:title"]'), twDescription: meta('meta[name="twitter:description"]'), twImage: meta('meta[name="twitter:image"]'),
            icon: document.querySelector('link[rel~="icon"]')?.href || null,
          },
          lang: document.documentElement.lang || null,
          h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim().slice(0, 120)),
          imgNoAlt: [...document.querySelectorAll('img:not([alt])')].length,
          links: [...new Set(links)],
          buttons, fonts, navLinks,
          height: document.documentElement.scrollHeight,
          design: (() => {
            // What the page actually uses, counted on visible elements: the raw material for DESIGN.md.
            const text = {}, bg = {}, size = {}, radius = {}, inc = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
            let n = 0;
            for (const el of document.body.querySelectorAll('*')) {
              if (++n > 4000) break;
              const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
              const cs = getComputedStyle(el);
              const ownText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
              if (ownText) { inc(text, cs.color); inc(size, cs.fontSize); }
              if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') inc(bg, cs.backgroundColor);
              if (parseFloat(cs.borderTopLeftRadius) > 0 && r.width > 16) inc(radius, cs.borderTopLeftRadius);
            }
            return { text, bg, size, radius };
          })(),
        };
      }, origin);
      // Performance and agent-readiness, read from what this load already produced (no extra page load).
      const extra = await page.evaluate(async (orig) => {
        const sel = (el) => { if (!el || !el.tagName) return ''; const c = [...(el.classList || [])].slice(0, 2).join('.'); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : ''); };
        const buffered = (type, fn) => new Promise((res) => { try { const o = new PerformanceObserver((l) => fn(l.getEntries())); o.observe({ type, buffered: true }); setTimeout(() => { o.disconnect(); res(); }, 60); } catch { res(); } });
        let lcp = 0, lcpEl = '', cls = 0; const shifts = {};
        await buffered('largest-contentful-paint', (es) => { for (const e of es) { lcp = e.startTime; lcpEl = sel(e.element); } });
        await buffered('layout-shift', (es) => { for (const e of es) { if (e.hadRecentInput) continue; cls += e.value; for (const s of e.sources || []) { const k = sel(s.node); if (k) shifts[k] = (shifts[k] || 0) + e.value; } } });
        const nav = performance.getEntriesByType('navigation')[0] || {};
        const res = performance.getEntriesByType('resource');
        const size = (r) => r.transferSize || r.encodedBodySize || 0;
        const by = { script: 0, css: 0, img: 0, font: 0, other: 0 };
        for (const r of res) { const k = r.initiatorType === 'script' ? 'script' : r.initiatorType === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i.test(r.name) ? 'img' : /\.css(\?|$)/.test(r.name) || r.initiatorType === 'link' && /css/.test(r.name) ? 'css' : /\.(woff2?|ttf|otf)(\?|$)/.test(r.name) ? 'font' : 'other'; by[k] += size(r); }
        const sizeOf = Object.fromEntries(res.map((r) => [r.name, size(r)]));
        const images = [...document.images].filter((i) => i.currentSrc && i.getBoundingClientRect().width > 0).map((i) => ({
          src: i.currentSrc, bytes: sizeOf[i.currentSrc] || 0, natural: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width),
          noDims: !(i.getAttribute('width') && i.getAttribute('height')) && getComputedStyle(i).aspectRatio === 'auto', lazy: i.loading === 'lazy', sel: sel(i),
        }));
        const blocking = [...document.querySelectorAll('head script[src]:not([async]):not([defer]):not([type=module]):not([nomodule])')].map((s) => s.src);
        const insecure = location.protocol === 'https:' ? [...new Set([...res.map((r) => r.name), ...[...document.querySelectorAll('img[src],script[src],link[href],iframe[src],video[src],audio[src],source[src]')].map((e) => e.src || e.href)].filter((u) => /^http:\/\//.test(u || '')))].slice(0, 20) : [];
        const scripts = [...new Set(res.filter((r) => /\.m?js(\?|$)/.test(r.name) || r.initiatorType === 'script').map((r) => r.name).filter((u) => { try { return new URL(u).host === location.host; } catch { return false; } }))];
        const thirdParty = [...new Set(res.map((r) => { try { return new URL(r.name).host; } catch { return ''; } }).filter((h) => h && h !== location.host))];
        // Clickable things agents cannot recognise: pointer cursor on an element that is not a link, button or control.
        const fake = {};
        for (const el of document.querySelectorAll('div, span, li, td, img, svg, p')) {
          if (getComputedStyle(el).cursor !== 'pointer' || el.closest('a, button, [role=button], [role=link], [role=tab], [role=menuitem], label, summary, input, select, textarea')) continue;
          if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
          if (el.getAttribute('role') || el.getAttribute('tabindex') !== null) continue;
          const k = sel(el); fake[k] = (fake[k] || 0) + 1;
        }
        const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { const j = JSON.parse(s.textContent); const items = Array.isArray(j) ? j : j['@graph'] || [j]; return { ok: true, types: items.map((x) => x['@type']).flat().filter(Boolean) }; } catch { return { ok: false, types: [] }; } });
        return {
          perf: { insecure, scripts, ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0), lcp: Math.round(lcp), lcpEl, cls: +cls.toFixed(3), shifts, requests: res.length + 1, bytes: { html: nav.transferSize || nav.encodedBodySize || 0, ...by }, images, blocking, thirdParty },
          agents: { fakeButtons: fake, jsonld: ld, renderedText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().length },
        };
      }, origin);
      // Content blocks with a hash each, so the next scan (or a preview) can tell which parts of the page changed.
      const blocks = await page.evaluate(() => {
        const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
        const path = (el) => { const parts = []; while (el && el !== document.body && parts.length < 14) { const p = el.parentElement; if (!p) break; const same = [...p.children].filter((c) => c.tagName === el.tagName); parts.unshift(el.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '')); el = p; } return 'body > ' + parts.join(' > '); };
        const out = []; let n = 0;
        for (const el of document.body.querySelectorAll('header, nav, footer, section, article, aside, main > div, h1, h2, h3, h4, p, li, a, button, img, picture, svg, form, table, figure, blockquote, label, input, select, textarea, [class*="card"]')) {
          if (++n > 1500 || out.length >= 450) break;
          if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
          const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
          const text = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 600);
          const look = [cs.color, cs.backgroundColor, cs.fontSize, cs.fontWeight, cs.fontFamily.split(',')[0], cs.borderRadius, cs.borderTopWidth, cs.borderTopColor, cs.paddingTop, cs.paddingLeft, cs.gap, cs.boxShadow, el.tagName === 'IMG' ? '' : Math.round(r.width / 12), el.tagName === 'IMG' ? '' : Math.round(r.height / 12), el.getAttribute('src') || '', el.getAttribute('href') || ''].join('|');
          out.push([path(el), hash(el.tagName + '|' + text + '|' + look), hash(el.tagName + '|' + text)]);
        }
        return out;
      }).catch(() => []);
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
      const hdr = resp?.headers() || {};
      const cookies = [];
      try { for (const c of (await cdp.send('Network.getAllCookies')).cookies) { const k = c.name + '@' + c.domain; if (seenCookies.has(k)) continue; seenCookies.add(k); cookies.push({ name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite || null, session: c.session, days: c.expires > 0 ? Math.round((c.expires * 1000 - Date.now()) / 864e5) : 0 }); } } catch {}
      const sec = Object.fromEntries(['strict-transport-security', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'access-control-allow-origin', 'access-control-allow-credentials', 'server', 'x-powered-by'].map((h) => [h, hdr[h] || null]));
      const hops = resp ? resp.request().redirectChain().map((r) => r.url()) : [];
      fs.mkdirSync(path.join(outDir, 'blocks'), { recursive: true }); fs.writeFileSync(path.join(outDir, 'blocks', id + '.json'), JSON.stringify(blocks));
      results.push({ ...q, id, blocks: blocks.length, status: resp?.status() ?? 0, finalPath, redirected: finalPath !== q.path, xRobots: hdr['x-robots-tag'] || null, hops, headers: sec, cookies, ...data, ...extra, axe, timing: t, capturedHeight: Math.min(fullH, MAX_CAPTURE_HEIGHT), snapshot: true, image: snap.needsImage });
      process.stdout.write('.');
    } catch (e) {
      results.push({ ...q, id, status: 0, error: String(e.message || e).slice(0, 200) });
      process.stdout.write('x');
    }
  }
  await page.close();
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// Signed-in pages (optional): with a test account the user gave, on a preview or staging only. Sign in once, follow the
// links between private routes to find real pages (one or two per route), then scan them like the others.
const LOGIN_URL = process.env.PAGEWISE_LOGIN_URL, EMAIL = process.env.PAGEWISE_TEST_EMAIL, PASSWORD = process.env.PAGEWISE_TEST_PASSWORD;
const signedIn = { tried: false };
if (LOGIN_URL && EMAIL && PASSWORD && !ONLY) {
  signedIn.tried = true;
  const prodHost = (() => { try { return new URL(process.env.PAGEWISE_PRODUCTION_URL || '').host; } catch { return ''; } })();
  if (!REVIEW || new URL(origin).host === prodHost) { signedIn.error = 'Signed-in pages are only scanned on previews and staging, never on production.'; console.log('Calque: ' + signedIn.error); }
  else {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    if (Object.keys(HEADERS).length) await page.setExtraHTTPHeaders(HEADERS);
    try {
      const loginAt = new URL(LOGIN_URL, origin);
      await page.goto(origin + loginAt.pathname + loginAt.search, { waitUntil: 'networkidle2', timeout: 30000 });
      const visible = async (sel) => page.$$eval(sel, (els) => els.findIndex((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }));
      const EMAIL_SEL = 'input[type=email], input[name*=email i], input[autocomplete=username], input[name=username]', PASS_SEL = 'input[type=password]';
      if ((await visible(PASS_SEL)) < 0) { // password behind a toggle ("Use a password instead")
        const toggled = await page.evaluate(() => { const b = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /password/i.test(e.textContent || '') && e.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
        if (toggled) await new Promise((r) => setTimeout(r, 600));
      }
      const ei = await visible(EMAIL_SEL), pi = await visible(PASS_SEL);
      if (ei < 0 || pi < 0) throw new Error('no email and password fields on ' + loginAt.pathname + ' (magic link or social sign-in only?)');
      await (await page.$$(EMAIL_SEL))[ei].type(EMAIL, { delay: 10 });
      const pass = (await page.$$(PASS_SEL))[pi];
      await pass.type(PASSWORD, { delay: 10 });
      const before = page.url();
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}), pass.press('Enter')]);
      await new Promise((r) => setTimeout(r, 1500));
      if ((await visible(PASS_SEL)) >= 0 && page.url() === before) throw new Error('the sign-in did not go through (wrong password, a captcha, or a second factor?)');
      // Find pages: breadth-first over links that stay on private routes, never following sign-out or destructive links.
      const privateRoutes = routes.filter((r) => r.isPrivate && !/^\/(login|signin|sign-in|signup|sign-up|register|auth|oauth)(\/|$)/.test(r.route));
      const perRoute = new Map(), found = [], seen = new Set();
      const frontier = [new URL(page.url()).pathname];
      while (frontier.length && found.length < 40 && seen.size < 120) {
        const p0 = frontier.shift(); if (seen.has(p0)) continue; seen.add(p0);
        const r = matchRoute(privateRoutes, p0);
        if (r && (perRoute.get(r.route) || 0) < 2) { perRoute.set(r.route, (perRoute.get(r.route) || 0) + 1); found.push({ route: r.route, path: p0, signedIn: true, inSitemap: false }); }
        try {
          if (new URL(page.url()).pathname !== p0) await page.goto(origin + p0, { waitUntil: 'networkidle2', timeout: 30000 });
          const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
          for (const h of links) {
            if (!h || /^(mailto|tel|javascript):/i.test(h) || /(sign-?out|log-?out|delete|remove|destroy|unsubscribe|cancel|billing|checkout)/i.test(h)) continue;
            let u; try { u = new URL(h, origin); } catch { continue; }
            if (u.host !== new URL(origin).host) continue;
            const pp = u.pathname.replace(/\/$/, '') || '/';
            if (matchRoute(privateRoutes, pp) && !seen.has(pp)) frontier.push(pp);
          }
        } catch {}
      }
      const cookies = await page.cookies();
      await page.close();
      const list = found; list.next = 0;
      signedIn.pages = found.length;
      console.log(`Calque: signed in as the test account, ${found.length} signed-in page(s) to scan across ${perRoute.size} route(s).`);
      await Promise.all(Array.from({ length: Math.min(3, CONCURRENCY) }, () => worker(list, ctx, cookies)));
    } catch (e) { signedIn.error = 'Could not sign in: ' + String(e.message || e).slice(0, 200); console.log('Calque: ' + signedIn.error); }
    await ctx.close().catch(() => {});
  }
}
await browser.close();

// Agents that do not run JavaScript see the raw HTML: compare its text with what the browser rendered.
const textOf = (html) => (html.match(/<body[\s\S]*<\/body>/i)?.[0] || html).replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;
let ri = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (ri < results.length) { const r = results[ri++]; if (!r.agents || r.signedIn) continue; try { const raw = await (await fetch(origin + r.path, fetchOpts)).text(); r.agents.rawText = textOf(raw); r.rawHtml = raw.slice(0, 2e6); } catch {} } }));
const site = { robots, llmsTxt: false, aiBlocked: [] };
try { const l = await fetch(origin + '/llms.txt', fetchOpts); site.llmsTxt = l.ok && !/<html/i.test((await l.text()).slice(0, 200)); } catch {}
{ // AI crawlers fully disallowed in robots.txt
  const groups = robots.split(/\n(?=user-agent)/i);
  for (const bot of ['GPTBot', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'CCBot']) {
    const g = groups.find((x) => new RegExp('user-agent:\\s*' + bot + '\\b', 'i').test(x)) || '';
    if (/disallow:\s*\/\s*($|\n)/i.test(g)) site.aiBlocked.push(bot);
  }
}


// Indexation: every URL the site points to (internal links of scanned pages, and on full scans the whole sitemap)
// gets a light request, redirects followed by hand, so 404s, redirect chains and noindex headers show up without
// loading those pages in the browser.
const scannedPaths = new Set(results.map((r) => r.path));
const toCheck = new Map(); // path -> { fromSitemap, from:Set }
const want = (p, o) => { if (scannedPaths.has(p)) return; if (!toCheck.has(p)) toCheck.set(p, { fromSitemap: false, from: new Set() }); const c = toCheck.get(p); if (o.sitemap) c.fromSitemap = true; if (o.from) c.from.add(o.from); };
for (const r of results) for (const l of r.links || []) if (!routes.some((x) => x.isPrivate && (l === x.route || l.startsWith(x.route + '/')))) want(l, { from: r.path });
// Sitemap: every URL of the static routes and of anything unmatched; dynamic routes are sampled (up to 40 each),
// which is enough to catch a broken template or a stale data source without requesting thousands of pages.
if (!ONLY) {
  for (const u of unmatched) want(u, { sitemap: true });
  for (const r of byRoute.values()) for (const p of r.dynamic ? r.sitemapUrls.filter((_, i, a) => a.length <= 40 || i % Math.ceil(a.length / 40) === 0) : r.sitemapUrls) want(p, { sitemap: true });
}
async function probe(p) {
  const chain = []; let url = origin + p, res;
  for (let hop = 0; hop < 6; hop++) {
    const ctl = AbortSignal.timeout(10000);
    res = await fetch(url, { ...fetchOpts, method: 'HEAD', redirect: 'manual', signal: ctl }).catch(() => null);
    if (res && res.status === 405) res = await fetch(url, { ...fetchOpts, redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!res) res = await fetch(url, { ...fetchOpts, redirect: 'manual', signal: AbortSignal.timeout(25000) }).catch(() => null); // slow first render: one patient retry
    if (!res) return { status: 0, chain };
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { chain.push(url); url = new URL(res.headers.get('location'), url).href; continue; }
    break;
  }
  return { status: res.status, chain, final: url, xRobots: res.headers.get('x-robots-tag') };
}
const checked = {};
const tProbe = Date.now();
{ const list = [...toCheck.keys()].slice(0, 3000); let k = 0;
  await Promise.all(Array.from({ length: 16 }, async () => { while (k < list.length) { const p = list[k++]; const c = toCheck.get(p); checked[p] = { ...(await probe(p)), fromSitemap: c.fromSitemap, from: [...c.from].slice(0, 20) }; } })); }

// Share previews: each Open Graph / X image is fetched once, reading only its first bytes for the dimensions.
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  if (b.slice(0, 3).toString() === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' };
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') {
    const f = b.slice(12, 16).toString();
    if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (f === 'VP8L') { const x = b.readUInt32LE(21); return { w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1, type: 'webp' }; }
    if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), type: 'webp' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), type: 'jpeg' }; i += 2 + len; }
    return { type: 'jpeg' };
  }
  return { type: 'unknown' };
}
async function probeImage(u) {
  try {
    const res = await fetch(here(u), { ...fetchOpts, signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') || '';
    const reader = res.body?.getReader(); const parts = []; let got = 0;
    while (reader && got < 65536) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
    reader?.cancel().catch(() => {});
    const { type: format, ...dims } = imageSize(Buffer.concat(parts.map((p) => Buffer.from(p))));
    return { status: res.status, type, format, bytes: Number(res.headers.get('content-length')) || null, ...dims };
  } catch (e) { return { status: 0, error: String(e.message || e).slice(0, 120) }; }
}
const shareImages = {};
{ const list = [...new Set(results.flatMap((r) => [r.share?.ogImage, r.share?.twImage]).filter((u) => u && /^https?:/.test(u)))]; let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (k < list.length) { const u = list[k++]; shareImages[u] = await probeImage(u); } })); }
console.log(`\nlink and sitemap checks: ${Object.keys(checked).length} URLs, share images: ${Object.keys(shareImages).length}, ${Math.round((Date.now() - tProbe) / 1000)}s`);

// Security, from outside like any visitor: HTTPS redirect, files that should never be public, CORS, public source
// maps, and secrets shipped in the site's own JavaScript or HTML. Read-only requests; findings are masked.
const security = { httpRedirect: null, exposed: [], cors: null, sourceMaps: [], secrets: [], adminLogin: [] };
if (!REVIEW && !ONLY) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') {
      const r = await fetch('http://' + u.host + '/', { ...fetchOpts, redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
      security.httpRedirect = r ? { status: r.status, location: r.headers.get('location') } : { status: 0 };
    }
  } catch {}
  const FILES = [
    ['/.env', (t) => /^[A-Z][A-Z0-9_]{2,}=/m.test(t)], ['/.env.local', (t) => /^[A-Z][A-Z0-9_]{2,}=/m.test(t)], ['/.env.production', (t) => /^[A-Z][A-Z0-9_]{2,}=/m.test(t)],
    ['/.git/config', (t) => /\[core\]/.test(t)], ['/.git/HEAD', (t) => /^ref: refs\//.test(t)], ['/.DS_Store', (t, b) => b.slice(4, 8).toString() === 'Bud1'],
    ['/.vercel/project.json', (t) => /"projectId"/.test(t)], ['/.npmrc', (t) => /_authToken/.test(t)], ['/backup.sql', (t) => /CREATE TABLE|INSERT INTO/i.test(t)], ['/dump.sql', (t) => /CREATE TABLE|INSERT INTO/i.test(t)],
  ];
  await Promise.all(FILES.map(async ([p, test]) => {
    try {
      const r = await fetch(origin + p, { ...fetchOpts, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (r.status !== 200) return;
      const b = Buffer.from(await r.arrayBuffer()).subarray(0, 20000); const t = b.toString('utf8');
      if (!/<html|<!doctype/i.test(t.slice(0, 500)) && test(t, b)) security.exposed.push(p);
    } catch {}
  }));
  await Promise.all(['/admin', '/wp-admin/', '/wp-login.php', '/phpmyadmin/', '/administrator/'].map(async (p) => {
    try { const r = await fetch(origin + p, { ...fetchOpts, signal: AbortSignal.timeout(10000) }); if (r.status === 200 && /type=["']?password/i.test(await r.text())) security.adminLogin.push(p); } catch {}
  }));
  try {
    const r = await fetch(origin + '/', { ...fetchOpts, headers: { ...fetchOpts.headers, origin: 'https://calque-cors-check.example' }, signal: AbortSignal.timeout(10000) });
    security.cors = { allowOrigin: r.headers.get('access-control-allow-origin'), credentials: r.headers.get('access-control-allow-credentials') };
  } catch {}
  // The site's own scripts: public source maps, and secrets that should only live on the server.
  const scripts = [...new Set(results.flatMap((r) => r.perf?.scripts || []))].slice(0, 120);
  const PATTERNS = [
    ['Stripe secret key', /\b[rs]k_live_[0-9a-zA-Z]{20,}/g], ['Stripe test secret key', /\bsk_test_[0-9a-zA-Z]{20,}/g], ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g], ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/g],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g], ['OpenAI API key', /\bsk-(?:proj-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g],
    ['Anthropic API key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{60,}/g], ['SendGrid API key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
    ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}/g], ['Google service account', /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/g],
  ];
  const mask = (v) => v.slice(0, Math.min(8, Math.floor(v.length / 3))) + '…(' + v.length + ' chars)';
  const scanText = (text, where) => {
    for (const [type, re] of PATTERNS) for (const m of text.matchAll(re)) security.secrets.push({ type, value: mask(m[0]), where });
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      try { const pl = JSON.parse(Buffer.from(m[1], 'base64url').toString()); if (pl.role === 'service_role') security.secrets.push({ type: 'Supabase service_role key', value: mask(m[0]), where }); } catch {}
    }
  };
  let si = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (si < scripts.length) { const u = scripts[si++]; try {
    const r = await fetch(u, { ...fetchOpts, signal: AbortSignal.timeout(15000) }); if (!r.ok) continue;
    const t = (await r.text()).slice(0, 4e6); scanText(t, u);
    if (security.sourceMaps.length < 3 && (/\/\/# sourceMappingURL=(?!data:)/.test(t.slice(-500)) || si <= 6)) {
      const mr = await fetch(u.split('?')[0] + '.map', { ...fetchOpts, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (mr?.ok) { const head = (await mr.text()).slice(0, 2000); if (/"sources"\s*:/.test(head)) security.sourceMaps.push(u.split('?')[0] + '.map'); }
    }
  } catch {} } }));
  for (const r of results) if (r.rawHtml) scanText(r.rawHtml, origin + r.path);
  const seen = new Set(); security.secrets = security.secrets.filter((x) => { const k = x.type + x.value; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}
for (const r of results) delete r.rawHtml;
site.security = security;
site.signedIn = signedIn;
site.robotsBlocksAll = /disallow:\s*\/\s*($|\n)/i.test(robots.split(/\n(?=user-agent)/i).find((g) => /user-agent:\s*\*/i.test(g)) || '');
site.sitemapHosts = Object.fromEntries(sitemapHosts);
site.sitemapFound = sitemap.size > 0;
site.checked = checked;
site.shareImages = shareImages;

// Stylesheets: fetched once, url() made absolute, stored by content hash and linked from every snapshot.
const { createHash } = await import('node:crypto');
fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
const cssMap = {};
const tokens = {};
for (const href of sheetUrls) {
  try {
    const text = await (await fetch(href, fetchOpts)).text();
    const abs = text.replace(/url\((['"]?)(?!data:|https?:|#)([^'")]+)\1\)/g, (m, q, u) => `url(${q}${new URL(u, href).href}${q})`);
    const hash = createHash('sha1').update(abs).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(outDir, 'css', hash + '.css'), abs);
    cssMap[href] = hash;
    // Design tokens: custom properties, where they are declared and how often the CSS uses them.
    for (const m of abs.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const scope = m[1].trim().split(/\s*,\s*/).slice(0, 2).join(', ').slice(0, 60);
      for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) { const t = (tokens[d[1]] ||= { values: {}, uses: 0 }); t.values[scope] ||= d[2].trim().slice(0, 80); }
    }
    for (const u of abs.matchAll(/var\((--[\w-]+)/g)) (tokens[u[1]] ||= { values: {}, uses: 0 }).uses++;
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

fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ origin, review: REVIEW, tokens, site, partial: !!ONLY, scannedRoutes: ONLY ? [...ONLY] : null, scannedAt: new Date().toISOString(), routes: [...byRoute.values()], unmatched, sitemapCount: sitemap.size, privateRoutes: routes.filter((r) => r.isPrivate).map((r) => ({ route: r.route, file: r.file })), pages: results }, null, 1));
const timed = results.filter((r) => r.timing).sort((a, b) => b.timing.total - a.timing.total);
const sum = (k) => Math.round(timed.reduce((n, r) => n + (r.timing[k] || 0), 0) / 1000);
console.log('\nscanned', results.length, 'pages; sitemap', sitemap.size, 'urls; unmatched', unmatched.length);
console.log(`browser time: load ${sum('load')}s · read ${sum('read')}s · axe ${sum('axe')}s · capture ${sum('capture')}s`);
console.log('slowest:', timed.slice(0, 5).map((r) => `${r.path} ${(r.timing.total / 1000).toFixed(1)}s`).join(', '));
