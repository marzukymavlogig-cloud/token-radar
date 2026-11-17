# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/marzukymavlogig-cloud/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/marzukymavlogig-cloud/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — a token launch radar: every pre-token protocol in the DefiLlama snapshot (2026-11-14), ranked by an implied value fitted on the market itself — not a flat multiple, not a hand-kept list of names. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

A token launch radar: every pre-token protocol in the DefiLlama snapshot (2026-11-14),
ranked by an implied value fitted on the market itself — not a flat multiple, not a
hand-kept list of names.

## The model (radar-2-comps)

The snapshot's own traded-token protocols are the comparables. At runtime the program
fits `log10(mcap) = a + b * log10(TVL)` by OLS over the 128 protocols with a positive market cap
and positive TVL (15 of the 144 mcap-carrying protocols record a market cap of 0 and are excluded),
then adjusts each pre-token protocol by:

- **category adjustment** — median residual per category (5+ comps), shrunk `n/(n+5)`,
  clamped to ±0.30 dex;
- **growth** — 7d TVL change clamped to [-60%, +120%]; upside at 0.6x, downside at 0.9x;
- **maturity** — inverted-U age curve: 0.70 at day 0, 1.00 at 180 days, flat to 1,095
  days, decaying back to 0.70 at 1,851 days;
- **breadth** — +3% per chain, up to 5 chains.

Implied value is capped at 20x TVL and $1e14, floored at $1, and ranks are forced
strictly decreasing. The board ranks **every** rankable pre-token protocol (198 rows:
the 40-protocol watchlist plus all other rankable pre-token protocols). Rankable means
pre-token and not a wrapped, staked or bridged product of a token that already trades —
the watchlist's own rule, applied to the whole board — and not a versioned pool.

Validation is computed at runtime and shown on the dashboard: leave-one-out refits,
a walk-forward split (fit on comps listed before 2025-01-01, test on those listed
on/after it), and a flat 0.25x TVL baseline scored on the same out-of-sample sets —
so the fitted curve's win over the flat multiple is a measured number, not a claim.

## The dashboard

Dark navy + amber, system fonts, no network. Sortable and filterable board (search,
category, chain, watchlist-only, min TVL, sort), a detail view per protocol with the
full model decomposition (base × category × growth × maturity × breadth = implied)
and an 8-step costed farm plan, a live-token comparables view, the fitted curve with
an inline scatter of the comparables, and deep links (`#detail=<slug>`,
`#filter=category:<name>`, `#filter=watchlist`, `#q=<text>`, `#view=live`).

A protocol is always described as one that **records no token** — the DefiLlama
record is not proof it has none.

## Run it

Requires Node.js 22 or later, standard library only — nothing to install.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

With Node 22 installed elsewhere, use its path, e.g.
`~/workspace/makefun/node22/bin/node main.ts --input <kit>/input/snapshot.json`.
The program writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. Run it twice and the outputs are
byte-identical: no wall clock, no randomness in any output.

## Layout

- `main.ts` — entrypoint: read snapshot, build board, write outputs, dossier last.
- `lib/model.ts` — the comps-fitted model, validation, farm plans, board builder.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit.
- `dashboard/` — `index.html`, `app.css`, `app.js` (no network, no external assets).
- `screenshots/` — board, detail and filtered renders of this dashboard.

## License

MIT — see `LICENSE`.
