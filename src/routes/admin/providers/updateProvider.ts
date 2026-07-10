import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { updateProvider, type UpdateProviderInput } from "@/services/adminSettings";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import type { AuthUser } from "@/types/auth";

const schema = z.strictObject({
  id: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  inputValues: z.record(z.string(), z.string()).optional(),
});
type Update = (actor: AuthUser, input: UpdateProviderInput) => Promise<unknown>;

export function createUpdateProviderRouter(update: Update = updateProvider) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("Provider 配置参数错误", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data), "Provider 配置已更新"));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
}

export default createUpdateProviderRouter();
