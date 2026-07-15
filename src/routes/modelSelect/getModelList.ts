import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildSelectableModelList } from "@/services/selectableModels";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video", "all"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const [providerRows, modelRows] = await Promise.all([
      u.db("o_providerRuntimeProfile")
        .select("providerId", "displayName", "enabled")
        .orderBy("displayName"),
      u.db("o_providerModelProfile")
        .select("providerId", "modelId", "displayName", "capability", "enabled")
        .orderBy(["providerId", "displayName"]),
    ]);
    const result = buildSelectableModelList(type, providerRows.map((provider) => ({
      id: String(provider.providerId),
      name: String(provider.displayName),
      enabled: Boolean(provider.enabled),
    })), modelRows.map((model) => ({
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      displayName: String(model.displayName),
      capability: String(model.capability),
      enabled: Boolean(model.enabled),
    })));
    res.status(200).send(success(result));
  },
);
