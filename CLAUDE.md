# Claude Code Notes

## Scraper Debugging

Standalone diagnostic scripts live in `scraper-debug/`. Run them directly with `npx tsx`:

```bash
npx tsx scraper-debug/redfin-myhome.ts       # full Redfin flow test
npx tsx scraper-debug/redfin-price-sel.ts    # discover price DOM selectors
```

Edit the hardcoded address at the bottom of each file before running. These use the same stealth stack as the real scrapers (`createStealthContext`, `navigateWithReferrer`, etc.) so results reflect real bot-detection behavior.

## Known Scraper Status

- **Zillow**: works via direct listing URL
- **Redfin**: blocked by CloudFront — needs a proxy (`PROXY_URL` env var) to get through

## Dev Notes

- Skip unit tests during implementation; do a quick review only; detailed review at end
