import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { updateAiUseMode } from "@/services/adminSettings";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import type { AuthUser } from "@/types/auth";

const schema = z.strictObject({ agentUseMode: z.enum(["0", "1"]) });
type Update = (actor: AuthUser, mode: "0" | "1") => Promise<unknown>;

export function createUpdateUseModeRouter(update: Update = updateAiUseMode) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("AI 使用模式参数错误", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data.agentUseMode), "AI 使用模式已更新"));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
}

export default createUpdateUseModeRouter();
