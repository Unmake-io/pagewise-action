// Reads a Next.js App Router repo and lists every page route with its file.
import fs from 'node:fs';
import path from 'node:path';

const PAGE_FILES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'page.mdx'];

// Routes that are part of the product or private flows, not the public site.
// Routes behind sign-in (or that should never be audited as public pages). Common names by default; a project adds its
// own with the private-routes input (PAGEWISE_PRIVATE, comma separated).
const PRIVATE_PREFIXES = ['/app', '/dashboard', '/account', '/settings', '/admin', '/login', '/signin', '/sign-in', '/signup', '/sign-up', '/register', '/auth', '/oauth', '/onboarding', '/invite', '/preview',
  ...(process.env.PAGEWISE_PRIVATE || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter((x) => x.startsWith('/'))];

export function readRoutes(repo) {
  const appDir = path.join(repo, 'app');
  const out = [];
  const walk = (dir, segs) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (n.startsWith('_') || n.startsWith('@') || n === 'api' || n === 'node_modules') continue;
      walk(path.join(dir, n), [...segs, n]);
    }
    const file = PAGE_FILES.find((f) => fs.existsSync(path.join(dir, f)));
    if (!file) return;
    const urlSegs = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    const route = '/' + urlSegs.join('/');
    const dynamic = urlSegs.some((s) => s.startsWith('['));
    const isPrivate = PRIVATE_PREFIXES.some((p) => route === p || route.startsWith(p + '/'));
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    out.push({
      route: route === '/' ? '/' : route,
      file: path.relative(repo, path.join(dir, file)),
      dynamic,
      isPrivate,
      hasMetadata: /export\s+(const\s+metadata|async\s+function\s+generateMetadata|function\s+generateMetadata)/.test(src),
      hasStaticParams: /generateStaticParams/.test(src),
      matcher: toRegex(urlSegs),
      specificity: urlSegs.reduce((n, s) => n + (s.startsWith('[[...') ? 0 : s.startsWith('[...') ? 1 : s.startsWith('[') ? 2 : 3), 0) * 10 + urlSegs.length,
    });
  };
  walk(appDir, []);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

function toRegex(segs) {
  let re = '';
  for (const s of segs) {
    if (s.startsWith('[[...')) re += '(?:/.*)?';
    else if (s.startsWith('[...')) re += '/.+';
    else if (s.startsWith('[')) re += '/[^/]+';
    else re += '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return '^' + (re || '/') + '/?$';
}

export function matchRoute(routes, pathname) {
  const p = pathname === '' ? '/' : pathname;
  const hits = routes.filter((r) => new RegExp(r.matcher).test(p));
  hits.sort((a, b) => b.specificity - a.specificity);
  return hits[0] || null;
}
