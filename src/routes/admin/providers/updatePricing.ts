import express from "express";
import { z } from "zod";
import { getAuthUser } from "@/middleware/auth";
import { error, success } from "@/lib/responseFormat";
import { updateModelPricing } from "@/services/modelPricing";
import { sendModelPricingError } from "@/services/modelPricingHttp";
import type { AuthUser } from "@/types/auth";
import type { UpdateModelPricingInput } from "@/services/modelPricing";

const base = {
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  taskType: z.enum(["text", "image", "video"]),
  currency: z.literal("CNY"),
};
const schema = z.discriminatedUnion("billingMode", [
  z.strictObject({ ...base, billingMode: z.literal("per_request"), requestPrice: z.number().nonnegative() }),
  z.strictObject({ ...base, billingMode: z.literal("per_second"), secondPrice: z.number().nonnegative() }),
  z.strictObject({
    ...base,
    billingMode: z.literal("per_token"),
    inputPricePerMillion: z.number().nonnegative(),
    outputPricePerMillion: z.number().nonnegative(),
    fallbackRequestPrice: z.number().nonnegative(),
  }),
]);

type UpdatePricing = (actor: AuthUser, input: UpdateModelPricingInput) => Promise<unknown>;
const defaultUpdate: UpdatePricing = async (actor, input) => updateModelPricing(actor, input, (await import("@/utils/db")).db);

export function createUpdatePricingRouter(update: UpdatePricing = defaultUpdate) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("价格参数无效", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data), "价格已更新"));
    } catch (cause) {
      return sendModelPricingError(res, cause);
    }
  });
}

export default createUpdatePricingRouter();
