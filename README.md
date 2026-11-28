# Pagewise Action

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

On a **preview** deployment it compares the preview with the last production scan and writes the review (pages added
or removed, changed titles and canonicals, new issues, issues fixed) to the job summary and to one comment on the pull
request, kept up to date.

Read-only on your code: it checks out the repo to read its routes and loads your pages. Its only write is the review
comment, and only if the workflow grants `pull-requests: write`. It identifies itself as `PagewiseBot` and never clicks
consent banners or submits forms.

## Usage

Add `.github/workflows/pagewise.yml` from `example-workflow.yml`, then set:

| Setting | Where | What |
|---|---|---|
| `PAGEWISE_SITE_URL` | repository variable | Production URL, for example `https://acme.com` |
| `PAGEWISE_PREVIEW_URL` | repository variable | Not needed when Vercel is connected in Pagewise. Otherwise the preview URL template, for example `https://acme-git-{branch}-acmeteam.vercel.app` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | secret | Not needed when Vercel is connected in Pagewise. Otherwise, only if previews are protected (Vercel › Settings › Deployment Protection › Protection Bypass for Automation) |
| `PAGEWISE_API_URL`, `PAGEWISE_TOKEN` | variable, secret | Optional: send production scans to the Pagewise app |

The report (`data.json`, `DESIGN.md`, snapshots, `review.md` for previews) is kept as the `pagewise-report` artifact.
