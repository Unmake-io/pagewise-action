// Pull request review: compares a preview deployment with the last production scan, then writes the result to the
// job summary and, when the workflow allows it (pull-requests: write), to one comment on the pull request that it
// keeps up to date. It never touches the code.
import fs from 'node:fs';
import path from 'node:path';
import { readRoutes } from './routes.mjs';
import { diffBlocks, blocksOf } from './changes.mjs';

const MARK = '<!-- calque-review -->';
const OLD_MARK = '<!-- pagewise-review -->'; // comments written before the rename
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
  let md = `${MARK}\n### Calque review\n\n`;

  if (blocked && blocked >= scanned.length / 2) {
    md += `The preview at ${site} asks for a sign-in, so Calque could not read it. Connect Vercel in Calque (one click, it creates the access for you), or add the project's Vercel "Protection Bypass for Automation" secret as \`vercel-bypass-secret\`.\n`;
    return publish(md, event, out);
  }

  md += `Preview ${site} compared with production ${prodSite}${base?.scannedAt ? ` (scanned ${base.scannedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}. ${scanned.length} page(s) checked${only ? ` (${[...only].join(', ')})` : ''}.\n\n`;
  if (!base) md += `> No production baseline (Calque API not configured or no scan yet): only the issues found on the preview are listed.\n\n`;

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

  // Pages this branch changes: compared block by block with production, uploaded so Calque can show them side by side.
  const impacted = [];
  if (base?.pages) {
    const pool = async (items, fn) => { let i = 0; await Promise.all(Array.from({ length: 8 }, async () => { while (i < items.length) await fn(items[i++]); })); };
    await pool(scanned, async (p) => {
      const now = (() => { try { return JSON.parse(fs.readFileSync(path.join(out, 'blocks', data.pages[p].id + '.json'), 'utf8')); } catch { return null; } })();
      const prod = base.pages[p];
      if (!prod) { impacted.push({ path: p, kind: 'added', before: null }); return; }
      const d = diffBlocks(await blocksOf(prod.capture), now);
      if (d) impacted.push({ path: p, kind: 'changed', changes: d, before: prod.capture });
    });
    impacted.sort((a, b) => a.path.localeCompare(b.path));
  }
  let link = null;
  if (impacted.length) link = await uploadReview(impacted, { data, site, out, event, base });
  if (impacted.length) {
    const lines = impacted.slice(0, 20).map((x) => {
      const b = x.changes?.blocks || {}; const n = (b.changed?.length || 0) + (b.added?.length || 0) + (b.removed?.length || 0);
      const what = x.kind === 'added' ? 'new page' : [x.changes?.text && 'text', x.changes?.structure && 'layout', x.changes?.style && 'styles'].filter(Boolean).join(', ');
      return `| ${link ? `[\`${x.path}\`](${link}&path=${encodeURIComponent(x.path)}#changes)` : '`' + x.path + '`'} | ${what || 'changed'} | ${n || ''} |`;
    });
    md += `**${impacted.length === 1 ? '1 page looks' : impacted.length + ' pages look'} different from production**${link ? ` · [See them before and after](${link}#changes)` : ''}\n\n| Page | What changed | Blocks |\n|---|---|---|\n${lines.join('\n')}${impacted.length > 20 ? `\n| and ${impacted.length - 20} more | | |` : ''}\n\n`;
  } else if (base?.pages) md += `**No page looks different from production.**\n\n`;

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
  md += `<sub>Read-only check by [Calque](https://github.com/Unmake-io/calque-action): it reads the code and the preview, never changes them. Full report: the run's \`calque-report\` artifact.</sub>\n`;
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
  if (!prs.length) { console.log('Calque: no open pull request for this commit, review kept in the job summary.'); return; }
  for (const pr of prs.slice(0, 3)) {
    const list = await gh(`/issues/${pr.number}/comments?per_page=100`);
    const mine = list.ok ? (await list.json()).find((c) => (c.body?.includes(MARK) || c.body?.includes(OLD_MARK))) : null;
    const r = mine ? await gh(`/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body: md }) }) : await gh(`/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body: md }) });
    console.log(r.ok ? `Calque: review ${mine ? 'updated' : 'posted'} on #${pr.number}.` : `Calque: could not comment on #${pr.number} (${r.status}). Give the workflow "pull-requests: write" to get the review on the pull request.`);
  }
}

// Uploads the preview snapshots of the impacted pages and records the review; returns the link to it in Calque.
async function uploadReview(impacted, { data, site, out, event, base }) {
  const api = (process.env.PAGEWISE_API_URL || '').replace(/\/$/, '');
  if (!api || !process.env.PAGEWISE_TOKEN) return null;
  const auth = { authorization: 'Bearer ' + process.env.PAGEWISE_TOKEN };
  try {
    const pr = event.pull_request?.number || '';
    const meta = { sha: event.deployment?.sha || event.sha || event.pull_request?.head?.sha || process.env.GITHUB_SHA, branch: event.branches?.[0]?.name || event.deployment?.ref || event.pull_request?.head?.ref || '', pr, site };
    const res = await fetch(api + '/api/reviews', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ meta, pages: impacted.map((x) => ({ path: x.path, id: data.pages[x.path].id, css: data.pages[x.path].css || [] })) }) });
    if (!res.ok) return null;
    const { reviewId, projectId, uploads, css } = await res.json();
    const { put } = await import('@vercel/blob');
    const cssUrl = {};
    for (const [h, u] of Object.entries(css || {})) { try { cssUrl[h] = (await put(u.pathname, fs.readFileSync(path.join(out, 'css', h + '.css')), { access: 'public', token: u.clientToken, contentType: 'text/css', addRandomSuffix: false, allowOverwrite: true })).url; } catch {} }
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (i < impacted.length) { const x = impacted[i++]; const u = uploads?.[x.path]; if (!u) continue; try {
      const html = fs.readFileSync(path.join(out, 'snapshots', data.pages[x.path].id + '.html'), 'utf8').replace(/__PW_CSS__\/([0-9a-f]+)\.css/g, (m, h) => cssUrl[h] || m);
      x.after = JSON.stringify({ html: (await put(u.pathname, html, { access: 'public', token: u.clientToken, contentType: 'text/html', addRandomSuffix: true })).url });
    } catch {} } }));
    await fetch(api + '/api/reviews/' + reviewId + '/pages', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ pages: impacted }) });
    return `${api}/viewer.html?p=${projectId}&review=${reviewId}`;
  } catch (e) { console.warn('Calque: could not upload the review snapshots', String(e.message || e)); return null; }
}
