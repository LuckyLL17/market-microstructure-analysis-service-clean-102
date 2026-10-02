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

## 品种与交易规则

品种由 `src/instruments.ts` 中的注册中心统一维护，所有行情接入、订单提交、订单簿、指标、回放和统计接口共享同一份规则：

- `symbol`：注册后才允许使用，路由会规范化大小写；未知品种返回 `UNKNOWN_INSTRUMENT`
- `tradingDay`：实时事件、实时订单簿和指标必须属于当前交易日；跨日事件返回 `CROSS_TRADING_DAY`
- `tickSize`：报价、限价单价格必须是最小变动价位的整数倍
- `lotSize`：行情数量和订单数量必须是最小交易单位的正整数倍
- `currency`：成交记录和资金校验使用品种币种
- `status`：`active`、`replay_ready` 可交易；`suspended` 会拒绝实时行情、订单、订单簿、指标和回放

当前内置 `ALPHA`（0.01 / 1 股 / USD / `replay_ready`）和 `BETA`（0.05 / 10 股 / USD / `active`）。切换品种交易日会只重置该品种的实时订单簿，不影响其他品种；历史行情仍可通过按交易日过滤的回放会话查看。

非法请求会返回明确的 4xx 错误码。重复行情事件不会再次应用；沙盒订单可携带 `requestId` 实现幂等重放。

## 关键接口

```text
GET  /api/health
GET  /api/instruments
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

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。
