import express from "express";
import { z } from "zod";
import { getAuthUser } from "@/middleware/auth";
import { error, success } from "@/lib/responseFormat";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import {
  testProviderConnection,
  type TestProviderConnectionInput,
} from "@/services/adminSettings";

type TestConnection = (actor: ReturnType<typeof getAuthUser>, input: TestProviderConnectionInput) => Promise<unknown>;

const schema = z.strictObject({
  id: z.string().trim().min(1),
  modelName: z.string().trim().min(1),
});

export function createTestConnectionRouter(testConnection: TestConnection = testProviderConnection) {
  const router = express.Router();
  router.post("/", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("连接测试参数无效", { code: "INVALID_PARAMETERS" }));
    try {
      return res.send(success(await testConnection(getAuthUser(req), parsed.data), "连接测试通过"));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
  return router;
}

export default createTestConnectionRouter();
