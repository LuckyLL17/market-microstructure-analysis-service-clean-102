import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { InstrumentRegistry } from './instruments.js';
import { Analytics, BookOrder, Fill, MarketEvent, RiskDecision, Side } from './types.js';

export type OrderInput = { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number; clientOrderId?: string };
export type OrderResult = { accepted: boolean; risk: RiskDecision; fills: Fill[]; orderId: string; duplicate?: boolean };

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly instruments = new InstrumentRegistry();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();
  private readonly orderCache = new Map<string, OrderResult>();
  private orderSequence = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const violation = this.instruments.validateEvent(event);
    if (violation) return { accepted: false, anomaly: this.recordAnomaly(violation.anomalyType, event, violation.severity, { code: violation.code, message: violation.message }) };
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence); this.book(event.symbol).apply(event);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }
  submitOrder(input: OrderInput): OrderResult {
    if (input.clientOrderId) {
      const cached = this.orderCache.get(`${input.strategyId}:${input.clientOrderId}`);
      if (cached) return { ...cached, fills: [...cached.fills], duplicate: true };
    }
    const orderId = `SIM-${++this.orderSequence}`;
    const violation = this.instruments.validateOrder(input);
    if (violation) {
      const risk: RiskDecision = { allowed: false, rule: 'instrument', code: violation.code, message: violation.message };
      this.recordAnomaly('instrument_violation', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, violation.severity, { strategyId: input.strategyId, rule: risk.rule, code: risk.code, message: risk.message });
      return this.rememberOrder(input, { accepted: false, risk, fills: [], orderId });
    }
    const analytics = this.analytics(input.symbol); const account = this.account(input.strategyId); const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0); const now = Date.now(); const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now }); if (!risk.allowed) { this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code }); return this.rememberOrder(input, { accepted: false, risk, fills: [], orderId }); } account.ordersInWindow.push(now); const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' }; const fills = this.book(input.symbol).execute(order, new Date().toISOString()); this.fills.push(...fills); this.applyFills(account, fills); if (order.remaining > 0 && input.orderType === 'market') this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { remaining: order.remaining }); return this.rememberOrder(input, { accepted: true, risk, fills, orderId });
  }
  private rememberOrder(input: OrderInput, result: OrderResult): OrderResult { if (input.clientOrderId) this.orderCache.set(`${input.strategyId}:${input.clientOrderId}`, { ...result, fills: [...result.fills] }); return result; }
  cancel(strategyId: string, orderId: string): boolean { const account = this.account(strategyId); account.cancelInWindow.push(Date.now()); for (const book of this.books.values()) if (book.cancel(orderId)) return true; return false; }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }
  performance(strategyId: string) { const account = this.account(strategyId); const fills = this.fills.filter(fill => fill.orderId.startsWith('SIM-')); const byStrategy = fills.filter(fill => fill.strategyId === strategyId); const gross = byStrategy.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0); return { strategyId, account, metrics: { fillCount: byStrategy.length, tradedNotional: +byStrategy.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2), grossCashFlow: +gross.toFixed(2), fees: +byStrategy.reduce((s, f) => s + f.fee, 0).toFixed(2), netPnl: +(gross - byStrategy.reduce((s, f) => s + f.fee, 0)).toFixed(2), exposure: Object.entries(account.position).map(([symbol, quantity]) => ({ symbol, quantity })) } }; }
  private applyFills(account: Account, fills: Fill[]): void { for (const fill of fills) { const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity; account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + delta; account.cash += fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee; } account.equity = account.cash; account.peakEquity = Math.max(account.peakEquity, account.equity); }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { this.instruments.register({ symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: .01, lotSize: 1, currency: 'USD', status: 'replay_ready' }); const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}
