# Pagewise Action

Scans a deployed Next.js site after each Vercel deployment: every page from the repo's routes and the sitemap,
a full-page capture of each, and deterministic checks (SEO, accessibility with axe-core, UI consistency from computed styles).

Read-only: it checks out your repo to read its routes and loads your public pages. It never pushes, comments or edits anything.
It identifies itself as `PagewiseBot` and never clicks consent banners or submits forms.

## Usage

Add `.github/workflows/pagewise.yml` (see `example-workflow.yml`):

```yaml
on: deployment_status
permissions:
  contents: read
jobs:
  scan:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.deployment.sha }}
          fetch-depth: 2
      - uses: Unmake-io/pagewise-action@main
        with:
          site-url: https://your-domain.com
```

The report (`data.json`, captures) is kept as the `pagewise-report` workflow artifact, with a summary on the run page.
