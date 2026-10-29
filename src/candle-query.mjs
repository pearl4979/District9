// Shared only by read-only chart routes; no wallet or transaction dependencies.
const intervals = new Set(['1s','5s','15s','1min','5min','15min','1h','4h','1d']);
export function validateCandleBefore(before, now = Date.now()) {
  if (before === undefined) return undefined;
  if (!Number.isSafeInteger(before) || before < 1e12 || before > now + 60_000) throw new Error('K线历史时间无效');
  return before;
}
export function validateCandleCurrency(currency) {
  if (currency !== undefined && !['BNB','USD'].includes(currency)) throw new Error('K线显示币种无效');
  return currency;
}
export function readCandleQuery(url, now = Date.now()) {
  const allowed = new Set(['token','interval','mode','before','currency']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error('K线查询参数无效');
  const interval = url.searchParams.get('interval') ?? '1min', mode = url.searchParams.get('mode') ?? 'price';
  if (!intervals.has(interval) || !['price','marketcap'].includes(mode)) throw new Error('K线周期或指标无效');
  let before;
  if (url.searchParams.has('before')) {
    const raw = url.searchParams.get('before');
    if (!/^[1-9]\d{12,15}$/.test(raw)) throw new Error('K线历史时间格式无效');
    before = validateCandleBefore(Number(raw), now);
  }
  const currency = validateCandleCurrency(url.searchParams.has('currency') ? url.searchParams.get('currency') : undefined);
  return { interval, mode, options: {...(before === undefined ? {} : {before}), ...(currency === undefined ? {} : {currency})} };
}
