import { EventType, InstrumentStatus, MarketEvent, OrderType, PriceLevel, Side } from './types.js';

export type InstrumentRule = {
  symbol: string;
  tradingDay: string;
  tickSize: number;
  lotSize: number;
  currency: string;
  status: InstrumentStatus;
};

export type OrderRequest = {
  strategyId: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  price?: number;
  quantity: number;
  requestId?: string;
};

export type ValidatedOrderRequest = OrderRequest & { symbol: string };

export type ValidationFailure = {
  valid: false;
  code: string;
  message: string;
};

export type EventValidation =
  | { valid: true; event: MarketEvent }
  | ValidationFailure;

export type OrderValidation =
  | { valid: true; request: ValidatedOrderRequest }
  | ValidationFailure;

export type FieldValidation = { valid: true } | ValidationFailure;

export class RuleViolationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuleViolationError';
  }
}

type TradingDayChangeListener = (rule: InstrumentRule, previousTradingDay: string) => void;

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;
const TRADING_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRADABLE_STATUSES: ReadonlySet<InstrumentStatus> = new Set(['active', 'replay_ready']);

export function isTradableStatus(status: InstrumentStatus): boolean {
  return TRADABLE_STATUSES.has(status);
}

export function httpStatusForCode(code: string): number {
  if (code === 'UNKNOWN_INSTRUMENT') return 404;
  if (code === 'INSTRUMENT_SUSPENDED' || code === 'DUPLICATE_SEQUENCE' || code === 'EVENT_ID_CONFLICT' || code === 'IDEMPOTENCY_KEY_REUSED') return 409;
  return 400;
}

export class InstrumentRegistry {
  private readonly rules = new Map<string, InstrumentRule>();

  onTradingDayChange?: TradingDayChangeListener;

  register(rule: InstrumentRule): InstrumentRule {
    const normalized = this.normalizeRule(rule);
    if (this.rules.has(normalized.symbol)) {
      throw new RuleViolationError(409, 'INSTRUMENT_ALREADY_REGISTERED', `品种 ${normalized.symbol} 已注册`);
    }
    this.rules.set(normalized.symbol, normalized);
    return { ...normalized };
  }

  get(symbol: string): InstrumentRule | undefined {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const rule = this.rules.get(normalizedSymbol);
    return rule ? { ...rule } : undefined;
  }

  require(symbol: string): InstrumentRule {
    const rule = this.get(symbol);
    if (!rule) throw new RuleViolationError(404, 'UNKNOWN_INSTRUMENT', `未知品种: ${String(symbol)}`);
    return rule;
  }

  list(): InstrumentRule[] {
    return [...this.rules.keys()].sort().map(symbol => ({ ...this.rules.get(symbol)! }));
  }

  update(symbol: string, patch: Partial<Omit<InstrumentRule, 'symbol'>>): InstrumentRule {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const existing = this.rules.get(normalizedSymbol);
    if (!existing) throw new RuleViolationError(404, 'UNKNOWN_INSTRUMENT', `未知品种: ${normalizedSymbol}`);

    const next = this.normalizeRule({ ...existing, ...patch, symbol: normalizedSymbol });
    const previousTradingDay = existing.tradingDay;
    this.rules.set(normalizedSymbol, next);
    if (next.tradingDay !== previousTradingDay) {
      this.onTradingDayChange?.({ ...next }, previousTradingDay);
    }
    return { ...next };
  }

  normalizeSymbol(symbol: unknown): string {
    if (typeof symbol !== 'string' || symbol.trim().length === 0) {
      throw new RuleViolationError(400, 'INVALID_SYMBOL', 'symbol 必须是非空字符串');
    }
    const normalized = symbol.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(normalized)) {
      throw new RuleViolationError(400, 'INVALID_SYMBOL', `非法 symbol: ${symbol}`);
    }
    return normalized;
  }

  validateMarketEvent(input: unknown): EventValidation {
    if (typeof input !== 'object' || input === null) return failure('INVALID_EVENT', '行情事件必须是对象');
    const event = input as Partial<MarketEvent>;

    let symbol: string;
    try {
      symbol = this.normalizeSymbol(event.symbol);
    } catch (error) {
      return failureFrom(error);
    }

    const rule = this.rules.get(symbol);
    if (!rule) return failure('UNKNOWN_INSTRUMENT', `未知品种: ${symbol}`);
    if (!isTradableStatus(rule.status)) return failure('INSTRUMENT_SUSPENDED', `品种 ${symbol} 当前停牌，不能接收行情`);

    if (typeof event.id !== 'string' || event.id.trim().length === 0) return failure('INVALID_EVENT_ID', '行情事件 id 不能为空');
    if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) <= 0) return failure('INVALID_SEQUENCE', 'sequence 必须是正整数');
    if (!isValidTradingDay(event.tradingDay)) return failure('INVALID_TRADING_DAY', 'tradingDay 必须是 YYYY-MM-DD 格式');
    if (event.tradingDay !== rule.tradingDay) {
      return failure('CROSS_TRADING_DAY', `品种 ${symbol} 当前交易日为 ${rule.tradingDay}，不能接收 ${event.tradingDay} 的事件`);
    }
    if (typeof event.timestamp !== 'string' || !isUtcIsoTimestamp(event.timestamp)) {
      return failure('INVALID_TIMESTAMP', 'timestamp 必须是带 Z 的 UTC ISO 时间');
    }
    if (event.timestamp.slice(0, 10) !== event.tradingDay) {
      return failure('EVENT_TRADING_DAY_MISMATCH', 'timestamp 日期必须与 tradingDay 一致');
    }
    if (!isEventType(event.type)) return failure('INVALID_EVENT_TYPE', `不支持的行情事件类型: ${String(event.type)}`);

    if (event.type === 'snapshot') {
      const bids = event.bids ?? [];
      const asks = event.asks ?? [];
      if (!Array.isArray(event.bids) || !Array.isArray(event.asks)) return failure('INVALID_SNAPSHOT', 'snapshot 必须包含 bids 和 asks 数组');
      const bidResult = validateLevels(bids, rule, 'bids');
      if (!bidResult.valid) return bidResult;
      const askResult = validateLevels(asks, rule, 'asks');
      if (!askResult.valid) return askResult;
    }

    if (event.type === 'new_order') {
      if (typeof event.orderId !== 'string' || event.orderId.trim().length === 0) return failure('INVALID_ORDER_ID', 'new_order 事件必须包含 orderId');
      if (!isSide(event.side)) return failure('INVALID_SIDE', 'side 必须是 buy 或 sell');
      const priceResult = validatePrice(event.price, rule);
      if (!priceResult.valid) return priceResult;
      const quantityResult = validateQuantity(event.quantity, rule);
      if (!quantityResult.valid) return quantityResult;
    }

    if (event.type === 'cancel_order' && (typeof event.orderId !== 'string' || event.orderId.trim().length === 0)) {
      return failure('INVALID_ORDER_ID', 'cancel_order 事件必须包含 orderId');
    }

    if (event.type === 'trade') {
      if (!isSide(event.aggressorSide)) return failure('INVALID_SIDE', 'trade 事件必须包含有效的 aggressorSide');
      const priceResult = validatePrice(event.price, rule);
      if (!priceResult.valid) return priceResult;
      const quantityResult = validateQuantity(event.quantity, rule);
      if (!quantityResult.valid) return quantityResult;
    }

    if (event.side !== undefined && !isSide(event.side)) return failure('INVALID_SIDE', 'side 必须是 buy 或 sell');

    return { valid: true, event: { ...(event as MarketEvent), symbol } };
  }

  validateReplayEvent(input: unknown): EventValidation {
    if (typeof input !== 'object' || input === null) return failure('INVALID_EVENT', '行情事件必须是对象');
    const event = input as Partial<MarketEvent>;

    let symbol: string;
    try {
      symbol = this.normalizeSymbol(event.symbol);
    } catch (error) {
      return failureFrom(error);
    }
    if (!this.rules.has(symbol)) return failure('UNKNOWN_INSTRUMENT', `未知品种: ${symbol}`);
    if (typeof event.id !== 'string' || event.id.trim().length === 0) return failure('INVALID_EVENT_ID', '行情事件 id 不能为空');
    if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) <= 0) return failure('INVALID_SEQUENCE', 'sequence 必须是正整数');
    if (!isValidTradingDay(event.tradingDay)) return failure('INVALID_TRADING_DAY', 'tradingDay 必须是 YYYY-MM-DD 格式');
    if (typeof event.timestamp !== 'string' || !isUtcIsoTimestamp(event.timestamp)) {
      return failure('INVALID_TIMESTAMP', 'timestamp 必须是带 Z 的 UTC ISO 时间');
    }
    if (event.timestamp.slice(0, 10) !== event.tradingDay) {
      return failure('EVENT_TRADING_DAY_MISMATCH', 'timestamp 日期必须与 tradingDay 一致');
    }
    if (!isEventType(event.type)) return failure('INVALID_EVENT_TYPE', `不支持的行情事件类型: ${String(event.type)}`);
    if (event.side !== undefined && !isSide(event.side)) return failure('INVALID_SIDE', 'side 必须是 buy 或 sell');

    return { valid: true, event: { ...(event as MarketEvent), symbol } };
  }

  validateOrderRequest(input: unknown): OrderValidation {
    if (typeof input !== 'object' || input === null) return failure('INVALID_ORDER', '订单必须是对象');
    const request = input as Partial<OrderRequest>;

    let symbol: string;
    try {
      symbol = this.normalizeSymbol(request.symbol);
    } catch (error) {
      return failureFrom(error);
    }
    const rule = this.rules.get(symbol);
    if (!rule) return failure('UNKNOWN_INSTRUMENT', `未知品种: ${symbol}`);
    if (!isTradableStatus(rule.status)) return failure('INSTRUMENT_SUSPENDED', `品种 ${symbol} 当前停牌，不能提交订单`);
    if (typeof request.strategyId !== 'string' || request.strategyId.trim().length === 0) {
      return failure('INVALID_STRATEGY_ID', 'strategyId 不能为空');
    }
    if (!isSide(request.side)) return failure('INVALID_SIDE', 'side 必须是 buy 或 sell');
    if (request.orderType !== 'limit' && request.orderType !== 'market') {
      return failure('INVALID_ORDER_TYPE', 'orderType 必须是 limit 或 market');
    }
    const quantityResult = validateQuantity(request.quantity, rule);
    if (!quantityResult.valid) return quantityResult;

    if (request.orderType === 'limit') {
      const priceResult = validatePrice(request.price, rule);
      if (!priceResult.valid) return priceResult;
    } else if (request.price !== undefined) {
      return failure('MARKET_PRICE_NOT_ALLOWED', '市价单不能指定 price');
    }

    if (request.requestId !== undefined && (typeof request.requestId !== 'string' || request.requestId.trim().length === 0)) {
      return failure('INVALID_REQUEST_ID', 'requestId 必须是非空字符串');
    }

    return {
      valid: true,
      request: {
        ...(request as OrderRequest),
        symbol,
        strategyId: request.strategyId.trim(),
        requestId: request.requestId?.trim(),
      },
    };
  }

  private normalizeRule(rule: InstrumentRule): InstrumentRule {
    const symbol = this.normalizeSymbol(rule.symbol);
    if (!isValidTradingDay(rule.tradingDay)) {
      throw new RuleViolationError(400, 'INVALID_TRADING_DAY', 'tradingDay 必须是 YYYY-MM-DD 格式');
    }
    if (!Number.isFinite(rule.tickSize) || rule.tickSize <= 0) {
      throw new RuleViolationError(400, 'INVALID_TICK_SIZE', 'tickSize 必须是正数');
    }
    if (!Number.isSafeInteger(rule.lotSize) || rule.lotSize <= 0) {
      throw new RuleViolationError(400, 'INVALID_LOT_SIZE', 'lotSize 必须是正整数');
    }
    if (typeof rule.currency !== 'string' || !/^[A-Z]{3}$/.test(rule.currency)) {
      throw new RuleViolationError(400, 'INVALID_CURRENCY', 'currency 必须是 3 位大写字母代码');
    }
    if (!isInstrumentStatus(rule.status)) {
      throw new RuleViolationError(400, 'INVALID_INSTRUMENT_STATUS', 'status 必须是 active、replay_ready 或 suspended');
    }
    return { symbol, tradingDay: rule.tradingDay, tickSize: rule.tickSize, lotSize: rule.lotSize, currency: rule.currency, status: rule.status };
  }
}

export function createDefaultInstrumentRegistry(): InstrumentRegistry {
  const registry = new InstrumentRegistry();
  registry.register({
    symbol: 'ALPHA',
    tradingDay: '2026-09-30',
    tickSize: 0.01,
    lotSize: 1,
    currency: 'USD',
    status: 'replay_ready',
  });
  registry.register({
    symbol: 'BETA',
    tradingDay: '2026-10-01',
    tickSize: 0.05,
    lotSize: 10,
    currency: 'USD',
    status: 'active',
  });
  return registry;
}

function validateLevels(levels: PriceLevel[], rule: InstrumentRule, side: 'bids' | 'asks'): FieldValidation {
  if (!Array.isArray(levels)) return failure('INVALID_SNAPSHOT', `${side} 必须是数组`);
  const seen = new Set<number>();
  for (const level of levels) {
    if (typeof level !== 'object' || level === null) return failure('INVALID_PRICE_LEVEL', `${side} 中存在无效价格档位`);
    const priceResult = validatePrice(level.price, rule);
    if (!priceResult.valid) return priceResult;
    const quantityResult = validateQuantity(level.quantity, rule);
    if (!quantityResult.valid) return quantityResult;
    if (seen.has(level.price)) return failure('DUPLICATE_PRICE_LEVEL', `${side} 中价格 ${level.price} 重复`);
    seen.add(level.price);
  }
  return { valid: true };
}

function validatePrice(price: unknown, rule: InstrumentRule): FieldValidation {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return failure('INVALID_PRICE', '价格必须是正数');
  }
  const units = price / rule.tickSize;
  if (!isIntegerWithinFloatTolerance(units)) {
    return failure('INVALID_TICK_SIZE', `价格 ${price} 不是最小变动价位 ${rule.tickSize} 的整数倍`);
  }
  return { valid: true };
}

function validateQuantity(quantity: unknown, rule: InstrumentRule): FieldValidation {
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return failure('INVALID_QUANTITY', '数量必须是正整数');
  }
  if (quantity % rule.lotSize !== 0) {
    return failure('INVALID_LOT_SIZE', `数量 ${quantity} 不是最小交易单位 ${rule.lotSize} 的整数倍`);
  }
  return { valid: true };
}

function isIntegerWithinFloatTolerance(value: number): boolean {
  const rounded = Math.round(value);
  const tolerance = 1e-9 * Math.max(1, Math.abs(rounded));
  return Math.abs(value - rounded) <= tolerance;
}

function isUtcIsoTimestamp(value: string): boolean {
  return value.endsWith('Z') && new Date(value).toISOString() === value;
}

function isValidTradingDay(value: unknown): value is string {
  return typeof value === 'string' && TRADING_DAY_PATTERN.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function isEventType(value: unknown): value is EventType {
  return value === 'snapshot' || value === 'new_order' || value === 'cancel_order' || value === 'trade' || value === 'quote';
}

function isInstrumentStatus(value: unknown): value is InstrumentStatus {
  return value === 'active' || value === 'replay_ready' || value === 'suspended';
}

function isSide(value: unknown): value is Side {
  return value === 'buy' || value === 'sell';
}

function failure(code: string, message: string): ValidationFailure {
  return { valid: false, code, message };
}

function failureFrom(error: unknown): ValidationFailure {
  if (error instanceof RuleViolationError) return failure(error.code, error.message);
  return failure('INVALID_REQUEST', '请求参数无效');
}
