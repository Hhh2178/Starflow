export interface AdvancedConfig extends Record<string, unknown> {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  polling?: Record<string, unknown>;
  finalLookup?: Record<string, unknown>;
}

export class AdvancedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancedConfigError";
  }
}

const allowedSections = new Set(["request", "response", "polling", "finalLookup"]);
const sensitiveKey = /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)([_-]|$)/i;
const executableText = /\$\{|\{\{|=>|\bfunction\s*\(|`/;
const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new AdvancedConfigError(`${label}必须是 JSON 对象`);
}

function inspectValue(value: unknown, depth: number, state: { keys: number }, path: string): void {
  if (depth > 8) throw new AdvancedConfigError("高级配置层级不能超过 8 层");
  if (typeof value === "string") {
    if (value.length > 4096) throw new AdvancedConfigError(`${path}文本长度超出限制`);
    if (executableText.test(value)) throw new AdvancedConfigError(`${path}不能包含可执行表达式`);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new AdvancedConfigError(`${path}数组长度超出限制`);
    value.forEach((item, index) => inspectValue(item, depth + 1, state, `${path}.${index}`));
    return;
  }
  assertPlainObject(value, path);
  for (const [key, item] of Object.entries(value)) {
    state.keys += 1;
    if (state.keys > 200) throw new AdvancedConfigError("高级配置字段数量超出限制");
    if (sensitiveKey.test(key)) throw new AdvancedConfigError(`${path}.${key}不能保存敏感凭据`);
    inspectValue(item, depth + 1, state, `${path}.${key}`);
  }
}

function optionalObject(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  assertPlainObject(value, key);
  return value;
}

export function validateAdvancedConfig(value: unknown): AdvancedConfig {
  assertPlainObject(value, "高级配置");
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new AdvancedConfigError("高级配置无法序列化"); }
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new AdvancedConfigError("高级配置不能超过 64 KiB");
  const config = structuredClone(value) as AdvancedConfig;
  for (const key of Object.keys(config)) if (!allowedSections.has(key)) throw new AdvancedConfigError(`不支持的高级配置区域：${key}`);
  inspectValue(config, 0, { keys: 0 }, "advancedConfig");

  const request = optionalObject(config, "request");
  if (request?.method !== undefined) {
    const method = String(request.method).toUpperCase();
    if (!allowedMethods.has(method)) throw new AdvancedConfigError("请求方法不受支持");
    request.method = method;
  }
  const polling = optionalObject(config, "polling");
  if (polling) {
    const interval = polling.intervalMs === undefined ? undefined : Number(polling.intervalMs);
    const timeout = polling.timeoutMs === undefined ? undefined : Number(polling.timeoutMs);
    if (interval !== undefined && (!Number.isInteger(interval) || interval < 250 || interval > 60000)) throw new AdvancedConfigError("轮询间隔必须在 250 到 60000 毫秒之间");
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000)) throw new AdvancedConfigError("轮询超时必须在 1000 到 1800000 毫秒之间");
    if (interval !== undefined && timeout !== undefined && timeout < interval) throw new AdvancedConfigError("轮询超时不能短于轮询间隔");
  }
  return config;
}

function mergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) merged[key] = mergeObjects(merged[key] as Record<string, unknown>, value);
    else merged[key] = structuredClone(value);
  }
  return merged;
}

function validateParameter(name: string, value: unknown, schemaValue: unknown): void {
  assertPlainObject(schemaValue, `参数 ${name} Schema`);
  const type = String(schemaValue.type ?? "");
  if (type === "integer" && !Number.isInteger(value)) throw new AdvancedConfigError(`参数 ${name} 必须是整数`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new AdvancedConfigError(`参数 ${name} 必须是数字`);
  if (type === "string" && typeof value !== "string") throw new AdvancedConfigError(`参数 ${name} 必须是字符串`);
  if (type === "boolean" && typeof value !== "boolean") throw new AdvancedConfigError(`参数 ${name} 必须是布尔值`);
  if (type === "select") {
    if (!Array.isArray(schemaValue.options) || !schemaValue.options.some((item) => Object.is(item, value))) throw new AdvancedConfigError(`参数 ${name} 不在允许选项中`);
  }
  if (typeof value === "number") {
    if (schemaValue.min !== undefined && value < Number(schemaValue.min)) throw new AdvancedConfigError(`参数 ${name} 小于最小值`);
    if (schemaValue.max !== undefined && value > Number(schemaValue.max)) throw new AdvancedConfigError(`参数 ${name} 大于最大值`);
  }
}

export function composeRuntimeConfig(input: {
  template: unknown;
  provider: unknown;
  model: unknown;
  task: Record<string, unknown>;
  parameterSchema: Record<string, unknown>;
}): AdvancedConfig {
  const template = validateAdvancedConfig(input.template);
  const provider = validateAdvancedConfig(input.provider);
  const model = validateAdvancedConfig(input.model);
  let composed = mergeObjects(template, provider);
  composed = mergeObjects(composed, model);
  for (const [name, value] of Object.entries(input.task)) {
    if (!(name in input.parameterSchema)) throw new AdvancedConfigError(`未声明参数：${name}`);
    validateParameter(name, value, input.parameterSchema[name]);
  }
  const request = isPlainObject(composed.request) ? composed.request : {};
  const fixedBody = isPlainObject(request.fixedBody) ? request.fixedBody : {};
  composed.request = { ...request, fixedBody: { ...fixedBody, ...structuredClone(input.task) } };
  return composed;
}
