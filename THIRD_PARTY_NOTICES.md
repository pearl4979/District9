# Third-party notices

## ai-wallet-binance

- Repository: https://github.com/jacke-pp/ai-wallet-binance
- Revision: 204ca48ac1c5928864f043635489de76338e1a00 (2026-10-27 retrieval)
- Copyright (c) 2026 ai-wallet-binance contributors
- License: MIT. Complete notice: licenses/ai-wallet-binance-LICENSE.txt
- Adapted portions: lib/ui/server.mjs fixed public K-line endpoint and OHLCV array mapping into src/candles.mjs. The original adapted Canvas renderer has been replaced by the local Lightweight Charts adapter; its historical MIT notice is retained.
- Local modifications: black/gold tokens, resize/pan/zoom, stricter numeric validation, trusted-market lookup, source/currency separation, stale data handling, bounded curve-sample persistence, detail UI and request lifecycle.

The upstream trading engine, wallet/login settings, sniping, auto-transfer and GMGN key storage are not imported. This attribution does not imply upstream review or endorsement of this application.

## TMTN

- Repository: https://github.com/bnbxcs/TMTN
- Revision: 92384e71d00838876f9862bf1db6cf9b8d0b1e76 (2026-10-27 retrieval)
- Copyright (c) 2026 0xZhangCrypto1
- License: MIT. Complete notice: licenses/TMTN-LICENSE.txt
- Referenced/adapted: engine/live/names.js Agent ID handleOf lookup and registry address into src/agent-names.mjs. Local code adds same-block reverse ownership/balance checks, bounded cache and expiry.
- Reviewed for design: quoteRoutes.js, dexDirect.js, dexFeed.js, liveTrader.js and platform adapters. Pool inspection and tax/creator dossiers are local implementations cross-checked with protocol sources and live configuration.
- The upstream trading engine, market-order fallback, DEX execution, signing, approvals, sniping and automatic transfers are not imported. Candidate USD liquidity is not an execution quote or a claim of optimal routing.


## TradingView Lightweight Charts 5.2.1

- Official repository: https://github.com/tradingview/lightweight-charts
- Release: https://github.com/tradingview/lightweight-charts/releases/tag/v5.2.1
- Official npm archive: https://registry.npmjs.org/lightweight-charts/-/lightweight-charts-5.2.1.tgz
- Retrieved with `npm pack lightweight-charts@5.2.1 --ignore-scripts`; verified archive integrity: `sha512-IVwoK1RLFiLPubaKIjNbtjWLnpPMqiABSrTay6whmNa8L1+19292VtHJ+BWyPUuLCwF0tcQlhEWd1CLB2a1nsQ==`.
- Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
- License: Apache-2.0. Complete license: licenses/lightweight-charts-LICENSE.txt. Upstream release NOTICE: licenses/lightweight-charts-NOTICE.txt (retrieved unchanged from the v5.2.1 tag).
- Vendored unchanged: dist/lightweight-charts.standalone.production.js as public/vendor/lightweight-charts-5.2.1.standalone.production.js. No CDN requests or runtime third-party chart embeds.
- The chart retains the engine's visible TradingView attribution logo/link. District9's public/candle-chart.js adapter formats UTC+8 labels, maps canonical millisecond OHLC buckets, retains unknown volume, supplies wallet geometry, and supports bounded history. It does not modify the vendored engine or supply a trading execution engine.
