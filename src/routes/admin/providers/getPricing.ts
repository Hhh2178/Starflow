import express from "express";
import { getAuthUser } from "@/middleware/auth";
import { success } from "@/lib/responseFormat";
import { listModelPricing } from "@/services/modelPricing";
import { sendModelPricingError } from "@/services/modelPricingHttp";
import type { AuthUser } from "@/types/auth";

type ListPricing = (actor: AuthUser) => Promise<unknown>;
const defaultList: ListPricing = async (actor) => listModelPricing(actor, (await import("@/utils/db")).db);

export function createGetPricingRouter(list: ListPricing = defaultList) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success({ items: await list(getAuthUser(req)) }));
    } catch (cause) {
      return sendModelPricingError(res, cause);
    }
  });
}

export default createGetPricingRouter();
