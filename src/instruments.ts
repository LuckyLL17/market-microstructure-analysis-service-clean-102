import { MarketEvent, OrderType } from './types.js';

export type InstrumentStatus = 'active' | 'suspended' | 'replay_ready';

export type Instrument = {
  symbol: string;
  tradingDay: string;
  tickSize: number;
  lotSize: number;
  currency: string;
  status: InstrumentStatus;
};

export type InstrumentRules = Partial<Omit<Instrument, 'symbol'>>;

export type InstrumentViolation = {
  code: 'UNKNOWN_SYMBOL' | 'INSTRUMENT_SUSPENDED' | 'TRADING_DAY_MISMATCH' | 'INVALID_PRICE' | 'INVALID_QUANTITY';
  message: string;
  anomalyType: string;
  severity: 'low' | 'medium' | 'high';
};

export type OrderValidationInput = { symbol: string; orderType: OrderType; price?: number; quantity: number };

const TRADABLE_STATUSES: ReadonlySet<InstrumentStatus> = new Set(['active', 'replay_ready']);

function isAligned(value: number, unit: number): boolean {
  const ratio = value / unit;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-6;
}

function violation(code: InstrumentViolation['code'], message: string, severity: InstrumentViolation['severity']): InstrumentViolation {
  return { code, message, anomalyType: code.toLowerCase(), severity };
}

export class InstrumentRegistry {
  private readonly instruments = new Map<string, Instrument>();

  register(input: Instrument): { instrument: Instrument; created: boolean } {
    const existing = this.instruments.get(input.symbol);
    if (existing) return { instrument: existing, created: false };
    const instrument: Instrument = { ...input };
    this.instruments.set(instrument.symbol, instrument);
    return { instrument, created: true };
  }

  get(symbol: string): Instrument | undefined { return this.instruments.get(symbol); }
  has(symbol: string): boolean { return this.instruments.has(symbol); }
  list(): Instrument[] { return [...this.instruments.values()].map(item => ({ ...item })); }

  updateRules(symbol: string, rules: InstrumentRules): Instrument | undefined {
    const instrument = this.instruments.get(symbol);
    if (!instrument) return undefined;
    if (rules.tickSize !== undefined) instrument.tickSize = rules.tickSize;
    if (rules.lotSize !== undefined) instrument.lotSize = rules.lotSize;
    if (rules.tradingDay !== undefined) instrument.tradingDay = rules.tradingDay;
    if (rules.currency !== undefined) instrument.currency = rules.currency;
    if (rules.status !== undefined) instrument.status = rules.status;
    return { ...instrument };
  }

  validateEvent(event: MarketEvent): InstrumentViolation | null {
    const instrument = this.instruments.get(event.symbol);
    if (!instrument) return violation('UNKNOWN_SYMBOL', `品种 ${event.symbol} 未注册`, 'high');
    if (!TRADABLE_STATUSES.has(instrument.status)) return violation('INSTRUMENT_SUSPENDED', `品种 ${event.symbol} 已停牌，拒绝行情事件`, 'medium');
    if (event.tradingDay !== instrument.tradingDay) return violation('TRADING_DAY_MISMATCH', `事件交易日 ${event.tradingDay} 与品种交易日 ${instrument.tradingDay} 不一致`, 'medium');
    const checks: Array<{ price?: number; quantity?: number }> = event.type === 'snapshot' ? [...event.bids ?? [], ...event.asks ?? []] : [{ price: event.price, quantity: event.quantity }];
    for (const check of checks) {
      const priceViolation = this.checkPrice(check.price, instrument);
      if (priceViolation) return priceViolation;
      const quantityViolation = this.checkQuantity(check.quantity, instrument);
      if (quantityViolation) return quantityViolation;
    }
    return null;
  }

  validateOrder(input: OrderValidationInput): InstrumentViolation | null {
    const instrument = this.instruments.get(input.symbol);
    if (!instrument) return violation('UNKNOWN_SYMBOL', `品种 ${input.symbol} 未注册`, 'high');
    if (!TRADABLE_STATUSES.has(instrument.status)) return violation('INSTRUMENT_SUSPENDED', `品种 ${input.symbol} 已停牌，拒绝下单`, 'medium');
    if (input.orderType === 'limit') {
      const priceViolation = this.checkPrice(input.price, instrument);
      if (priceViolation) return priceViolation;
    }
    return this.checkQuantity(input.quantity, instrument);
  }

  private checkPrice(price: number | undefined, instrument: Instrument): InstrumentViolation | null {
    if (price === undefined) return null;
    if (!(price > 0) || !isAligned(price, instrument.tickSize)) return violation('INVALID_PRICE', `价格 ${price} 未对齐 tickSize ${instrument.tickSize}`, 'medium');
    return null;
  }

  private checkQuantity(quantity: number | undefined, instrument: Instrument): InstrumentViolation | null {
    if (quantity === undefined) return null;
    if (!(quantity > 0) || !isAligned(quantity, instrument.lotSize)) return violation('INVALID_QUANTITY', `数量 ${quantity} 未对齐 lotSize ${instrument.lotSize}`, 'medium');
    return null;
  }
}
