# 市场微观结构分析服务

纯后端 Node.js + TypeScript 服务，用于订单簿事件接入、历史行情重放、市场微观结构指标分析、策略沙盒、风险校验和撮合仿真。

## 能力范围

- 订单簿快照、逐笔成交、新单、撤单、行情事件接入
- 按交易日与时间顺序重放市场状态，支持单步、倍速运行
- 盘口深度、价差、订单失衡、冲击成本、成交概率、滑点、流动性指标
- 策略沙盒限价单/市价单模拟，保留资金、持仓、成交与审计轨迹
- 资金、持仓、下单频率、撤单率、价格偏离、最大回撤风险规则
- 价格优先/时间优先的基础撮合与部分成交
- 策略收益、风险暴露、最大回撤、成交率与异常交易事件

## 启动

```bash
npm install
npm run dev
```

服务默认运行在 `http://127.0.0.1:6190`。

## 关键接口

```text
GET  /api/health
GET  /api/instruments
POST /api/instruments
PATCH /api/instruments/:symbol
POST /api/market-data/events
GET  /api/orderbook/:symbol
POST /api/replay/sessions
GET  /api/replay/sessions/:id
POST /api/replay/sessions/:id/step
POST /api/replay/sessions/:id/run
GET  /api/analytics/:symbol
POST /api/sandbox/orders
POST /api/sandbox/cancel
GET  /api/sandbox/strategies/:strategyId/performance
GET  /api/sandbox/strategies/:strategyId/events
GET  /api/anomalies
GET  /api/metrics
```

## 品种注册与交易规则

`src/instruments.ts` 统一维护每个品种的 `tradingDay`、`tickSize`、`lotSize`、`currency`、`status`（`active` / `suspended` / `replay_ready`）。行情接入、沙盒下单、订单簿与指标查询共享同一套规则：

- 未注册品种：行情事件与订单被拒绝并记录 `unknown_symbol` 异常；订单簿、指标、重放等查询接口返回 404 `unknown_symbol`，不会创建订单簿。
- 停牌品种（`suspended`）：事件与订单被拒绝，记录 `instrument_suspended`；查询历史数据仍可用。
- 非法价格/数量：未对齐 `tickSize`/`lotSize` 或为非正数时拒绝，记录 `invalid_price` / `invalid_quantity`。
- 跨交易日事件：`tradingDay` 与品种当前交易日不一致时拒绝，记录 `trading_day_mismatch`；可通过 `PATCH /api/instruments/:symbol` 滚动交易日。
- 重复请求：同品种重复 `sequence` 的事件被拒绝（`duplicate_sequence`）；重复注册幂等返回既有品种；沙盒订单支持 `clientOrderId` 幂等，重复提交返回首个结果并标记 `duplicate: true`。
- 所有拒绝只记录异常，不会写入事件流或改动任何品种的订单簿。

内置 ALPHA 品种（`2026-09-30`、tickSize 0.01、lotSize 1、USD、`replay_ready`）保持原有行为。运行 `npm run verify` 可执行两品种交错、规则变化与重复请求的完整验证。

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。
