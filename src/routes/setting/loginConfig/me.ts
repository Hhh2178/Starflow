import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const currentUser = getAuthUser(req);
  const data = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", currentUser.id).first();
  res.status(200).send(success(toSafeUser(data)));
});
