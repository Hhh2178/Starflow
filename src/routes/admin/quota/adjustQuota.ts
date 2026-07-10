import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { getAuthUser } from "@/middleware/auth";
import {
  adjustQuota,
  type QuotaAdjustmentInput,
} from "@/services/quotaManagement";
import type { AuthUser } from "@/types/auth";

const adjustmentSchema = z.strictObject({
  groupId: z.number().int().positive(),
  entryType: z.enum(["manual_topup", "manual_credit", "manual_debit"]),
  amount: z.number().positive(),
  reason: z.string().trim().min(2).max(500),
});

type AdjustQuota = (actor: AuthUser, input: QuotaAdjustmentInput) => Promise<unknown>;

export function createAdjustQuotaRouter(adjust: AdjustQuota = adjustQuota) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = adjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).send(error("额度调整参数错误", { code: "INVALID_PARAMETERS" }));
    }
    try {
      return res.send(success(await adjust(getAuthUser(req), parsed.data), "额度调整成功"));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createAdjustQuotaRouter();
