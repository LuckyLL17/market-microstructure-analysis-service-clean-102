import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { MarketEngine } from './engine.js';
import { OrderBook } from './order-book.js';
import { InstrumentRule, isTradableStatus, RuleViolationError } from './instruments.js';
import { MarketEvent } from './types.js';

export type ReplaySession = {
  id: string;
  symbol: string;
  tradingDay: string;
  cursor: number;
  status: string;
  speed: number;
  eventCount: number;
  lastEvent?: MarketEvent;
  book: OrderBook;
};

export async function createServer(engine = new MarketEngine()): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  const replaySessions = new Map<string, ReplaySession>();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuleViolationError) {
      reply.status(error.statusCode).send({ error: error.code, code: error.code, message: error.message });
      return;
    }
    app.log.error(error);
    reply.status(500).send({ error: 'INTERNAL_ERROR', message: '服务内部错误' });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'market-microstructure-analysis-service',
    version: '0.1.0',
  }));

  app.get('/api/instruments', async () => engine.registry.list());

  app.post('/api/market-data/events', async (request, reply) => {
    const result = engine.ingest(request.body);
    if (!result.accepted) return reply.status(result.statusCode).send(result);
    return result;
  });

  app.get('/api/orderbook/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const { tradingDay } = request.query as { tradingDay?: string };
    const rule = engine.rule(symbol);
    if (tradingDay !== undefined && tradingDay !== rule.tradingDay) {
      return reply.status(409).send({ error: 'CROSS_TRADING_DAY', code: 'CROSS_TRADING_DAY', symbol: rule.symbol, message: `当前交易日为 ${rule.tradingDay}，不能查询 ${tradingDay} 的实时订单簿` });
    }
    if (!isTradableStatus(rule.status)) {
      return reply.status(409).send({
        error: 'INSTRUMENT_SUSPENDED',
        code: 'INSTRUMENT_SUSPENDED',
        symbol: rule.symbol,
        message: `品种 ${rule.symbol} 当前停牌`,
      });
    }
    const book = engine.book(rule.symbol);
    return { symbol: rule.symbol, instrument: publicRule(rule), ...book.snapshot(20), stats: book.getStats() };
  });

  app.get('/api/analytics/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const { tradingDay } = request.query as { tradingDay?: string };
    const rule = engine.rule(symbol);
    if (tradingDay !== undefined && tradingDay !== rule.tradingDay) {
      return reply.status(409).send({ error: 'CROSS_TRADING_DAY', code: 'CROSS_TRADING_DAY', symbol: rule.symbol, message: `当前交易日为 ${rule.tradingDay}，不能查询 ${tradingDay} 的实时指标` });
    }
    if (!isTradableStatus(rule.status)) {
      throw new RuleViolationError(409, 'INSTRUMENT_SUSPENDED', `品种 ${rule.symbol} 当前停牌`);
    }
    return engine.analytics(rule.symbol);
  });

  app.post('/api/replay/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as { symbol?: string; tradingDay?: string; speed?: number };
    const symbol = engine.registry.normalizeSymbol(body.symbol ?? 'ALPHA');
    const rule = engine.rule(symbol);
    if (!isTradableStatus(rule.status)) {
      return reply.status(409).send({ error: 'INSTRUMENT_SUSPENDED', code: 'INSTRUMENT_SUSPENDED', symbol, message: `品种 ${symbol} 当前停牌` });
    }
    const tradingDay = body.tradingDay ?? rule.tradingDay;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay) || Number.isNaN(new Date(`${tradingDay}T00:00:00Z`).getTime())) {
      return reply.status(400).send({ error: 'INVALID_TRADING_DAY', code: 'INVALID_TRADING_DAY', message: 'tradingDay 必须是 YYYY-MM-DD 格式' });
    }
    if (body.speed !== undefined && (!Number.isFinite(body.speed) || body.speed <= 0)) {
      return reply.status(400).send({ error: 'INVALID_SPEED', code: 'INVALID_SPEED', message: 'speed 必须是正数' });
    }

    const events = replayEvents(engine, symbol, tradingDay);
    if (!events.length && tradingDay !== rule.tradingDay) {
      return reply.status(404).send({ error: 'TRADING_DAY_NOT_FOUND', code: 'TRADING_DAY_NOT_FOUND', message: `没有 ${symbol} 在 ${tradingDay} 的行情事件` });
    }

    const id = `REP-${replaySessions.size + 1}`;
    const session: ReplaySession = {
      id,
      symbol,
      tradingDay,
      cursor: 0,
      status: 'ready',
      speed: body.speed ?? 1,
      eventCount: events.length,
      book: new OrderBook(symbol),
    };
    replaySessions.set(id, session);
    return replayView(session, events);
  });

  app.get('/api/replay/sessions/:id', async (request, reply) => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return reply.status(404).send({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: '回放会话不存在' });
    const rule = engine.rule(session.symbol);
    if (!isTradableStatus(rule.status)) {
      return reply.status(409).send({ error: 'INSTRUMENT_SUSPENDED', code: 'INSTRUMENT_SUSPENDED', symbol: session.symbol, message: `品种 ${session.symbol} 当前停牌` });
    }
    const events = replayEvents(engine, session.symbol, session.tradingDay);
    return replayView(session, events);
  });

  app.post('/api/replay/sessions/:id/step', async (request, reply) => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return reply.status(404).send({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: '回放会话不存在' });
    const rule = engine.rule(session.symbol);
    if (!isTradableStatus(rule.status)) {
      return reply.status(409).send({ error: 'INSTRUMENT_SUSPENDED', code: 'INSTRUMENT_SUSPENDED', symbol: session.symbol, message: `品种 ${session.symbol} 当前停牌` });
    }
    const events = replayEvents(engine, session.symbol, session.tradingDay);
    const event = events[session.cursor];
    if (!event) {
      session.status = 'completed';
      return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, done: true, book: session.book.snapshot(20) };
    }
    session.cursor += 1;
    const validatedEvent = applyReplayEvent(engine, session.book, event);
    session.lastEvent = validatedEvent ?? event;
    session.status = session.cursor >= events.length ? 'completed' : 'paused';
    return {
      id: session.id,
      symbol: session.symbol,
      tradingDay: session.tradingDay,
      cursor: session.cursor,
      status: session.status,
      event,
      done: session.status === 'completed',
      book: session.book.snapshot(20),
    };
  });

  app.post('/api/replay/sessions/:id/run', async (request, reply) => {
    const session = replaySessions.get((request.params as { id: string }).id);
    if (!session) return reply.status(404).send({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND', message: '回放会话不存在' });
    const rule = engine.rule(session.symbol);
    if (!isTradableStatus(rule.status)) {
      return reply.status(409).send({ error: 'INSTRUMENT_SUSPENDED', code: 'INSTRUMENT_SUSPENDED', symbol: session.symbol, message: `品种 ${session.symbol} 当前停牌` });
    }
    const body = (request.body ?? {}) as { steps?: number };
    if (body.steps !== undefined && (!Number.isSafeInteger(body.steps) || body.steps < 0)) {
      return reply.status(400).send({ error: 'INVALID_STEPS', code: 'INVALID_STEPS', message: 'steps 必须是非负整数' });
    }
    const events = replayEvents(engine, session.symbol, session.tradingDay);
    const steps = Math.min(body.steps ?? events.length, events.length - session.cursor);
    for (const event of events.slice(session.cursor, session.cursor + Math.max(0, steps))) applyReplayEvent(engine, session.book, event);
    session.cursor += Math.max(0, steps);
    session.status = session.cursor >= events.length ? 'completed' : 'paused';
    session.lastEvent = events[session.cursor - 1];
    return {
      id: session.id,
      symbol: session.symbol,
      tradingDay: session.tradingDay,
      cursor: session.cursor,
      status: session.status,
      processed: Math.max(0, steps),
      done: session.status === 'completed',
      book: session.book.snapshot(20),
    };
  });

  app.post('/api/sandbox/orders', async (request, reply) => {
    const result = engine.submitOrder(request.body);
    if (!result.accepted) return reply.status(result.statusCode).send(result);
    return result;
  });

  app.post('/api/sandbox/cancel', async (request, reply) => {
    const body = (request.body ?? {}) as { strategyId?: string; orderId?: string; symbol?: string };
    if (!body.strategyId || !body.orderId) {
      return reply.status(400).send({ cancelled: false, error: 'INVALID_CANCEL', code: 'INVALID_CANCEL', message: 'strategyId 和 orderId 不能为空' });
    }
    if (body.symbol !== undefined) engine.rule(body.symbol);
    return { cancelled: engine.cancel(body.strategyId, body.orderId, body.symbol) };
  });

  app.get('/api/sandbox/strategies/:strategyId/performance', async (request, reply) => {
    const { strategyId } = request.params as { strategyId: string };
    const { symbol } = request.query as { symbol?: string };
    if (symbol !== undefined) engine.rule(symbol);
    return engine.performance(strategyId, symbol);
  });

  app.get('/api/sandbox/strategies/:strategyId/events', async request => {
    const strategyId = (request.params as { strategyId: string }).strategyId;
    return engine.strategyEvents(strategyId);
  });

  app.get('/api/anomalies', async request => {
    const { symbol, tradingDay } = request.query as { symbol?: string; tradingDay?: string };
    let anomalies = engine.anomalies;
    if (symbol !== undefined) {
      const rule = engine.rule(symbol);
      anomalies = anomalies.filter(item => item.symbol === rule.symbol);
    }
    if (tradingDay !== undefined) anomalies = anomalies.filter(item => item.tradingDay === tradingDay);
    return anomalies;
  });

  app.get('/api/metrics', async request => {
    const query = request.query as { symbol?: string };
    const symbol = query.symbol ?? 'ALPHA';
    const rule = engine.rule(symbol);
    if (!isTradableStatus(rule.status)) {
      throw new RuleViolationError(409, 'INSTRUMENT_SUSPENDED', `品种 ${rule.symbol} 当前停牌`);
    }
    const events = engine.events.filter(event => event.symbol === rule.symbol && event.tradingDay === rule.tradingDay);
    const fills = engine.fills.filter(fill => fill.symbol === rule.symbol && fill.tradingDay === rule.tradingDay);
    const anomalies = engine.anomalies.filter(item => item.symbol === rule.symbol && item.tradingDay === rule.tradingDay);
    return {
      instrument: publicRule(rule),
      analytics: engine.analytics(rule.symbol),
      eventCount: events.length,
      fillCount: fills.length,
      anomalyCount: anomalies.length,
      bookStats: engine.book(rule.symbol).getStats(),
    };
  });

  return app;
}

function applyReplayEvent(engine: MarketEngine, book: OrderBook, event: MarketEvent): MarketEvent | undefined {
  const validation = engine.registry.validateReplayEvent(event);
  if (!validation.valid) return undefined;
  book.apply(validation.event);
  return validation.event;
}

function replayEvents(engine: MarketEngine, symbol: string, tradingDay: string): MarketEvent[] {
  return engine.events.filter(event => event.symbol === symbol && event.tradingDay === tradingDay);
}

function replayView(session: ReplaySession, events: MarketEvent[]) {
  return {
    id: session.id,
    symbol: session.symbol,
    tradingDay: session.tradingDay,
    cursor: session.cursor,
    status: session.status,
    speed: session.speed,
    eventCount: session.eventCount,
    progress: session.eventCount ? +(session.cursor / session.eventCount * 100).toFixed(2) : 100,
    currentEvent: events[session.cursor - 1],
    nextEvent: events[session.cursor],
    book: session.book.snapshot(20),
  };
}

function publicRule(rule: InstrumentRule) {
  return {
    symbol: rule.symbol,
    tradingDay: rule.tradingDay,
    tickSize: rule.tickSize,
    lotSize: rule.lotSize,
    currency: rule.currency,
    status: rule.status,
  };
}
