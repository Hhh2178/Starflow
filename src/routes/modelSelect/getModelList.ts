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
    const providers = await u.db("o_vendorConfig").select("id").where("enable", 1);
    const result = await buildSelectableModelList(
      type,
      providers.map((provider) => ({ id: String(provider.id) })),
      (providerId) => u.vendor.getModelList(providerId),
      (providerId) => u.vendor.getVendor(providerId),
    );
    res.status(200).send(success(result));
  },
);
