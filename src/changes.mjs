// Which parts of a page changed between two scans (or between production and a preview), from the content blocks the
// scanner hashes on each page. Deterministic: blocks are matched by hash first, so content moving down the page does
// not count as a change; what is left is new, removed or altered. Only the innermost changed blocks are kept.
const deepest = (list) => list.filter((a) => !list.some((b) => b !== a && b.startsWith(a + ' > ')));
function unmatched(a, b) { // items of a whose hash is not in b (as a multiset)
  const pool = new Map(); for (const x of b) pool.set(x[1], (pool.get(x[1]) || 0) + 1);
  const out = []; for (const x of a) { const c = pool.get(x[1]); if (c) pool.set(x[1], c - 1); else out.push(x); }
  return out;
}
const multiset = (arr) => arr.slice().sort().join('\n');

export function diffBlocks(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || !prev.length || !next.length) return null;
  const fresh = unmatched(next, prev), gone = unmatched(prev, next);
  if (!fresh.length && !gone.length) return null;
  const prevK = new Map(prev.map((b) => [b[0], b])), nextK = new Map(next.map((b) => [b[0], b]));
  const changed = deepest(fresh.filter((b) => prevK.has(b[0])).map((b) => b[0]));
  const added = deepest(fresh.filter((b) => !prevK.has(b[0])).map((b) => b[0]));
  const changedBefore = deepest(gone.filter((b) => nextK.has(b[0])).map((b) => b[0]));
  const removed = deepest(gone.filter((b) => !nextK.has(b[0])).map((b) => b[0]));
  return {
    text: multiset(prev.map((b) => b[2])) !== multiset(next.map((b) => b[2])),
    structure: multiset([...prevK.keys()]) !== multiset([...nextK.keys()]),
    style: fresh.some((b) => prevK.has(b[0]) && prevK.get(b[0])[2] === b[2] && prevK.get(b[0])[1] !== b[1]),
    blocks: { changed: changed.slice(0, 40), added: added.slice(0, 40), changedBefore: changedBefore.slice(0, 40), removed: removed.slice(0, 40) },
  };
}

/** Fetches the blocks recorded for a page (a capture string holding { blocks: url }). */
export async function blocksOf(capture) {
  let url = null;
  try { url = capture && capture[0] === '{' ? JSON.parse(capture).blocks : null; } catch {}
  if (!url) return null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
