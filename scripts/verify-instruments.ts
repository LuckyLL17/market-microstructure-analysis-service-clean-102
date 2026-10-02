import assert from 'node:assert/strict';
import { MarketEngine } from '../src/engine.js';
import { MarketEvent } from '../src/types.js';

let failures = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}`); console.error(error instanceof Error ? error.message : error); }
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}`); console.error(error instanceof Error ? error.message : error); }
}

const DAY1 = '2026-10-01';
const DAY2 = '2026-10-02';
const base = Date.parse('2026-10-01T09:30:00.000Z');
const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString();
const betaEvent = (id: string, sequence: number, overrides: Partial<MarketEvent>): MarketEvent => ({ id, symbol: 'BETA', tradingDay: DAY1, timestamp: at(sequence), sequence, type: 'new_order', ...overrides });

// ---------- 引擎层：ALPHA 兼容 ----------
const engine = new MarketEngine();
test('ALPHA 保留原有注册信息与种子行情', () => {
  assert.deepEqual(engine.instruments.get('ALPHA'), { symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: 0.01, lotSize: 1, currency: 'USD', status: 'replay_ready' });
  assert.equal(engine.events.length, 13);
  const analytics = engine.analytics('ALPHA');
  assert.ok(analytics.bestBid !== null && analytics.bestAsk !== null);
});

// ---------- 注册第二品种 + 交错接入 ----------
const BETA = { symbol: 'BETA', tradingDay: DAY1, tickSize: 0.05, lotSize: 10, currency: 'USD', status: 'active' as const };
test('注册 BETA，重复注册幂等', () => {
  assert.equal(engine.instruments.register(BETA).created, true);
  const again = engine.instruments.register({ ...BETA, tickSize: 0.01 });
  assert.equal(again.created, false);
  assert.equal(again.instrument.tickSize, 0.05);
  assert.equal(engine.instruments.list().length, 2);
});

const A14: MarketEvent = { id: 'A-14', symbol: 'ALPHA', tradingDay: '2026-09-30', timestamp: '2026-09-30T09:30:14.000Z', sequence: 14, type: 'new_order', orderId: 'A-O14', side: 'buy', price: 99.98, quantity: 25 };
const A15: MarketEvent = { id: 'A-15', symbol: 'ALPHA', tradingDay: '2026-09-30', timestamp: '2026-09-30T09:30:15.000Z', sequence: 15, type: 'trade', aggressorSide: 'sell', price: 99.98, quantity: 30 };
test('两个品种交错接入，订单簿互不污染', () => {
  assert.equal(engine.ingest(betaEvent('B-1', 1, { type: 'snapshot', bids: [{ price: 199.95, quantity: 100 }, { price: 199.9, quantity: 200 }], asks: [{ price: 200.05, quantity: 150 }, { price: 200.1, quantity: 250 }] })).accepted, true);
  assert.equal(engine.ingest(A14).accepted, true);
  assert.equal(engine.ingest(betaEvent('B-2', 2, { orderId: 'B-O2', side: 'buy', price: 199.95, quantity: 50 })).accepted, true);
  assert.equal(engine.ingest(A15).accepted, true);
  assert.equal(engine.ingest(betaEvent('B-3', 3, { orderId: 'B-O3', side: 'sell', price: 200.05, quantity: 30 })).accepted, true);
  assert.equal(engine.ingest(betaEvent('B-4', 4, { type: 'trade', aggressorSide: 'buy', price: 200.05, quantity: 40 })).accepted, true);

  const beta = engine.book('BETA').snapshot(20);
  assert.deepEqual(beta.bids, [{ price: 199.95, quantity: 150 }, { price: 199.9, quantity: 200 }]);
  assert.deepEqual(beta.asks, [{ price: 200.05, quantity: 140 }, { price: 200.1, quantity: 250 }]);
  assert.deepEqual(engine.book('BETA').getStats(), { tradeCount: 1, tradedQuantity: 40, sequence: 4, timestamp: at(4) });

  const reference = new MarketEngine();
  reference.ingest(A14);
  reference.ingest(A15);
  assert.deepEqual(engine.book('ALPHA').snapshot(20), reference.book('ALPHA').snapshot(20));
  assert.equal(engine.events.filter(e => e.symbol === 'ALPHA').length, 15);
  assert.equal(engine.events.filter(e => e.symbol === 'BETA').length, 4);
});

// ---------- 拒绝路径：不污染其他品种 ----------
test('未知品种事件被拒绝且不建簿', () => {
  const result = engine.ingest({ id: 'G-1', symbol: 'GAMMA', tradingDay: DAY1, timestamp: at(10), sequence: 1, type: 'new_order', orderId: 'G-O1', side: 'buy', price: 10, quantity: 10 });
  assert.equal(result.accepted, false);
  assert.equal(result.anomaly?.type, 'unknown_symbol');
  assert.equal(engine.books.has('GAMMA'), false);
  assert.equal(engine.events.filter(e => e.symbol === 'GAMMA').length, 0);
});

test('跨交易日、非法价格数量、重复序号均被拒绝且订单簿不变', () => {
  const before = JSON.stringify(engine.book('BETA').snapshot(20));
  const eventCount = engine.events.length;
  assert.equal(engine.ingest(betaEvent('B-5', 5, { tradingDay: '2026-09-30', orderId: 'B-O5', side: 'buy', price: 200.05, quantity: 10 })).anomaly?.type, 'trading_day_mismatch');
  assert.equal(engine.ingest(betaEvent('B-5', 5, { orderId: 'B-O5', side: 'buy', price: 200.03, quantity: 10 })).anomaly?.type, 'invalid_price');
  assert.equal(engine.ingest(betaEvent('B-5', 5, { orderId: 'B-O5', side: 'buy', price: 200.05, quantity: 7 })).anomaly?.type, 'invalid_quantity');
  assert.equal(engine.ingest(betaEvent('B-4', 4, { type: 'trade', aggressorSide: 'buy', price: 200.05, quantity: 40 })).anomaly?.type, 'duplicate_sequence');
  assert.equal(engine.events.length, eventCount);
  assert.equal(JSON.stringify(engine.book('BETA').snapshot(20)), before);
});

test('ALPHA 跨交易日事件被拒绝且 ALPHA 订单簿不变', () => {
  const before = JSON.stringify(engine.book('ALPHA').snapshot(20));
  const result = engine.ingest({ id: 'A-16', symbol: 'ALPHA', tradingDay: DAY1, timestamp: '2026-09-30T09:30:16.000Z', sequence: 16, type: 'new_order', orderId: 'A-O16', side: 'buy', price: 100, quantity: 10 });
  assert.equal(result.accepted, false);
  assert.equal(result.anomaly?.type, 'trading_day_mismatch');
  assert.equal(JSON.stringify(engine.book('ALPHA').snapshot(20)), before);
});

// ---------- 沙盒订单共享规则 ----------
test('订单校验：未知品种、非法价格数量均被拒绝', () => {
  const unknown = engine.submitOrder({ strategyId: 'S1', symbol: 'GAMMA', side: 'buy', orderType: 'limit', price: 10, quantity: 10 });
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.risk.rule, 'instrument');
  assert.equal(unknown.risk.code, 'UNKNOWN_SYMBOL');
  assert.equal(engine.books.has('GAMMA'), false);

  const badPrice = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.03, quantity: 10 });
  assert.equal(badPrice.accepted, false);
  assert.equal(badPrice.risk.code, 'INVALID_PRICE');

  const badQuantity = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 7 });
  assert.equal(badQuantity.accepted, false);
  assert.equal(badQuantity.risk.code, 'INVALID_QUANTITY');
});

test('合法 BETA 限价单成交，ALPHA 市价单保持兼容', () => {
  const fill = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 20 });
  assert.equal(fill.accepted, true);
  assert.equal(fill.fills.length, 1);
  assert.equal(fill.fills[0].symbol, 'BETA');
  assert.equal(fill.fills[0].price, 200.05);
  assert.equal(fill.fills[0].quantity, 20);

  const alphaMarket = engine.submitOrder({ strategyId: 'S1', symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 10 });
  assert.equal(alphaMarket.accepted, true);
  assert.ok(alphaMarket.fills.length >= 1);

  const noPosition = engine.submitOrder({ strategyId: 'S2', symbol: 'BETA', side: 'sell', orderType: 'market', quantity: 10 });
  assert.equal(noPosition.accepted, false);
  assert.equal(noPosition.risk.code, 'INSUFFICIENT_POSITION');
});

test('clientOrderId 重复请求幂等，不产生新成交', () => {
  const first = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 10, clientOrderId: 'C-1' });
  assert.equal(first.accepted, true);
  const fillCount = engine.fills.length;
  const second = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 10, clientOrderId: 'C-1' });
  assert.equal(second.duplicate, true);
  assert.equal(second.orderId, first.orderId);
  assert.equal(engine.fills.length, fillCount);
});

// ---------- 规则变化 ----------
test('停牌拒绝事件与订单，复牌恢复', () => {
  engine.instruments.updateRules('BETA', { status: 'suspended' });
  assert.equal(engine.ingest(betaEvent('B-5', 5, { orderId: 'B-O5', side: 'buy', price: 200.05, quantity: 10 })).anomaly?.type, 'instrument_suspended');
  const order = engine.submitOrder({ strategyId: 'S1', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 10 });
  assert.equal(order.accepted, false);
  assert.equal(order.risk.code, 'INSTRUMENT_SUSPENDED');

  engine.instruments.updateRules('BETA', { status: 'active' });
  assert.equal(engine.ingest(betaEvent('B-5', 5, { orderId: 'B-O5', side: 'buy', price: 200.05, quantity: 10 })).accepted, true);
});

test('tickSize 变化后原先非法价格转为合法', () => {
  engine.instruments.updateRules('BETA', { tickSize: 0.01 });
  assert.equal(engine.ingest(betaEvent('B-6', 6, { orderId: 'B-O6', side: 'buy', price: 200.03, quantity: 10 })).accepted, true);
});

test('交易日滚动的跨日事件处理', () => {
  engine.instruments.updateRules('BETA', { tradingDay: DAY2 });
  assert.equal(engine.ingest(betaEvent('B-7', 7, { orderId: 'B-O7', side: 'buy', price: 200.05, quantity: 10 })).anomaly?.type, 'trading_day_mismatch');
  assert.equal(engine.ingest(betaEvent('B-7', 7, { tradingDay: DAY2, orderId: 'B-O7', side: 'buy', price: 200.05, quantity: 10 })).accepted, true);
  assert.equal(engine.instruments.updateRules('GAMMA', { status: 'active' }), undefined);
});

test('所有拒绝均记录异常且未污染其他品种', () => {
  const types = new Set(engine.anomalies.map(item => item.type));
  for (const type of ['unknown_symbol', 'trading_day_mismatch', 'invalid_price', 'invalid_quantity', 'duplicate_sequence', 'instrument_suspended', 'instrument_violation']) assert.ok(types.has(type), `缺少异常类型 ${type}`);
  assert.deepEqual([...engine.books.keys()].sort(), ['ALPHA', 'BETA']);
});

// ---------- HTTP 层 ----------
await import('../src/server.js');
const http = 'http://127.0.0.1:6190';
const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => fetch(`${http}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await testAsync('GET /api/instruments 返回 ALPHA 且形状兼容', async () => {
  const res = await fetch(`${http}/api/instruments`);
  const list = await res.json() as Array<Record<string, unknown>>;
  assert.equal(res.status, 200);
  assert.deepEqual(list[0], { symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: 0.01, lotSize: 1, currency: 'USD', status: 'replay_ready' });
});

await testAsync('POST /api/instruments 注册、幂等与参数校验', async () => {
  const created = await post('/api/instruments', BETA);
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { created: boolean }).created, true);

  const again = await post('/api/instruments', BETA);
  assert.equal(again.status, 200);
  assert.equal((await again.json() as { created: boolean }).created, false);

  assert.equal((await post('/api/instruments', { symbol: 'BAD', tradingDay: DAY1, currency: 'USD', tickSize: -1, lotSize: 1 })).status, 400);
  assert.equal((await post('/api/instruments', { symbol: 'BAD', tradingDay: DAY1, currency: 'USD', tickSize: 0.01, lotSize: 1, status: 'unknown' })).status, 400);
});

await testAsync('PATCH /api/instruments/:symbol 规则变更与未知品种', async () => {
  const updated = await patch('/api/instruments/BETA', { lotSize: 5 });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { lotSize: number }).lotSize, 5);
  assert.equal((await patch('/api/instruments/BETA', { tickSize: 0 })).status, 400);
  const missing = await patch('/api/instruments/NOPE', { status: 'active' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: string }).error, 'unknown_symbol');
  await patch('/api/instruments/BETA', { lotSize: 10 });
});

await testAsync('行情事件：未知品种拒绝、重复序号拒绝、合法接受', async () => {
  const unknown = await post('/api/market-data/events', { id: 'H-1', symbol: 'NOPE', tradingDay: DAY1, timestamp: at(1), sequence: 1, type: 'new_order', orderId: 'H-O1', side: 'buy', price: 1, quantity: 1 });
  const unknownBody = await unknown.json() as { accepted: boolean; anomaly?: { type: string } };
  assert.equal(unknownBody.accepted, false);
  assert.equal(unknownBody.anomaly?.type, 'unknown_symbol');

  const snapshot = betaEvent('HB-1', 1, { type: 'snapshot', bids: [{ price: 199.95, quantity: 100 }], asks: [{ price: 200.05, quantity: 100 }] });
  assert.equal((await (await post('/api/market-data/events', snapshot)).json() as { accepted: boolean }).accepted, true);
  const duplicate = await (await post('/api/market-data/events', snapshot)).json() as { accepted: boolean; anomaly?: { type: string } };
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.anomaly?.type, 'duplicate_sequence');
});

await testAsync('订单簿/指标/指标汇总对未知品种返回 404', async () => {
  for (const path of ['/api/orderbook/NOPE', '/api/analytics/NOPE', '/api/metrics?symbol=NOPE']) {
    const res = await fetch(`${http}${path}`);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json() as { error: string }).error, 'unknown_symbol');
  }
  const betaBook = await (await fetch(`${http}/api/orderbook/BETA`)).json() as { bids: unknown[]; asks: unknown[] };
  assert.equal(betaBook.bids.length, 1);
  assert.equal(betaBook.asks.length, 1);
  const alphaBook = await (await fetch(`${http}/api/orderbook/ALPHA`)).json() as { bids: unknown[] };
  assert.ok(alphaBook.bids.length > 0);
});

await testAsync('沙盒订单：未知品种与非法价格被拒绝，停牌拒绝', async () => {
  const unknown = await (await post('/api/sandbox/orders', { strategyId: 'HTTP-S', symbol: 'NOPE', side: 'buy', orderType: 'limit', price: 1, quantity: 1 })).json() as { accepted: boolean; risk: { code: string } };
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.risk.code, 'UNKNOWN_SYMBOL');

  const badPrice = await (await post('/api/sandbox/orders', { strategyId: 'HTTP-S', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.03, quantity: 10 })).json() as { accepted: boolean; risk: { code: string } };
  assert.equal(badPrice.accepted, false);
  assert.equal(badPrice.risk.code, 'INVALID_PRICE');

  await patch('/api/instruments/BETA', { status: 'suspended' });
  const suspendedEvent = await (await post('/api/market-data/events', betaEvent('HB-2', 2, { orderId: 'HB-O2', side: 'buy', price: 200.05, quantity: 10 }))).json() as { accepted: boolean; anomaly?: { type: string } };
  assert.equal(suspendedEvent.accepted, false);
  assert.equal(suspendedEvent.anomaly?.type, 'instrument_suspended');
  const suspendedOrder = await (await post('/api/sandbox/orders', { strategyId: 'HTTP-S', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 200.05, quantity: 10 })).json() as { accepted: boolean; risk: { code: string } };
  assert.equal(suspendedOrder.accepted, false);
  assert.equal(suspendedOrder.risk.code, 'INSTRUMENT_SUSPENDED');
  await patch('/api/instruments/BETA', { status: 'active' });
});

await testAsync('重放会话：未知品种 404，BETA 会话只含 BETA 事件', async () => {
  assert.equal((await post('/api/replay/sessions', { symbol: 'NOPE' })).status, 404);
  const session = await (await post('/api/replay/sessions', { symbol: 'BETA' })).json() as { symbol: string; tradingDay: string; eventCount: number };
  assert.equal(session.symbol, 'BETA');
  assert.equal(session.tradingDay, DAY1);
  assert.equal(session.eventCount, 1);
});

console.log(failures ? `\n${failures} 项验证失败` : '\n全部验证通过');
process.exit(failures ? 1 : 0);
