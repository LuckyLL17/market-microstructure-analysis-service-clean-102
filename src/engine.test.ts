import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from './app.js';
import { MarketEngine } from './engine.js';

const app = await createServer();

type InjectOptions = {
  method?: 'GET' | 'POST';
  payload?: unknown;
};

const json = async <T>(path: string, options: InjectOptions = {}) => {
  const response = await app.inject({ method: options.method ?? 'GET', url: path, payload: options.payload } as Record<string, unknown> as never);
  return { status: response.statusCode, body: response.json() as T };
};

describe('instrument registry and compatibility', () => {
  it('lists ALPHA and BETA while preserving ALPHA seed behavior', async () => {
    const instruments = await json<Array<{ symbol: string; tradingDay: string; tickSize: number; lotSize: number; currency: string; status: string }>>('/api/instruments');
    assert.equal(instruments.status, 200);
    assert.deepEqual(instruments.body.map(item => item.symbol), ['ALPHA', 'BETA']);
    assert.deepEqual(instruments.body[0], { symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: 0.01, lotSize: 1, currency: 'USD', status: 'replay_ready' });
    assert.deepEqual(instruments.body[1], { symbol: 'BETA', tradingDay: '2026-10-01', tickSize: 0.05, lotSize: 10, currency: 'USD', status: 'active' });

    const alpha = await json<{ eventCount: number; analytics: { bestBid: number; bestAsk: number } }>('/api/metrics?symbol=ALPHA');
    assert.equal(alpha.status, 200);
    assert.equal(alpha.body.eventCount, 13);
    assert.equal(alpha.body.analytics.bestBid, 100.01);
    assert.equal(alpha.body.analytics.bestAsk, 100.02);
  });
});

describe('interleaved instruments', () => {
  it('processes ALPHA and BETA independently by symbol and trading day', async () => {
    const betaBefore = await json<{ eventCount: number; bestBid: number; bestAsk: number }>('/api/metrics?symbol=BETA');
    const alphaBefore = await json<{ eventCount: number }>('/api/metrics?symbol=ALPHA');
    assert.equal(betaBefore.body.eventCount, 13);
    assert.equal(alphaBefore.body.eventCount, 13);

    const betaEvent = {
      id: `TEST-BETA-${Date.now()}-1`,
      symbol: 'beta',
      tradingDay: '2026-10-01',
      timestamp: '2026-10-01T09:45:00.000Z',
      sequence: 20,
      type: 'trade',
      aggressorSide: 'buy',
      price: 50.05,
      quantity: 10,
    };
    const alphaEvent = {
      id: `TEST-ALPHA-${Date.now()}-1`,
      symbol: 'ALPHA',
      tradingDay: '2026-09-30',
      timestamp: '2026-09-30T09:45:00.000Z',
      sequence: 20,
      type: 'trade',
      aggressorSide: 'buy',
      price: 100.02,
      quantity: 1,
    };

    const first = await json<{ accepted: boolean }>('/api/market-data/events', { method: 'POST', payload: betaEvent });
    const second = await json<{ accepted: boolean }>('/api/market-data/events', { method: 'POST', payload: alphaEvent });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.accepted, true);
    assert.equal(second.body.accepted, true);

    const betaAfter = await json<{ eventCount: number }>('/api/metrics?symbol=BETA');
    const alphaAfter = await json<{ eventCount: number }>('/api/metrics?symbol=ALPHA');
    assert.equal(betaAfter.body.eventCount, 14);
    assert.equal(alphaAfter.body.eventCount, 14);
  });

  it('rejects invalid BETA prices and quantities without creating or changing a book', async () => {
    const base = {
      symbol: 'BETA',
      tradingDay: '2026-10-01',
      timestamp: '2026-10-01T10:00:00.000Z',
      sequence: 100,
      type: 'new_order',
      orderId: 'INVALID-BETA-1',
      side: 'buy',
    };

    const tick = await json<{ code: string }>('/api/market-data/events', {
      method: 'POST',
      payload: { ...base, id: 'INVALID-BETA-TICK', price: 50.03, quantity: 10 },
    });
    const lot = await json<{ code: string }>('/api/market-data/events', {
      method: 'POST',
      payload: { ...base, id: 'INVALID-BETA-LOT', price: 50.05, quantity: 7 },
    });

    assert.equal(tick.status, 400);
    assert.equal(tick.body.code, 'INVALID_TICK_SIZE');
    assert.equal(lot.status, 400);
    assert.equal(lot.body.code, 'INVALID_LOT_SIZE');
  });
});

describe('unknown and suspended instruments', () => {
  it('returns explicit unknown instrument results and does not create books', async () => {
    const book = await json<{ code: string }>('/api/orderbook/GAMMA');
    const analytics = await json<{ code: string }>('/api/analytics/GAMMA');
    const order = await json<{ code: string }>('/api/sandbox/orders', {
      method: 'POST',
      payload: { strategyId: 's1', symbol: 'GAMMA', side: 'buy', orderType: 'limit', price: 1, quantity: 1 },
    });
    const event = await json<{ code: string }>('/api/market-data/events', {
      method: 'POST',
      payload: { id: 'G1', symbol: 'GAMMA', tradingDay: '2026-10-01', timestamp: '2026-10-01T10:00:00Z', sequence: 1, type: 'quote' },
    });

    assert.equal(book.status, 404);
    assert.equal(analytics.status, 404);
    assert.equal(order.status, 404);
    assert.equal(event.status, 404);
    for (const response of [book, analytics, order, event]) assert.equal(response.body.code, 'UNKNOWN_INSTRUMENT');
  });

  it('blocks suspended BETA market data, orders, books, analytics and replay while leaving ALPHA usable', async () => {
    const isolated = new MarketEngine();
    isolated.registry.update('BETA', { status: 'suspended' });
    const server = await createServer(isolated);

    const event = await server.inject({
      method: 'POST',
      url: '/api/market-data/events',
      payload: { id: 'S1', symbol: 'BETA', tradingDay: '2026-10-01', timestamp: '2026-10-01T10:00:00Z', sequence: 100, type: 'quote' },
    });
    const order = await server.inject({
      method: 'POST',
      url: '/api/sandbox/orders',
      payload: { strategyId: 'suspended-test', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 50.05, quantity: 10 },
    });
    const book = await server.inject({ method: 'GET', url: '/api/orderbook/BETA' });
    const analytics = await server.inject({ method: 'GET', url: '/api/analytics/BETA' });
    const replay = await server.inject({ method: 'POST', url: '/api/replay/sessions', payload: { symbol: 'BETA' } });
    const alpha = await server.inject({ method: 'GET', url: '/api/metrics?symbol=ALPHA' });

    for (const response of [event, order, book, analytics, replay]) {
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, 'INSTRUMENT_SUSPENDED');
    }
    assert.equal(alpha.statusCode, 200);
    assert.equal(alpha.json().eventCount, 13);
  });
});

describe('cross trading day', () => {
  it('rejects events for a different day, then switches day and resets only that instrument book', () => {
    const engine = new MarketEngine();
    const betaBookBefore = engine.book('BETA').getStats();
    assert.ok(betaBookBefore.sequence > 0);

    const stale = engine.ingest({
      id: 'STALE-BETA-1',
      symbol: 'BETA',
      tradingDay: '2026-09-30',
      timestamp: '2026-09-30T10:00:00.000Z',
      sequence: 100,
      type: 'quote',
    });
    assert.equal(stale.accepted, false);
    if (!stale.accepted) assert.equal(stale.code, 'CROSS_TRADING_DAY');

    const alphaStatsBefore = engine.book('ALPHA').getStats();
    const updated = engine.registry.update('BETA', { tradingDay: '2026-10-02' });
    assert.equal(updated.tradingDay, '2026-10-02');
    assert.deepEqual(engine.book('BETA').getStats(), { tradeCount: 0, tradedQuantity: 0, sequence: 0, timestamp: '' });
    assert.deepEqual(engine.book('ALPHA').getStats(), alphaStatsBefore);

    const nextDay = engine.ingest({
      id: 'NEXT-BETA-1',
      symbol: 'BETA',
      tradingDay: '2026-10-02',
      timestamp: '2026-10-02T09:30:00.000Z',
      sequence: 1,
      type: 'snapshot',
      bids: [{ price: 51.00, quantity: 10 }],
      asks: [{ price: 51.05, quantity: 10 }],
    });
    assert.equal(nextDay.accepted, true);
    assert.equal(engine.book('BETA').getStats().sequence, 1);
  });
});

describe('ALPHA compatibility', () => {
  it('still returns an explicit rejected result with HTTP 200 for a risk failure', async () => {
    const result = await json<{ accepted: boolean; code: string }>('/api/sandbox/orders', {
      method: 'POST',
      payload: {
        strategyId: 'legacy-risk-compat',
        symbol: 'ALPHA',
        side: 'sell',
        orderType: 'limit',
        price: 100.01,
        quantity: 1,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, false);
    assert.equal(result.body.code, 'INSUFFICIENT_POSITION');
  });
});

describe('cross trading day API', () => {
  it('rejects realtime orderbook and analytics queries for another trading day', async () => {
    const orderbook = await json<{ code: string }>('/api/orderbook/BETA?tradingDay=2026-09-30');
    const analytics = await json<{ code: string }>('/api/analytics/BETA?tradingDay=2026-09-30');
    assert.equal(orderbook.status, 409);
    assert.equal(analytics.status, 409);
    assert.equal(orderbook.body.code, 'CROSS_TRADING_DAY');
    assert.equal(analytics.body.code, 'CROSS_TRADING_DAY');
  });
});

describe('rule changes', () => {
  it('applies tick and lot changes to new BETA orders only', () => {
    const engine = new MarketEngine();
    const before = engine.analytics('BETA');
    assert.equal(before.lotSize, 10);
    assert.equal(before.tickSize, 0.05);

    engine.registry.update('BETA', { tickSize: 0.10, lotSize: 100 });
    const oldTick = engine.submitOrder({ strategyId: 'rule-test', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 50.05, quantity: 100 });
    const oldLot = engine.submitOrder({ strategyId: 'rule-test', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 50.10, quantity: 10 });
    assert.equal(oldTick.accepted, false);
    assert.equal(oldLot.accepted, false);
    if (!oldTick.accepted) assert.equal(oldTick.code, 'INVALID_TICK_SIZE');
    if (!oldLot.accepted) assert.equal(oldLot.code, 'INVALID_LOT_SIZE');

    const valid = engine.submitOrder({ strategyId: 'rule-test', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 50.10, quantity: 100 });
    assert.equal(valid.accepted, true);

    const alpha = engine.registry.get('ALPHA');
    assert.equal(alpha?.tickSize, 0.01);
    assert.equal(alpha?.lotSize, 1);
  });
});

describe('duplicate requests', () => {
  it('idempotently replays duplicate market events and sandbox order request ids', () => {
    const engine = new MarketEngine();
    const event = {
      id: 'DUP-EVENT-1',
      symbol: 'BETA',
      tradingDay: '2026-10-01',
      timestamp: '2026-10-01T11:00:00.000Z',
      sequence: 50,
      type: 'trade',
      aggressorSide: 'buy',
      price: 50.05,
      quantity: 10,
    } as const;

    const first = engine.ingest(event);
    const duplicate = engine.ingest(event);
    assert.equal(first.accepted, true);
    assert.equal(duplicate.accepted, false);
    if (!duplicate.accepted) assert.equal(duplicate.code, 'DUPLICATE_REQUEST');
    assert.equal(engine.events.filter(item => item.id === event.id).length, 1);

    const orderInput = { strategyId: 'dup-test', symbol: 'BETA', side: 'buy', orderType: 'limit', price: 50.05, quantity: 10, requestId: 'REQ-1' } as const;
    const order1 = engine.submitOrder(orderInput);
    const order2 = engine.submitOrder(orderInput);
    assert.equal(order1.accepted, true);
    assert.equal(order2.accepted, true);
    if (order1.accepted && order2.accepted) assert.equal(order1.orderId, order2.orderId);

    const conflicting = engine.submitOrder({ ...orderInput, quantity: 20 });
    assert.equal(conflicting.accepted, false);
    if (!conflicting.accepted) assert.equal(conflicting.code, 'IDEMPOTENCY_KEY_REUSED');
  });
});

describe('sandbox order isolation', () => {
  it('keeps ALPHA and BETA positions and fills separated', () => {
    const engine = new MarketEngine();
    const strategyId = 'multi-instrument';
    const alpha = engine.submitOrder({ strategyId, symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 10 });
    const beta = engine.submitOrder({ strategyId, symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 10 });
    assert.equal(alpha.accepted, true);
    assert.equal(beta.accepted, true);

    const alphaPerformance = engine.performance(strategyId, 'ALPHA');
    const betaPerformance = engine.performance(strategyId, 'BETA');
    assert.equal(alphaPerformance.metrics.fillCount, 1);
    assert.equal(betaPerformance.metrics.fillCount, 1);
    assert.equal(alphaPerformance.account.position.ALPHA, 10);
    assert.equal(alphaPerformance.account.position.BETA, 10);
    assert.equal(alphaPerformance.metrics.tradedNotional, 1000.2);
    assert.equal(betaPerformance.metrics.tradedNotional, 501);
  });
});

describe('replay', () => {
  it('replays each instrument from an isolated book without changing live state', async () => {
    const replayServer = await createServer(new MarketEngine());
    const response = await replayServer.inject({
      method: 'POST',
      url: '/api/replay/sessions',
      payload: { symbol: 'BETA', tradingDay: '2026-10-01' },
    });
    const created = response.json() as { id: string; symbol: string; eventCount: number };
    assert.equal(response.statusCode, 200);
    assert.equal(created.eventCount, 13);
    const stepResponse = await replayServer.inject({ method: 'POST', url: `/api/replay/sessions/${created.id}/step` });
    const step = stepResponse.json() as { event: { symbol: string }; book: { bids: unknown[] } };
    assert.equal(stepResponse.statusCode, 200);
    assert.equal(step.event.symbol, 'BETA');
    assert.ok(step.book.bids.length > 0);
  });
});
