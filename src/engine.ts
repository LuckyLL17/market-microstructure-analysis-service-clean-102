import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { createDefaultInstrumentRegistry, httpStatusForCode, InstrumentRegistry, InstrumentRule, isTradableStatus, ValidatedOrderRequest } from './instruments.js';
import { Analytics, BookOrder, Fill, MarketEvent, Side } from './types.js';

export type IngestResult =
  | { accepted: true; event: MarketEvent }
  | { accepted: false; code: string; message: string; statusCode: number; anomaly?: Record<string, unknown> };

export type SubmitOrderResult =
  | {
      accepted: true;
      orderId: string;
      fills: Fill[];
      remaining: number;
      symbol: string;
      tradingDay: string;
      currency: string;
    }
  | {
      accepted: false;
      code: string;
      message: string;
      statusCode: number;
      risk?: ReturnType<typeof checkRisk>;
      orderId?: string;
    };

export class MarketEngine {
  readonly registry: InstrumentRegistry;
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();

  private readonly seenEventIds = new Map<string, string>();
  private readonly seenSequences = new Map<string, string>();
  private readonly duplicateAnomalies = new Set<string>();
  private readonly lastSequence = new Map<string, number>();
  private readonly lastTimestamp = new Map<string, string>();
  private readonly submittedRequests = new Map<string, { fingerprint: string; result: SubmitOrderResult }>();
  private submitSerial = 0;

  constructor(registry: InstrumentRegistry = createDefaultInstrumentRegistry(), seed = true) {
    this.registry = registry;
    this.registry.onTradingDayChange = rule => {
      this.books.get(rule.symbol)?.reset();
    };
    if (seed) this.seed();
  }

  rule(symbol: string): InstrumentRule {
    return this.registry.require(symbol);
  }

  book(symbol: string): OrderBook {
    const rule = this.registry.require(symbol);
    return this.ensureBook(rule.symbol);
  }

  ingest(input: unknown): IngestResult {
    const validation = this.registry.validateMarketEvent(input);
    if (!validation.valid) {
      return { accepted: false, statusCode: httpStatusForCode(validation.code), ...validation };
    }
    const event = validation.event;
    const idFingerprint = fingerprint({ ...event, id: undefined });
    const previousIdFingerprint = this.seenEventIds.get(event.id);
    if (previousIdFingerprint !== undefined) {
      if (previousIdFingerprint === idFingerprint) {
        return this.rejectedIngest('DUPLICATE_REQUEST', `事件 ${event.id} 是重复请求`, 409);
      }
      return this.rejectedIngest('EVENT_ID_CONFLICT', `事件 id ${event.id} 已用于不同内容`, 409);
    }

    const sequenceKey = this.sequenceKey(event.symbol, event.tradingDay, event.sequence);
    const previousSequenceFingerprint = this.seenSequences.get(sequenceKey);
    if (previousSequenceFingerprint !== undefined) {
      let anomaly: Record<string, unknown> | undefined;
      if (previousSequenceFingerprint !== idFingerprint && !this.duplicateAnomalies.has(sequenceKey)) {
        anomaly = this.recordAnomaly('duplicate_sequence', event, 'high');
        this.duplicateAnomalies.add(sequenceKey);
      }
      return this.rejectedIngest('DUPLICATE_SEQUENCE', `${event.symbol} 在交易日 ${event.tradingDay} 的序列号 ${event.sequence} 已存在`, 409, anomaly);
    }

    const symbolDayKey = `${event.symbol}:${event.tradingDay}`;
    const previousSequence = this.lastSequence.get(symbolDayKey);
    if (previousSequence !== undefined && event.sequence > previousSequence + 1) {
      this.recordAnomaly('sequence_gap', event, 'high', { expectedSequence: previousSequence + 1 });
    }
    const previousTimestamp = this.lastTimestamp.get(symbolDayKey);
    if (previousTimestamp !== undefined && event.timestamp < previousTimestamp) {
      this.recordAnomaly('out_of_order_timestamp', event, 'medium', { previousTimestamp });
    }

    this.seenEventIds.set(event.id, idFingerprint);
    this.seenSequences.set(sequenceKey, idFingerprint);
    this.lastSequence.set(symbolDayKey, event.sequence);
    this.lastTimestamp.set(symbolDayKey, event.timestamp);
    this.events.push(event);
    this.events.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      a.symbol.localeCompare(b.symbol) ||
      a.sequence - b.sequence,
    );
    this.ensureBook(event.symbol).apply(event);
    return { accepted: true, event };
  }

  analytics(symbol: string): Analytics {
    const rule = this.registry.require(symbol);
    const snapshot = this.book(rule.symbol).snapshot(10);
    const bestBid = snapshot.bids[0]?.price ?? null;
    const bestAsk = snapshot.asks[0]?.price ?? null;
    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const bidDepth = snapshot.bids.reduce((sum, level) => sum + level.quantity, 0);
    const askDepth = snapshot.asks.reduce((sum, level) => sum + level.quantity, 0);
    const impact = (side: Side, requested: number) => {
      const levels = side === 'buy' ? snapshot.asks : snapshot.bids;
      let left = requested;
      let notional = 0;
      let filled = 0;
      for (const level of levels) {
        const take = Math.min(left, level.quantity);
        notional += take * level.price;
        filled += take;
        left -= take;
        if (left === 0) break;
      }
      const averagePrice = filled ? notional / filled : null;
      const reference = side === 'buy' ? bestAsk : bestBid;
      return {
        quantity: requested,
        averagePrice: averagePrice !== null ? +averagePrice.toFixed(4) : null,
        slippageBps: averagePrice !== null && reference !== null
          ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2)
          : null,
        filled: +filled.toFixed(4),
      };
    };
    const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
    const topBidQuantity = snapshot.bids.slice(0, 5).reduce((sum, level) => sum + level.quantity, 0);
    const topAskQuantity = snapshot.asks.slice(0, 5).reduce((sum, level) => sum + level.quantity, 0);
    const weightedImbalance = topBidQuantity + topAskQuantity
      ? (topBidQuantity - topAskQuantity) / (topBidQuantity + topAskQuantity)
      : 0;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const impactQuantities = [100, 500, 1000].map(quantity => Math.max(quantity, Math.ceil(quantity / rule.lotSize) * rule.lotSize));
    return {
      symbol: rule.symbol,
      timestamp: snapshot.timestamp,
      bestBid,
      bestAsk,
      midPrice: mid,
      spread,
      relativeSpread: mid !== null && spread !== null ? spread / mid : null,
      bidDepth,
      askDepth,
      imbalance: +imbalance.toFixed(4),
      weightedImbalance: +weightedImbalance.toFixed(4),
      marketBuyImpact: impactQuantities.map(quantity => impact('buy', quantity)),
      marketSellImpact: impactQuantities.map(quantity => impact('sell', quantity)),
      estimatedFillProbability: {
        buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * 0.4).toFixed(3),
        sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * 0.4).toFixed(3),
      },
      liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2),
      tradingDay: rule.tradingDay,
      tickSize: rule.tickSize,
      lotSize: rule.lotSize,
      currency: rule.currency,
      instrumentStatus: rule.status,
    };
  }

  submitOrder(input: unknown): SubmitOrderResult {
    const validation = this.registry.validateOrderRequest(input);
    if (!validation.valid) {
      return { accepted: false, statusCode: httpStatusForCode(validation.code), ...validation };
    }
    const request = validation.request;
    const idempotencyResult = this.replayIdempotentOrder(request);
    if (idempotencyResult) return idempotencyResult;

    const rule = this.registry.require(request.symbol);
    if (!isTradableStatus(rule.status)) {
      return this.rejectedOrder('INSTRUMENT_SUSPENDED', `品种 ${rule.symbol} 当前停牌`, 409);
    }

    const analytics = this.analytics(rule.symbol);
    const account = this.account(request.strategyId);
    const price = request.orderType === 'limit'
      ? request.price!
      : request.side === 'buy'
        ? analytics.bestAsk ?? 0
        : analytics.bestBid ?? 0;
    const now = Date.now();
    const risk = checkRisk({
      symbol: rule.symbol,
      currency: rule.currency,
      side: request.side,
      orderType: request.orderType,
      price,
      quantity: request.quantity,
      bestBid: analytics.bestBid,
      bestAsk: analytics.bestAsk,
      account,
      now,
    });
    this.submitSerial += 1;
    const orderId = `SIM-${this.submitSerial}`;
    if (!risk.allowed) {
      this.recordAnomaly('risk_rejection', {
        id: orderId,
        symbol: rule.symbol,
        tradingDay: rule.tradingDay,
        timestamp: new Date().toISOString(),
        sequence: this.submitSerial,
      }, 'medium', { strategyId: request.strategyId, rule: risk.rule, code: risk.code });
      return { accepted: false, statusCode: 200, code: risk.code ?? 'RISK_REJECTED', message: risk.message ?? '订单未通过风险校验', risk, orderId };
    }

    account.ordersInWindow.push(now);
    const order: BookOrder = {
      id: orderId,
      side: request.side,
      price,
      quantity: request.quantity,
      remaining: request.quantity,
      sequence: this.submitSerial,
      owner: request.strategyId,
      type: request.orderType,
    };
    const fills = this.book(rule.symbol).execute(order, new Date().toISOString()).map(fill => ({
      ...fill,
      symbol: rule.symbol,
      tradingDay: rule.tradingDay,
      currency: rule.currency,
    }));
    this.fills.push(...fills);
    this.applyFills(account, fills);
    if (order.remaining > 0 && request.orderType === 'market') {
      this.recordAnomaly('unfilled_market_order', {
        id: orderId,
        symbol: rule.symbol,
        tradingDay: rule.tradingDay,
        timestamp: new Date().toISOString(),
        sequence: this.submitSerial,
      }, 'high', { remaining: order.remaining });
    }

    const result: SubmitOrderResult = {
      accepted: true,
      orderId,
      fills,
      remaining: order.remaining,
      symbol: rule.symbol,
      tradingDay: rule.tradingDay,
      currency: rule.currency,
    };
    if (request.requestId) this.submittedRequests.set(this.idempotencyKey(request), { fingerprint: this.orderFingerprint(request), result });
    return result;
  }

  cancel(strategyId: string, orderId: string, symbol?: string): boolean {
    if (typeof strategyId !== 'string' || strategyId.trim().length === 0 || typeof orderId !== 'string' || orderId.trim().length === 0) {
      return false;
    }
    const account = this.accounts.get(strategyId);
    if (!account) return false;

    let cancelled = false;
    if (symbol !== undefined) {
      const normalizedSymbol = this.registry.require(symbol).symbol;
      cancelled = this.books.get(normalizedSymbol)?.cancel(orderId, strategyId) ?? false;
    } else {
      for (const book of this.books.values()) {
        if (book.cancel(orderId, strategyId)) {
          cancelled = true;
          break;
        }
      }
    }
    if (cancelled) account.cancelInWindow.push(Date.now());
    return cancelled;
  }

  account(strategyId: string): Account {
    let account = this.accounts.get(strategyId);
    if (!account) {
      account = {
        strategyId,
        cash: 1_000_000,
        equity: 1_000_000,
        cashBalances: { USD: 1_000_000 },
        position: {},
        ordersInWindow: [],
        cancelInWindow: [],
        peakEquity: 1_000_000,
        maxDrawdown: 0.15,
      };
      this.accounts.set(strategyId, account);
    }
    return account;
  }

  performance(strategyId: string, symbol?: string) {
    const account = this.account(strategyId);
    let fills = this.fills.filter(fill => fill.orderId.startsWith('SIM-') && fill.strategyId === strategyId);
    if (symbol !== undefined) {
      const normalizedSymbol = this.registry.require(symbol).symbol;
      fills = fills.filter(fill => fill.symbol === normalizedSymbol);
    }
    const gross = fills.reduce((sum, fill) =>
      sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0);
    const fees = fills.reduce((sum, fill) => sum + fill.fee, 0);
    return {
      strategyId,
      account,
      metrics: {
        fillCount: fills.length,
        tradedNotional: +fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0).toFixed(2),
        grossCashFlow: +gross.toFixed(2),
        fees: +fees.toFixed(2),
        netPnl: +(gross - fees).toFixed(2),
        exposure: Object.entries(account.position).map(([positionSymbol, quantity]) => ({ symbol: positionSymbol, quantity })),
      },
    };
  }

  strategyEvents(strategyId: string) {
    return {
      orders: this.anomalies.filter(item => (item.detail as { strategyId?: string } | undefined)?.strategyId === strategyId),
      fills: this.fills.filter(fill => fill.strategyId === strategyId),
    };
  }

  private replayIdempotentOrder(request: ValidatedOrderRequest): SubmitOrderResult | undefined {
    if (!request.requestId) return undefined;
    const key = this.idempotencyKey(request);
    const stored = this.submittedRequests.get(key);
    if (!stored) return undefined;
    const fingerprint = this.orderFingerprint(request);
    if (stored.fingerprint !== fingerprint) {
      return this.rejectedOrder('IDEMPOTENCY_KEY_REUSED', `requestId ${request.requestId} 已用于不同订单`, 409);
    }
    return stored.result;
  }

  private idempotencyKey(request: ValidatedOrderRequest): string {
    return `${request.strategyId}:${request.requestId!}`;
  }

  private orderFingerprint(request: ValidatedOrderRequest): string {
    return fingerprint({
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      price: request.price,
      quantity: request.quantity,
    });
  }

  private ensureBook(symbol: string): OrderBook {
    let book = this.books.get(symbol);
    if (!book) {
      book = new OrderBook(symbol);
      this.books.set(symbol, book);
    }
    return book;
  }

  private sequenceKey(symbol: string, tradingDay: string, sequence: number): string {
    return `${symbol}:${tradingDay}:${sequence}`;
  }

  private rejectedIngest(code: string, message: string, statusCode: number, anomaly?: Record<string, unknown>): IngestResult {
    return { accepted: false, code, message, statusCode, anomaly };
  }

  private rejectedOrder(code: string, message: string, statusCode: number): SubmitOrderResult {
    return { accepted: false, code, message, statusCode };
  }

  private applyFills(account: Account, fills: Fill[]): void {
    for (const fill of fills) {
      const currency = fill.currency ?? 'USD';
      const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity;
      account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + delta;
      const signedCashFlow = fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee;
      account.cashBalances[currency] = (account.cashBalances[currency] ?? 0) + signedCashFlow;
      if (currency === 'USD') account.cash = account.cashBalances.USD;
    }
    account.equity = account.cash;
    account.peakEquity = Math.max(account.peakEquity, account.equity);
  }

  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) {
    const anomaly = {
      id: `AN-${this.anomalies.length + 1}`,
      type,
      severity,
      symbol: event.symbol,
      tradingDay: event.tradingDay,
      timestamp: event.timestamp ?? new Date().toISOString(),
      sequence: event.sequence,
      detail,
    };
    this.anomalies.push(anomaly);
    return anomaly;
  }

  private seed(): void {
    if (this.registry.get('ALPHA')) {
      const symbol = 'ALPHA';
      const tradingDay = '2026-09-30';
      const now = new Date(`${tradingDay}T09:30:00.000Z`);
      const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, index) => ({ price, quantity: [420, 380, 610, 240, 720][index] }));
      const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, index) => ({ price, quantity: [300, 490, 260, 580, 410][index] }));
      this.ingest({ id: 'E-1', symbol, tradingDay, timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks });
      for (let index = 0; index < 12; index += 1) {
        this.ingest({
          id: `E-${index + 2}`,
          symbol,
          tradingDay,
          timestamp: new Date(now.getTime() + (index + 1) * 1000).toISOString(),
          sequence: index + 2,
          type: index % 3 === 0 ? 'trade' : 'new_order',
          orderId: `M-${index + 2}`,
          side: index % 2 ? 'buy' : 'sell',
          aggressorSide: index % 2 ? 'buy' : 'sell',
          price: index % 2 ? 100.01 : 99.99,
          quantity: 40 + index * 12,
        });
      }
    }

    if (this.registry.get('BETA')) {
      const symbol = 'BETA';
      const tradingDay = '2026-10-01';
      const now = new Date(`${tradingDay}T09:30:00.000Z`);
      const bids = [50.00, 49.95, 49.90, 49.85, 49.80].map((price, index) => ({ price, quantity: [100, 80, 120, 60, 90][index] }));
      const asks = [50.05, 50.10, 50.15, 50.20, 50.25].map((price, index) => ({ price, quantity: [70, 110, 50, 90, 80][index] }));
      this.ingest({ id: 'BETA-E-1', symbol, tradingDay, timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks });
      for (let index = 0; index < 12; index += 1) {
        this.ingest({
          id: `BETA-E-${index + 2}`,
          symbol,
          tradingDay,
          timestamp: new Date(now.getTime() + (index + 1) * 1000).toISOString(),
          sequence: index + 2,
          type: index % 3 === 0 ? 'trade' : 'new_order',
          orderId: `BETA-M-${index + 2}`,
          side: index % 2 ? 'buy' : 'sell',
          aggressorSide: index % 2 ? 'buy' : 'sell',
          price: index % 2 ? 50.05 : 50.00,
          quantity: 10 + index * 10,
        });
      }
    }
  }
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}
