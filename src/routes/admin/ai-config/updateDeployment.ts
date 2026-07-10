import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { updateAiDeployment, type UpdateAiDeploymentInput } from "@/services/adminSettings";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import type { AuthUser } from "@/types/auth";

const schema = z.strictObject({
  id: z.number().int().positive(),
  vendorId: z.string().trim().min(1).nullable(),
  model: z.string(),
  modelName: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(0).max(1_000_000).optional(),
  disabled: z.boolean(),
});
type Update = (actor: AuthUser, input: UpdateAiDeploymentInput) => Promise<unknown>;

export function createUpdateDeploymentRouter(update: Update = updateAiDeployment) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("AI 部署参数错误", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data), "AI 部署配置已更新"));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
}

export default createUpdateDeploymentRouter();
