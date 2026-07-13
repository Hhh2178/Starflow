import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { updateSupportContact, type SupportContactProfile } from "@/services/supportContact";
import { sendSupportContactError } from "@/services/supportContactHttp";
import type { AuthUser } from "@/types/auth";

const assetId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("\\"));
const schema = z.strictObject({
  enabled: z.boolean(),
  type: z.literal("wechat"),
  title: z.string().trim().min(1).max(80),
  wechatId: z.string().trim().max(100),
  qrAssetId: assetId.nullable(),
  description: z.string().trim().max(500),
});
type Update = (actor: AuthUser, input: SupportContactProfile) => Promise<unknown>;

export function createUpdateSupportContactRouter(update: Update = updateSupportContact) {
  const router = express.Router();
  return router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("联系支持配置参数错误", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await update(getAuthUser(req), parsed.data), "联系支持配置已更新"));
    } catch (cause) {
      return sendSupportContactError(res, cause);
    }
  });
}

export default createUpdateSupportContactRouter();
