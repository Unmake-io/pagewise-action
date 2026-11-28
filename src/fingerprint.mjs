// Same identity as web/lib/fingerprint.ts: an issue keeps it across scans, so previews can be compared to production.
export function fingerprint(i) {
  const title = i.title.replace(/\d+(\.\d+)?/g, '#').replace(/# (\w+?)s\b/g, '# $1').replace(/\s*\(site \+ app\)/, '');
  const scope = i.color || i.selector || (i.pages.length === 1 ? i.pages[0] : '');
  return [i.kind, i.rule || '', scope, i.color ? '' : title].join('|');
}
