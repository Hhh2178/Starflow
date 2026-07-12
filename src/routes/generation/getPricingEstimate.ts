import express from "express";
import { z } from "zod";
import { getAuthUser } from "@/middleware/auth";
import { error, success } from "@/lib/responseFormat";
import { estimateModelPricing } from "@/services/modelPricing";
import { sendModelPricingError } from "@/services/modelPricingHttp";
import type { AuthUser } from "@/types/auth";
import type { BillingUnits, GenerationTaskType } from "@/types/generationQueue";

const schema = z.strictObject({
  taskType: z.enum(["text", "image", "video"]),
  model: z.string().trim().min(1),
  units: z.strictObject({
    requests: z.number().nonnegative().optional(),
    images: z.number().nonnegative().optional(),
    seconds: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
});

type EstimatePricing = (
  actor: AuthUser,
  input: { taskType: GenerationTaskType; model: string; units: BillingUnits },
) => Promise<unknown>;
const defaultEstimate: EstimatePricing = async (actor, input) => estimateModelPricing(actor, input, (await import("@/utils/db")).db);

export function createGetPricingEstimateRouter(estimate: EstimatePricing = defaultEstimate) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("估价参数无效", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await estimate(getAuthUser(req), parsed.data)));
    } catch (cause) {
      return sendModelPricingError(res, cause);
    }
  });
}

export default createGetPricingEstimateRouter();
