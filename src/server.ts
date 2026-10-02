import Fastify from 'fastify';
import cors from '@fastify/cors';
import { MarketEngine, OrderInput } from './engine.js';
import { Instrument, InstrumentRules, InstrumentStatus } from './instruments.js';
import { OrderBook } from './order-book.js';
import { MarketEvent } from './types.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const engine = new MarketEngine();
type ReplaySession = { id: string; symbol: string; tradingDay: string; cursor: number; status: string; speed: number; eventCount: number; lastEvent?: MarketEvent; book: OrderBook };
const replaySessions = new Map<string, ReplaySession>();
const INSTRUMENT_STATUSES: InstrumentStatus[] = ['active', 'suspended', 'replay_ready'];
const unknownSymbol = (symbol: string) => ({ error: 'unknown_symbol', symbol });

app.get('/api/health', async () => ({ status: 'ok', service: 'market-microstructure-analysis-service', version: '0.1.0' }));
app.get('/api/instruments', async () => engine.instruments.list());
app.post('/api/instruments', async (request, reply) => {
  const body = (request.body ?? {}) as Partial<Instrument>;
  const status = body.status ?? 'active';
  const { symbol, tradingDay, currency, tickSize, lotSize } = body;
  if (!symbol || !tradingDay || !currency || !(tickSize! > 0) || !(lotSize! > 0) || !INSTRUMENT_STATUSES.includes(status)) { reply.code(400); return { error: 'invalid_instrument', message: 'symbol、tradingDay、currency 为必填，tickSize/lotSize 必须为正数，status 仅支持 active/suspended/replay_ready' }; }
  const { instrument, created } = engine.instruments.register({ symbol: symbol!, tradingDay: tradingDay!, tickSize: tickSize!, lotSize: lotSize!, currency: currency!, status });
  reply.code(created ? 201 : 200);
  return { ...instrument, created };
});
app.patch('/api/instruments/:symbol', async (request, reply) => {
  const { symbol } = request.params as { symbol: string };
  const rules = (request.body ?? {}) as InstrumentRules;
  if (rules.tickSize !== undefined && !(rules.tickSize > 0)) { reply.code(400); return { error: 'invalid_rules', message: 'tickSize 必须为正数' }; }
  if (rules.lotSize !== undefined && !(rules.lotSize > 0)) { reply.code(400); return { error: 'invalid_rules', message: 'lotSize 必须为正数' }; }
  if (rules.status !== undefined && !INSTRUMENT_STATUSES.includes(rules.status)) { reply.code(400); return { error: 'invalid_rules', message: 'status 仅支持 active/suspended/replay_ready' }; }
  const instrument = engine.instruments.updateRules(symbol, rules);
  if (!instrument) { reply.code(404); return unknownSymbol(symbol); }
  return instrument;
});
app.post('/api/market-data/events', async request => { const event = request.body as MarketEvent; return engine.ingest(event); });
app.get('/api/orderbook/:symbol', async (request, reply) => { const { symbol } = request.params as { symbol: string }; if (!engine.instruments.has(symbol)) { reply.code(404); return unknownSymbol(symbol); } return { symbol, ...engine.book(symbol).snapshot(20), stats: engine.book(symbol).getStats() }; });
app.get('/api/analytics/:symbol', async (request, reply) => { const { symbol } = request.params as { symbol: string }; if (!engine.instruments.has(symbol)) { reply.code(404); return unknownSymbol(symbol); } return engine.analytics(symbol); });
app.post('/api/replay/sessions', async (request, reply) => {
  const body = (request.body ?? {}) as { symbol?: string; tradingDay?: string; speed?: number };
  const symbol = body.symbol ?? 'ALPHA';
  const instrument = engine.instruments.get(symbol);
  if (!instrument) { reply.code(404); return unknownSymbol(symbol); }
  const tradingDay = body.tradingDay ?? instrument.tradingDay;
  const id = `REP-${replaySessions.size + 1}`;
  const events = engine.events.filter(event => event.symbol === symbol && event.tradingDay === tradingDay);
  const session: ReplaySession = { id, symbol, tradingDay, cursor: 0, status: 'ready', speed: body.speed ?? 1, eventCount: events.length, book: new OrderBook(symbol) };
  replaySessions.set(id, session);
  return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, nextEvent: events[0], book: session.book.snapshot(20) };
});
app.get('/api/replay/sessions/:id', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, progress: session.eventCount ? +(session.cursor / session.eventCount * 100).toFixed(2) : 100, currentEvent: events[session.cursor - 1], nextEvent: events[session.cursor], book: session.book.snapshot(20) }; });
app.post('/api/replay/sessions/:id/step', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); const event = events[session.cursor]; if (!event) { session.status = 'completed'; return { ...session, done: true }; } session.cursor += 1; session.book.apply(event); session.lastEvent = event; session.status = session.cursor >= events.length ? 'completed' : 'paused'; return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, event, done: session.status === 'completed', book: session.book.snapshot(20) }; });
app.post('/api/replay/sessions/:id/run', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const body = (request.body ?? {}) as { steps?: number }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); const steps = Math.min(body.steps ?? events.length, events.length - session.cursor); for (const event of events.slice(session.cursor, session.cursor + Math.max(0, steps))) session.book.apply(event); session.cursor += Math.max(0, steps); session.status = session.cursor >= events.length ? 'completed' : 'paused'; session.lastEvent = events[session.cursor - 1]; return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, processed: steps, done: session.status === 'completed', book: session.book.snapshot(20) }; });
app.post('/api/sandbox/orders', async request => engine.submitOrder(request.body as OrderInput));
app.post('/api/sandbox/cancel', async request => { const body = request.body as { strategyId: string; orderId: string }; return { cancelled: engine.cancel(body.strategyId, body.orderId) }; });
app.get('/api/sandbox/strategies/:strategyId/performance', async request => engine.performance((request.params as { strategyId: string }).strategyId));
app.get('/api/sandbox/strategies/:strategyId/events', async request => { const strategyId = (request.params as { strategyId: string }).strategyId; return { orders: engine.anomalies.filter(item => item.detail && (item.detail as { strategyId?: string }).strategyId === strategyId), fills: engine.fills }; });
app.get('/api/anomalies', async () => engine.anomalies);
app.get('/api/metrics', async (request, reply) => { const { symbol = 'ALPHA' } = request.query as { symbol?: string }; if (!engine.instruments.has(symbol)) { reply.code(404); return unknownSymbol(symbol); } return { analytics: engine.analytics(symbol), eventCount: engine.events.length, fillCount: engine.fills.length, anomalyCount: engine.anomalies.length, bookStats: engine.book(symbol).getStats() }; });

await app.listen({ port: 6190, host: '127.0.0.1' });
