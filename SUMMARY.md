## Objective
- Полноценный порт расширения Polymarket на сайт

## Work State
### Completed
- Wallet, Profile, Settings, Calls tabs — ported
- Terminal (`_renderTerminalPanel`) — ported with mode-bar, event header, chart toggle (TV/Chainlink), order form, P-setup modal, strategies, copy, tracked wallets, order book
- Order book — HTML встроен в терминал, bindings для refresh/UP/DOWN, Chainlink fallback
- Chart — только по кнопке, TV с таймаутом 15с + retry; Chainlink через `chainlink-chart.html`
- P-setup modal — портирована из расширения (3 таба, buy/sell редактирование, preview, save)
- **Strategies полностью портированы:**
  - HTML template CLOB/Phoenix/Delta (все поля: balance, spread, rebate, size, timeout, gas, assets, rolling, wallet, positions, rounds, history)
  - My Strategies tab (save/edit 3 конфигураций)
  - Bot data management (`_getBot`, `_botSaveState`, `_botLoadState`, `_botSaveRound`)
  - `_botRender` — CLOB UI (stats, positions, settings, rounds, start/stop)
  - `_botRenderRounds` + `_botRenderHistory` — таблица раундов и лога операций
  - `_phoenixRender` — Phoenix UI (balance, entry, target, budget, stop loss, stats, rounds)
  - `_phoenixRenderRounds` — таблица раундов Phoenix
  - `_demoBotStart` / `_demoBotStop` — пуск/остановка бота с закрытием позиций
  - Strategy info modal с описаниями CLOB/Delta/Phoenix
  - Bindings: mode switching, strategy tabs, strategy options, info buttons, bot start/stop
  - `STRATEGY_DESCS` — описания стратегий
  - Все переводы (30+ ключей)
- Layout — убран `max-width: 1920px`, удалены старые `tt-panel-col` и `ttChartSection` из `_buildTradeView`
- i18n — добавлены terminal.chart_title, terminal.edit_setup, terminal.orderbook, terminal.price, terminal.size, terminal.strategy_*

### Active
- History filters bindings + Copy/Clear rounds (мелкие доработки)

### Blocked
- (none)
