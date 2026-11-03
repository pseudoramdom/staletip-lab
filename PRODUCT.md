# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Researchers studying how stale tips propagate under BIP332: fork propagation, stale-block data availability, and relay bandwidth. They run the lab locally against real Bitcoin Core nodes on regtest, or monitor testnet4, and read the result closely rather than glancing at it.

## Product Purpose

A local laboratory for experimenting with BIP332 stale-tip relay using real `bitcoind` processes. A session should leave the researcher with evidence that the implementation behaves as the BIP describes, grounded in captured P2P messages and RPC state rather than in simulation.

## Positioning

Every view is backed by real nodes and real messages: each node is its own Bitcoin Core process built from the `bip332-staletip-relay` branch, and the timeline comes from Core's message capture (regtest) or network log (testnet4). Nothing is simulated.

## Operating Context

- Runs on the researcher's machine (macOS or Linux, Python 3.9+), served on loopback at `127.0.0.1:8765` (regtest) or `:8766` (testnet4).
- Regtest: create nodes, connect them, mine, create forks on demand, reset sessions. Testnet4: monitor public peers, sync progress, negotiation.
- Session data lives under `runs/`; sessions can be exported as JSON.

## Capabilities and Constraints

- No Python packages, JavaScript packages, CDNs, wallets, or frontend build steps; static HTML/CSS/JS served by the lab.
- Content Security Policy allows only same-origin scripts and styles (inline styles permitted).
- Stale-tip modes per node: Headers (relay without fetching), Blocks (relay and fetch), None.
- Block trees show the latest 80 heights per managed node; external peers' trees are not visible.
- Arrival of a message does not imply acceptance; the product must not claim more than captures show.

## Brand Commitments

- Name: staletip.
- Should sit naturally beside Bitcoin Core tooling and documentation. No crypto-hype aesthetics.
- The lab UI follows the developer-tool category standard, executed at full craft rather than an invented visual world (chosen 2026-11-01). Craft bar: Linear, Vercel dashboard, GitHub (inferred; the user did not name products).
- Block-tree visual language set by the user: active chain solid ink; stale block learned via staletip is a solid orange line and solid orange block; header only is a solid orange line with an orange-striped block; a block reorged into staleness is a solid light-gray line and block; blocks a node does not know are not drawn.

## Evidence on Hand

- Real captured events, block records, and negotiation state from running sessions (`runs/<session>/`, `/api/export`).
- No testimonials, users, or benchmarks exist; none may be invented.

## Product Principles

1. Show evidence, not assertions: every state traces back to a captured message or RPC result.
2. Separate what was observed from what was configured or inferred.
3. Make propagation legible across nodes and across time.
4. Stay honest about limits: unknown, unobserved, and outside-window are explicit states.
