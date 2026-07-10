import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const actor = getAuthUser(req);
  let query = u.db("o_user").select(SAFE_USER_COLUMNS).orderBy("id", "asc");
  if (actor.role === "admin") query = query.where("role", "creator");
  const users = await query;
  res.status(200).send(success(users.map(toSafeUser)));
});
