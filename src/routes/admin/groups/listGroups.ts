import express from "express";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { listGroups } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    return res.send(success(await listGroups(getAuthUser(req))));
  } catch (cause) {
    return sendManagementError(res, cause);
  }
});
