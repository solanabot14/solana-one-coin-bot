# R3 Early Runner (experimental)

This branch is intentionally isolated from `main` / V3.1R2.

## Purpose
R3 tests the hypothesis that the bot should detect *acceleration across multiple scans* instead of waiting for a single ideal snapshot.

## Entry state
- Watch begins below the V3.1R2 entry floor (>= $25k liquidity and >= $50k 24h volume).
- No entry is allowed until at least 3 observations exist.
- Entry requires:
  - liquidity >= $50k
  - 24h volume >= $100k
  - 5m volume >= $3k
  - >= 20 transactions in 5m
  - buy ratio 52%-80%
  - 5m price change >= 0.25% and < 4%
  - positive 1h move <= 40%
  - liquidity growth >= 5% across the observation window
  - 24h volume growth >= 8% across the observation window
  - 5m volume >= 2.5% of liquidity
  - liquidity drawdown from recent max <= 12%

## Security
- Market-data integrity is a hard veto.
- Mint/freeze authority findings are a hard veto in R3.
- LP-lock findings are recorded by the scanner security layer and currently veto an R3 entry.
- This is paper-only research. Do not use R3 for live trading until its security and execution behavior are separately validated.

## Exit additions
V3.1R2 profit targets remain conceptually unchanged for the R3 experiment:
- TP1 +15%
- TP2 +30%
- 8% trailing after TP2
- hard stop -10%

R3 additionally tests:
- PROFIT PROTECT - STRUCTURE FAILURE:
  MFE >= 6%, drop from high >= 5%, 5m <= -1%, buy ratio < 45%, >= 10 transactions.
- FAILED CONTINUATION:
  after 10 minutes, MFE < 3%, 5m <= 0%, buy ratio < 45%, >= 10 transactions.

## Reentry
A full exit marks the token exhausted. A fresh R3 setup needs:
- minimum 10 minutes after exit
- at least 3 post-exit observations
- at least one cooling observation (5m <= 1.5%)
- then the complete early-runner entry conditions again

## Isolation
R3 uses:
- `strategyR3.js`
- `scannerR3.js`
- `botR3.js`
- `paperTraderR3.js`
- `r3.js`
- separate state file: `tradingDataR3.json`

The production V3.1R2 files on `main` are unchanged.

## Run
`node r3.js`

Do not point the existing production Railway service at this branch. Use a separate service/volume when R3 is ready for parallel paper testing.
