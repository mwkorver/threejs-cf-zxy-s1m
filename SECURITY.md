# Security

This is a public prototype, not a maintained project — the same footing as
[CONTRIBUTING.md](CONTRIBUTING.md). There is no disclosure process and no
response commitment. Fork it and fix it.

Two things are worth knowing before you deploy your own copy, because both cost
real money on your account:

- **The CloudFront distribution is public when enabled.** `DEMO_ENABLED=true`
  makes it reachable by anyone holding the domain. Tile misses are
  requester-pays reads billed to you. It deploys disabled unless you ask.
- **The tile access key is a demo gate, not authentication.** It lives in
  `.tile-key` (gitignored) and is inlined into the client bundle at build time,
  so anyone with the app has it. It exists to stop casual scraping of an open
  distribution, nothing more.
