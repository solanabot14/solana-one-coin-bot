# Validation record

Build date: October 16, 2026. Python 3.12. Official alpaca-py 0.44.0.

- 44/44 deterministic offline tests passed.
- Python compilation succeeded.
- Engine, watchdog, backtest and historical-download command-line entrypoints loaded successfully.
- Tests exercise actual Alpaca request model construction, with mocked execution; no authenticated requests or orders were sent.
- One SDK dependency emits a `websockets.legacy` deprecation warning. No test failed because of it. Do not upgrade the pinned SDK without rechecking transport/model/stream contracts.
- Downloaded current official BLS ICS: parsed 23 CPI dates, coverage January 15, 2025–December 10, 2026.
- Federal Reserve HTML fetch returned HTTP 403 in this environment. Parser has structural fixture coverage, not a successful live Fed integration test.
- Synthetic multi-session minute replay exercises one completed round-trip and verifies commission sensitivity. It is not historical performance evidence.
- No Alpaca keys were read from a connected production service, no deployment was attempted, and no other bot was modified.

Before relying on this service: validate credentials, data/news/status entitlements, live calendar access, actual partial-fill behavior, stop replacements and close-all responses in a dedicated paper account. Complete the paper checklist in README.md.
