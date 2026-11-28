# Calque Action

Scans a deployed Next.js site after each Vercel deployment: every page from the repo's routes and the sitemap, an HTML
snapshot of each, and deterministic checks, no AI:

- **SEO** and **Indexing**: titles, descriptions, canonicals, noindex left on in production, sitemap URLs that 404 or
  redirect, sitemaps on the wrong domain, broken internal links, redirect chains.
- **Sharing**: how each page shows on X, LinkedIn and Slack (image loads, size, ratio, `twitter:card`).
- **Security**: HTTPS, HSTS, CSP, clickjacking, referrer and permissions policies, CORS, mixed content, exposed `.env` / `.git` files, public source maps, secrets in client code, tracking cookies before consent.
- **Accessibility** (axe-core), **Performance** (weights, images, render-blocking scripts, layout shifts),
  **Agents** (content readable without JavaScript, structured data, llms.txt, AI crawlers), **Structure**, **UI consistency**.
- **DESIGN.md**: the design rules measured on the live site (tokens and where they are declared, the primary button,
  text sizes, hard-coded colours, drift), for your coding agent to read before it touches the UI.

Every production scan records which pages changed since the previous one (text, layout, styles), with the page
before and after. On a **preview** deployment it compares the preview with the last production scan and writes the review (pages added
or removed, pages that look different and links to see them before and after, changed titles and canonicals, new
issues, issues fixed) to the job summary and to one comment on the pull
request, kept up to date.

Read-only on your code: it checks out the repo to read its routes and loads your pages. Its only write is the review
comment, and only if the workflow grants `pull-requests: write`. It identifies itself as `CalqueBot` and never clicks
consent banners or submits forms.

## Usage

Add `.github/workflows/calque.yml` from `example-workflow.yml`, then set:

| Setting | Where | What |
|---|---|---|
| `CALQUE_SITE_URL` | repository variable | Production URL, for example `https://acme.com` |
| `CALQUE_PREVIEW_URL` | repository variable | Not needed when Vercel is connected in Calque. Otherwise the preview URL template, for example `https://acme-git-{branch}-acmeteam.vercel.app` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | secret | Not needed when Vercel is connected in Calque. Otherwise, only if previews are protected (Vercel › Settings › Deployment Protection › Protection Bypass for Automation) |
| `CALQUE_API_URL`, `CALQUE_TOKEN` | variable, secret | Optional: send production scans to the Calque app |

**Signed-in pages** (optional): on previews and staging, give Calque a test account (`login-url`, `test-email`,
`test-password` as secrets) and it signs in, finds one or two pages per private route and scans them too. Never on
production.

The report (`data.json`, `DESIGN.md`, snapshots, `review.md` for previews) is kept as the `calque-report` artifact.
