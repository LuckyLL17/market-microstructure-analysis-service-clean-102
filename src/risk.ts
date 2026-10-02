import { OrderType, Side, RiskDecision } from './types.js';

export type Account = { strategyId: string; cash: number; equity: number; cashBalances: Record<string, number>; position: Record<string, number>; ordersInWindow: number[]; cancelInWindow: number[]; peakEquity: number; maxDrawdown: number };
export type RiskContext = { symbol: string; currency?: string; side: Side; orderType: OrderType; price: number; quantity: number; bestBid: number | null; bestAsk: number | null; account: Account; now: number };

export function checkRisk(context: RiskContext): RiskDecision {
  const { price, quantity, account, side, bestBid, bestAsk, now } = context;
  account.ordersInWindow = account.ordersInWindow.filter(time => now - time < 60_000);
  account.cancelInWindow = account.cancelInWindow.filter(time => now - time < 60_000);

  if (price <= 0) return { allowed: false, rule: 'market', code: 'NO_MARKET_PRICE', message: '盘口没有可用价格，无法提交市价单' };
  const currency = context.currency ?? 'USD';
  const notional = price * quantity;
  const availableBalance = account.cashBalances[currency] ?? 0;

  if (notional > 50_000) return { allowed: false, rule: 'capital', code: 'ORDER_NOTIONAL_LIMIT', message: '单笔模拟订单金额超过 50,000' };
  if (availableBalance < notional && side === 'buy') return { allowed: false, rule: 'capital', code: 'INSUFFICIENT_CASH', message: `${currency} 可用资金不足` };
  const position = account.position[context.symbol] ?? 0;
  if (side === 'sell' && position < quantity) return { allowed: false, rule: 'position', code: 'INSUFFICIENT_POSITION', message: '持仓不足，禁止卖出' };
  if (account.ordersInWindow.length >= 30) return { allowed: false, rule: 'frequency', code: 'ORDER_RATE_LIMIT', message: '60 秒内下单次数超过限制' };
  const reference = side === 'buy' ? bestAsk ?? price : bestBid ?? price;
  if (reference > 0 && Math.abs(price - reference) / reference > 0.02) return { allowed: false, rule: 'price_deviation', code: 'PRICE_DEVIATION', message: '订单价格偏离当前盘口超过 2%' };
  if (account.peakEquity > 0 && (account.peakEquity - account.equity) / account.peakEquity > account.maxDrawdown) return { allowed: false, rule: 'drawdown', code: 'MAX_DRAWDOWN', message: '策略已达到最大回撤限制' };
  return { allowed: true };
}
