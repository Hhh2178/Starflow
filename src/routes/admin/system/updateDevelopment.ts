import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { updateDevelopmentSettings } from "@/services/adminSettings";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import type { AuthUser } from "@/types/auth";

const schema = z.strictObject({ aiDevToolsEnabled: z.boolean() });
type Update = (actor: AuthUser, enabled: boolean) => Promise<unknown>;

export function createUpdateDevelopmentRouter(update: Update = updateDevelopmentSettings) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("开发设置参数错误", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data.aiDevToolsEnabled), "开发设置已更新"));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
}

export default createUpdateDevelopmentRouter();
