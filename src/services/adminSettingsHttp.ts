import type { Response } from "express";
import { error } from "@/lib/responseFormat";
import { AdminSettingsError } from "@/services/adminSettings";

export function sendAdminSettingsError(res: Response, cause: unknown) {
  if (cause instanceof AdminSettingsError) {
    return res.status(cause.status).send(error(cause.message, { code: cause.code }));
  }
  throw cause;
}
