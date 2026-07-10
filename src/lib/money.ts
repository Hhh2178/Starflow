export const MONEY_SCALE = 1_000_000;
export const MAX_QUOTA_AMOUNT = 1_000_000_000;

export function hasMoneyPrecision(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const [coefficient, exponentText] = Math.abs(value).toString().toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent) <= 6;
}

export function toMoneyMicros(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("金额必须是有限数字");
  const micros = Math.round(value * MONEY_SCALE);
  if (!Number.isSafeInteger(micros)) throw new RangeError("金额超出安全计算范围");
  return micros;
}

export function fromMoneyMicros(micros: number): number {
  if (!Number.isSafeInteger(micros)) throw new RangeError("金额微单位必须是安全整数");
  return Number((micros / MONEY_SCALE).toFixed(6));
}

export function normalizeMoney(value: number): number {
  return fromMoneyMicros(toMoneyMicros(value));
}
