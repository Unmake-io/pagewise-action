// Pull request review: compares a preview deployment with the last production scan, then writes the result to the
// job summary and, when the workflow allows it (pull-requests: write), to one comment on the pull request that it
// keeps up to date. It never touches the code.
import fs from 'node:fs';
import path from 'node:path';
import { readRoutes } from './routes.mjs';

const MARK = '<!-- pagewise-review -->';
const SEV = { high: 'High', medium: 'Medium', low: 'Low' };
const cut = (s, n = 70) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '–');
const cell = (s) => String(s ?? '–').replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function baseline() {
  const api = (process.env.PAGEWISE_API_URL || '').replace(/\/$/, '');
  if (!api || !process.env.PAGEWISE_TOKEN) return null;
  try {
    const r = await fetch(api + '/api/state', { headers: { authorization: 'Bearer ' + process.env.PAGEWISE_TOKEN } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function review({ data, site, prodSite, only, repo, out, event }) {
  const base = await baseline();
  const scanned = Object.keys(data.pages);
  const blocked = Object.values(data.pages).filter((p) => p.status === 401 || p.status === 403).length;
  let md = `${MARK}\n### Pagewise review\n\n`;

  if (blocked && blocked >= scanned.length / 2) {
    md += `The preview at ${site} asks for a sign-in, so Pagewise could not read it. Add the project's Vercel "Protection Bypass for Automation" secret as \`vercel-bypass-secret\`.\n`;
    return publish(md, event, out);
  }

  md += `Preview ${site} compared with production ${prodSite}${base?.scannedAt ? ` (scanned ${base.scannedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}. ${scanned.length} page(s) checked${only ? ` (${[...only].join(', ')})` : ''}.\n\n`;
  if (!base) md += `> No production baseline (Pagewise API not configured or no scan yet): only the issues found on the preview are listed.\n\n`;

  // Pages: routes in this branch's code against the routes production had.
  if (base) {
    const now = readRoutes(repo).filter((r) => !r.isPrivate).map((r) => r.route);
    const was = new Set(base.routes || []);
    const added = now.filter((r) => !was.has(r)), removed = [...was].filter((r) => !now.includes(r));
    if (added.length || removed.length) {
      md += `**Pages**`;
      if (added.length) md += ` · ${added.length} added: ${added.map((r) => '`' + r + '`').join(', ')}`;
      if (removed.length) md += ` · ${removed.length} removed: ${removed.map((r) => '`' + r + '`').join(', ')}`;
      md += '\n\n';
    }
    // Settings that changed on pages both scans know.
    const rows = [];
    for (const p of scanned) {
      const a = base.pages?.[p], b = data.pages[p];
      if (!a || !b) continue;
      const cmp = (label, x, y) => { if ((x || null) !== (y || null)) rows.push(`| \`${p}\` | ${label} | ${cell(cut(x))} | ${cell(cut(y))} |`); };
      cmp('Title', a.title, b.title);
      cmp('Description', a.description, b.description);
      cmp('Robots', a.robots, b.robots);
      if (a.status !== b.status) rows.push(`| \`${p}\` | Status | ${a.status} | ${b.status} |`);
      const pn = (u) => { try { return new URL(u).pathname; } catch { return u; } };
      if (pn(a.canonical) !== pn(b.canonical)) rows.push(`| \`${p}\` | Canonical | ${cell(a.canonical)} | ${cell(b.canonical)} |`);
    }
    if (rows.length) md += `<details><summary><b>Changed settings</b> (${rows.length})</summary>\n\n| Page | Field | Production | This branch |\n|---|---|---|---|\n${rows.slice(0, 40).join('\n')}\n\n</details>\n\n`;
  }

  // Issues: new on the preview, and production issues this branch no longer has on the pages it checked.
  const known = new Set((base?.issues || []).map((i) => i.fingerprint));
  const fresh = data.issues.filter((i) => !known.has(i.fingerprint));
  const mine = new Set(data.issues.map((i) => i.fingerprint));
  const fixed = (base?.issues || []).filter((i) => !mine.has(i.fingerprint) && (only ? i.pages.length && i.pages.every((p) => scanned.includes(p)) : true));
  const order = { high: 0, medium: 1, low: 2 };
  fresh.sort((a, b) => order[a.severity] - order[b.severity]);
  const line = (i) => {
    const where = i.token || i.file || (i.hints?.[0] ? `${i.hints[0].file}:${i.hints[0].line}` : i.selector ? '`' + i.selector + '`' : '');
    return `- **${SEV[i.severity]}** · ${i.kind} · ${i.title} · ${i.pages.length === 1 ? '`' + i.pages[0] + '`' : i.pages.length + ' pages'}${where ? ` · ${where}` : ''}${i.expected ? `\n  Expected: ${i.expected}` : ''}`;
  };
  const ui = fresh.filter((i) => i.kind === 'UI consistency');
  if (!fresh.length) md += `**No new issue.**\n\n`;
  else {
    md += `**${fresh.length} new issue(s)**${ui.length ? `, including ${ui.length} off the design system` : ''}\n\n${fresh.slice(0, 25).map(line).join('\n')}${fresh.length > 25 ? `\n- and ${fresh.length - 25} more in the report` : ''}\n\n`;
  }
  if (fixed.length) md += `<details><summary><b>${fixed.length} production issue(s) gone on this branch</b></summary>\n\n${fixed.slice(0, 25).map((i) => `- ${i.kind} · ${i.title}`).join('\n')}\n\n</details>\n\n`;
  md += `<sub>Read-only check by [Pagewise](https://github.com/Unmake-io/pagewise-action): it reads the code and the preview, never changes them. Full report: the run's \`pagewise-report\` artifact.</sub>\n`;
  fs.writeFileSync(path.join(out, 'review.json'), JSON.stringify({ site, prodSite, fresh, fixed: fixed.map((i) => i.fingerprint) }, null, 1));
  return publish(md, event, out);
}

async function publish(md, event, out) {
  fs.writeFileSync(path.join(out, 'review.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.replace(MARK, ''));
  console.log(md);
  const token = process.env.GITHUB_TOKEN, repoName = process.env.GITHUB_REPOSITORY;
  if (!token || !repoName) return;
  const gh = (p, o = {}) => fetch('https://api.github.com/repos/' + repoName + p, { ...o, headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(o.body ? { 'content-type': 'application/json' } : {}) } });
  const sha = event.deployment?.sha || event.sha || event.pull_request?.head?.sha || process.env.GITHUB_SHA;
  let prs = [];
  if (event.pull_request) prs = [event.pull_request];
  else { const r = await gh(`/commits/${sha}/pulls`); if (r.ok) prs = (await r.json()).filter((p) => p.state === 'open'); }
  if (!prs.length) { console.log('Pagewise: no open pull request for this commit, review kept in the job summary.'); return; }
  for (const pr of prs.slice(0, 3)) {
    const list = await gh(`/issues/${pr.number}/comments?per_page=100`);
    const mine = list.ok ? (await list.json()).find((c) => c.body?.includes(MARK)) : null;
    const r = mine ? await gh(`/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body: md }) }) : await gh(`/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body: md }) });
    console.log(r.ok ? `Pagewise: review ${mine ? 'updated' : 'posted'} on #${pr.number}.` : `Pagewise: could not comment on #${pr.number} (${r.status}). Give the workflow "pull-requests: write" to get the review on the pull request.`);
  }
}
