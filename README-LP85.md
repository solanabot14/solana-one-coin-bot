V3.1 BUY Priority Test - 85% LP Lock Paper Variant

This branch creates a separate paper-only process for the V3.1 BUY Priority Test.

- Entry, BUY-priority selection, re-entry rules, two-slot limit, $10 minimum, 10% -> 12.5% -> 15% repeating compounding, exits, and cost estimates match the existing BUY Priority Test.
- The only strategy change is the minimum confirmed RugCheck LP lock: 85% instead of 90%.
- Missing or unverified lock information remains a hard rejection.
- Visible in the main operations dashboard at /trading/buy-priority-lock85.
- The main dashboard process runs this paper bot as an independent instance; its paper state files are unique.
- Dedicated state files: v31BuyPriorityLock85TradingData.json and v31BuyPriorityLock85ReentryState.json.
- Deploy as a separate Railway service with a separate volume mounted at /data. Do not reuse another bot's volume.

This process starts only this variant. It does not start or control original V3.1, Swarm, or the existing BUY Priority Test. Simulated trades only; no wallet signing or live transaction path is included.
