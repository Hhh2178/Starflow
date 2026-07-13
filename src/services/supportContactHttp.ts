import type { Response } from "express";
import { error } from "@/lib/responseFormat";
import { SupportContactError } from "@/services/supportContact";

export function sendSupportContactError(res: Response, cause: unknown) {
  if (cause instanceof SupportContactError) {
    return res.status(cause.status).send(error(cause.message, { code: cause.code }));
  }
  throw cause;
}
