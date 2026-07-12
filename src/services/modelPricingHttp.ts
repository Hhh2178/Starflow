import type { Response } from "express";
import { error } from "@/lib/responseFormat";
import { ModelPricingError } from "@/services/modelPricing";

export function sendModelPricingError(res: Response, cause: unknown) {
  if (cause instanceof ModelPricingError) {
    return res.status(cause.status).send(error(cause.message, { code: cause.code }));
  }
  throw cause;
}
