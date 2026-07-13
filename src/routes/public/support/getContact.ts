import express from "express";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getSupportContact } from "@/services/supportContact";
import { sendSupportContactError } from "@/services/supportContactHttp";
import type { AuthUser } from "@/types/auth";

type ReadContact = (actor: AuthUser) => Promise<unknown>;

export function createGetSupportContactRouter(read: ReadContact = getSupportContact) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await read(getAuthUser(req))));
    } catch (cause) {
      return sendSupportContactError(res, cause);
    }
  });
}

export default createGetSupportContactRouter();
