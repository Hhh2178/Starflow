import { Response } from "express";
import { error } from "@/lib/responseFormat";
import { ManagementError } from "@/services/groupManagement";

export function sendManagementError(res: Response, cause: unknown) {
  if (cause instanceof ManagementError) {
    return res.status(cause.status).send(error(cause.message, { code: cause.code }));
  }
  throw cause;
}
