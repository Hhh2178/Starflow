import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type { BillingUnits, GenerationTaskType, PricingSnapshot } from "@/types/generationQueue";

export type { BillingMode, BillingUnits, PricingSnapshot } from "@/types/generationQueue";

const MONEY_SCALE = 1_000_000;
const MONEY_SCALE_BIGINT = 1_000_000n;

export class ModelPricingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ModelPricingError";
  }
}

function requirePrice(value: number | undefined): number {
  if (value === undefined) {
    throw new ModelPricingError("PRICING_FIELDS_INCOMPLETE", "计价字段不完整");
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new ModelPricingError("PRICING_VALUE_INVALID", "价格必须是非负数");
  }
  const rounded = Math.round(value * MONEY_SCALE) / MONEY_SCALE;
  if (Math.abs(value - rounded) > Number.EPSILON) {
    throw new ModelPricingError("PRICING_PRECISION_INVALID", "价格最多保留六位小数");
  }
  return value;
}

function unit(value: number | undefined, fallback = 0): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new ModelPricingError("BILLING_UNITS_INVALID", "计费单位必须是非负数");
  }
  return normalized;
}

export function toMoneyMicros(value: number): bigint {
  requirePrice(value);
  return BigInt(Math.round(value * MONEY_SCALE));
}

export function fromMoneyMicros(value: bigint): number {
  return Number(value) / MONEY_SCALE;
}

export function validatePricingSnapshot(snapshot: PricingSnapshot): PricingSnapshot {
  if (snapshot.currency !== "CNY") {
    throw new ModelPricingError("PRICING_CURRENCY_INVALID", "当前仅支持人民币计价");
  }
  if (snapshot.billingMode === "per_request") {
    requirePrice(snapshot.requestPrice);
  } else if (snapshot.billingMode === "per_second") {
    requirePrice(snapshot.secondPrice);
  } else if (snapshot.billingMode === "per_token") {
    requirePrice(snapshot.inputPricePerMillion);
    requirePrice(snapshot.outputPricePerMillion);
    requirePrice(snapshot.fallbackRequestPrice);
  } else {
    throw new ModelPricingError("PRICING_MODE_INVALID", "不支持的计价模式");
  }
  return snapshot;
}

function multiplyMoney(price: number, quantity: number): bigint {
  const normalizedQuantity = unit(quantity);
  const scaledQuantity = Math.round(normalizedQuantity * MONEY_SCALE);
  if (Math.abs(normalizedQuantity - scaledQuantity / MONEY_SCALE) > Number.EPSILON) {
    throw new ModelPricingError("BILLING_UNITS_PRECISION_INVALID", "计费单位最多保留六位小数");
  }
  const numerator = toMoneyMicros(price) * BigInt(scaledQuantity);
  return (numerator + MONEY_SCALE_BIGINT / 2n) / MONEY_SCALE_BIGINT;
}

export function calculateReservedCost(snapshot: PricingSnapshot, units: BillingUnits): number {
  validatePricingSnapshot(snapshot);
  if (snapshot.billingMode === "per_request") {
    return fromMoneyMicros(multiplyMoney(snapshot.requestPrice!, unit(units.requests, 1)));
  }
  if (snapshot.billingMode === "per_second") {
    return fromMoneyMicros(multiplyMoney(snapshot.secondPrice!, unit(units.seconds)));
  }
  return fromMoneyMicros(multiplyMoney(snapshot.fallbackRequestPrice!, unit(units.requests, 1)));
}

export function calculateActualCost(snapshot: PricingSnapshot, units: BillingUnits): number {
  validatePricingSnapshot(snapshot);
  if (snapshot.billingMode !== "per_token") {
    return calculateReservedCost(snapshot, units);
  }
  if (units.inputTokens === undefined || units.outputTokens === undefined) {
    return fromMoneyMicros(multiplyMoney(snapshot.fallbackRequestPrice!, unit(units.requests, 1)));
  }

  const inputTokens = unit(units.inputTokens);
  const outputTokens = unit(units.outputTokens);
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    throw new ModelPricingError("BILLING_UNITS_INVALID", "Token 数必须是整数");
  }
  const numerator =
    toMoneyMicros(snapshot.inputPricePerMillion!) * BigInt(inputTokens) +
    toMoneyMicros(snapshot.outputPricePerMillion!) * BigInt(outputTokens);
  return fromMoneyMicros((numerator + MONEY_SCALE_BIGINT / 2n) / MONEY_SCALE_BIGINT);
}

export interface PricingTarget {
  providerId: string;
  modelId: string;
  canonicalModel: string;
}

export async function getActivePricingSnapshot(
  target: PricingTarget,
  taskType: GenerationTaskType,
  db: Knex | Knex.Transaction,
): Promise<PricingSnapshot> {
  const row = await db("o_modelPricing")
    .where({ providerId: target.providerId, modelId: target.modelId, status: "active" })
    .orderBy("version", "desc")
    .first();
  if (!row) {
    throw new ModelPricingError("PRICING_NOT_CONFIGURED", "该模型尚未配置价格");
  }
  if (String(row.taskType) !== taskType) {
    throw new ModelPricingError("PRICING_TASK_MISMATCH", "模型价格与生成类型不匹配");
  }
  return validatePricingSnapshot({
    pricingId: Number(row.id),
    providerId: String(row.providerId),
    modelId: String(row.modelId),
    taskType,
    billingMode: row.billingMode,
    requestPrice: row.requestPrice == null ? undefined : Number(row.requestPrice),
    secondPrice: row.secondPrice == null ? undefined : Number(row.secondPrice),
    inputPricePerMillion: row.inputPricePerMillion == null ? undefined : Number(row.inputPricePerMillion),
    outputPricePerMillion: row.outputPricePerMillion == null ? undefined : Number(row.outputPricePerMillion),
    fallbackRequestPrice: row.fallbackRequestPrice == null ? undefined : Number(row.fallbackRequestPrice),
    currency: row.currency,
    version: Number(row.version),
    effectiveAt: Number(row.effectiveAt),
  });
}

function splitCanonicalModel(model: string): PricingTarget {
  const separator = model.indexOf(":");
  const providerId = separator < 1 ? "" : model.slice(0, separator).trim();
  const modelId = separator < 1 ? "" : model.slice(separator + 1).trim();
  if (!providerId || !modelId) {
    throw new ModelPricingError("PRICING_TARGET_INVALID", "生成模型标识无效");
  }
  return { providerId, modelId, canonicalModel: `${providerId}:${modelId}` };
}

export async function resolvePricingTarget(
  taskType: GenerationTaskType,
  model: string,
  db: Knex | Knex.Transaction,
): Promise<PricingTarget> {
  let target: PricingTarget;
  if (taskType === "text" && !model.includes(":")) {
    const deployment = await db("o_agentDeploy").where({ key: model }).first();
    const providerId = String(deployment?.vendorId ?? "").trim();
    const configuredModel = String(deployment?.modelName ?? "").trim();
    if (!providerId || !configuredModel || Boolean(deployment?.disabled)) {
      throw new ModelPricingError("PRICING_TARGET_NOT_CONFIGURED", "文本生成模型尚未配置");
    }
    if (configuredModel.includes(":")) {
      target = splitCanonicalModel(configuredModel);
      if (target.providerId !== providerId) {
        throw new ModelPricingError("PRICING_TARGET_NOT_CONFIGURED", "文本生成模型的 Provider 配置不一致");
      }
    } else {
      target = { providerId, modelId: configuredModel, canonicalModel: `${providerId}:${configuredModel}` };
    }
  } else {
    target = splitCanonicalModel(model);
  }

  await getActivePricingSnapshot(target, taskType, db);
  return target;
}

export interface UpdateModelPricingInput {
  providerId: string;
  modelId: string;
  taskType: GenerationTaskType;
  billingMode: PricingSnapshot["billingMode"];
  requestPrice?: number;
  secondPrice?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  fallbackRequestPrice?: number;
  currency: "CNY";
}

export interface ModelPricingRecord {
  pricingId: number;
  providerId: string;
  modelId: string;
  taskType: GenerationTaskType;
  billingMode: PricingSnapshot["billingMode"];
  requestPrice: number | null;
  secondPrice: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  fallbackRequestPrice: number | null;
  currency: "CNY";
  version: number;
  effectiveAt: number;
}

export async function listModelPricing(actor: AuthUser, db: Knex): Promise<ModelPricingRecord[]> {
  if (actor.role !== "super_admin") {
    throw new ModelPricingError("SUPER_ADMIN_REQUIRED", "仅超级管理员可查看模型价格管理", 403);
  }
  const rows = await db("o_modelPricing").where({ status: "active" }).orderBy(["providerId", "modelId"]);
  return rows.map((row) => ({
    pricingId: Number(row.id),
    providerId: String(row.providerId),
    modelId: String(row.modelId),
    taskType: row.taskType as GenerationTaskType,
    billingMode: row.billingMode,
    requestPrice: row.requestPrice == null ? null : Number(row.requestPrice),
    secondPrice: row.secondPrice == null ? null : Number(row.secondPrice),
    inputPricePerMillion: row.inputPricePerMillion == null ? null : Number(row.inputPricePerMillion),
    outputPricePerMillion: row.outputPricePerMillion == null ? null : Number(row.outputPricePerMillion),
    fallbackRequestPrice: row.fallbackRequestPrice == null ? null : Number(row.fallbackRequestPrice),
    currency: "CNY" as const,
    version: Number(row.version),
    effectiveAt: Number(row.effectiveAt),
  }));
}

export async function estimateModelPricing(
  actor: AuthUser,
  input: { taskType: GenerationTaskType; model: string; units: BillingUnits },
  db: Knex,
) {
  if (actor.groupId == null) {
    throw new ModelPricingError("GROUP_REQUIRED", "当前账号尚未归属分组", 403);
  }
  const target = await resolvePricingTarget(input.taskType, input.model, db);
  const pricingSnapshot = await getActivePricingSnapshot(target, input.taskType, db);
  const estimatedCost = calculateReservedCost(pricingSnapshot, input.units);
  const account = await db("o_quotaAccount").where({ groupId: actor.groupId }).first();
  if (!account) throw new ModelPricingError("QUOTA_ACCOUNT_NOT_FOUND", "额度账户不存在", 404);
  const balance = fromMoneyMicros(toMoneyMicros(Number(account.balance)));
  const reservedBalance = fromMoneyMicros(toMoneyMicros(Number(account.reservedBalance ?? 0)));
  return {
    taskType: input.taskType,
    canonicalModel: target.canonicalModel,
    billingMode: pricingSnapshot.billingMode,
    estimatedCost,
    currency: "CNY" as const,
    account: {
      groupId: actor.groupId,
      balance,
      reservedBalance,
      availableBalance: fromMoneyMicros(toMoneyMicros(balance) - toMoneyMicros(reservedBalance)),
      billingStatus: String(account.billingStatus) === "debt" ? "debt" as const : "active" as const,
    },
  };
}

function parseProviderModels(value: unknown): Array<{ modelName?: string; type?: string }> {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertModeCompatibleFields(input: UpdateModelPricingInput): void {
  const present = (key: keyof UpdateModelPricingInput) => input[key] !== undefined;
  const incompatible =
    (input.billingMode !== "per_request" && present("requestPrice")) ||
    (input.billingMode !== "per_second" && present("secondPrice")) ||
    (input.billingMode !== "per_token" &&
      (present("inputPricePerMillion") || present("outputPricePerMillion") || present("fallbackRequestPrice")));
  if (incompatible) {
    throw new ModelPricingError("PRICING_FIELDS_INCOMPATIBLE", "价格字段与计价模式不匹配");
  }
}

export async function updateModelPricing(
  actor: AuthUser,
  input: UpdateModelPricingInput,
  db: Knex,
): Promise<ModelPricingRecord> {
  if (actor.role !== "super_admin") {
    throw new ModelPricingError("SUPER_ADMIN_REQUIRED", "仅超级管理员可修改模型价格", 403);
  }
  assertModeCompatibleFields(input);
  validatePricingSnapshot({
    pricingId: 0,
    ...input,
    version: 0,
    effectiveAt: 0,
  });

  return db.transaction(async (trx) => {
    const provider = await trx("o_vendorConfig").where({ id: input.providerId }).first();
    if (!provider) {
      throw new ModelPricingError("PROVIDER_NOT_FOUND", "Provider 不存在", 404);
    }
    const model = parseProviderModels(provider.models).find(
      (candidate) => String(candidate.modelName ?? "") === input.modelId,
    );
    if (!model) {
      throw new ModelPricingError("MODEL_NOT_FOUND", "Provider 模型不存在", 404);
    }
    if (String(model.type ?? "") !== input.taskType) {
      throw new ModelPricingError("PRICING_TASK_MISMATCH", "模型类型与计价任务不匹配");
    }

    const previous = await trx("o_modelPricing")
      .where({ providerId: input.providerId, modelId: input.modelId, status: "active" })
      .orderBy("version", "desc")
      .first();
    const latest = await trx("o_modelPricing")
      .where({ providerId: input.providerId, modelId: input.modelId })
      .max({ version: "version" })
      .first();
    const version = Number(latest?.version ?? 0) + 1;
    const now = Date.now();
    await trx("o_modelPricing")
      .where({ providerId: input.providerId, modelId: input.modelId, status: "active" })
      .update({ status: "superseded" });

    const [pricingId] = await trx("o_modelPricing").insert({
      providerId: input.providerId,
      modelId: input.modelId,
      taskType: input.taskType,
      billingMode: input.billingMode,
      requestPrice: input.requestPrice,
      secondPrice: input.secondPrice,
      inputPricePerMillion: input.inputPricePerMillion,
      outputPricePerMillion: input.outputPricePerMillion,
      fallbackRequestPrice: input.fallbackRequestPrice,
      currency: input.currency,
      version,
      status: "active",
      effectiveAt: now,
      createdBy: actor.id,
      createdAt: now,
    });

    await trx("o_auditLog").insert({
      actorUserId: actor.id,
      actorRole: actor.role,
      groupId: null,
      action: "pricing.update",
      targetType: "model_pricing",
      targetId: `${input.providerId}:${input.modelId}`,
      targetRole: null,
      summaryJson: JSON.stringify({
        providerId: input.providerId,
        modelId: input.modelId,
        oldMode: previous?.billingMode == null ? null : String(previous.billingMode),
        newMode: input.billingMode,
        changedFields: [
          "requestPrice",
          "secondPrice",
          "inputPricePerMillion",
          "outputPricePerMillion",
          "fallbackRequestPrice",
        ].filter((field) => input[field as keyof UpdateModelPricingInput] !== undefined).join(","),
        version,
        effectiveAt: now,
      }),
      result: "success",
      requestId: null,
      createdAt: now,
    });

    return {
      pricingId: Number(pricingId),
      providerId: input.providerId,
      modelId: input.modelId,
      taskType: input.taskType,
      billingMode: input.billingMode,
      requestPrice: input.requestPrice ?? null,
      secondPrice: input.secondPrice ?? null,
      inputPricePerMillion: input.inputPricePerMillion ?? null,
      outputPricePerMillion: input.outputPricePerMillion ?? null,
      fallbackRequestPrice: input.fallbackRequestPrice ?? null,
      currency: input.currency,
      version,
      effectiveAt: now,
    };
  });
}
