import type { Response } from "express";
import { error } from "@/lib/responseFormat";
import { ConcurrencyPolicyError } from "@/services/concurrencyPolicy";
import { GenerationQueueError } from "@/services/generationQueue";
import { QuotaManagementError } from "@/services/quotaManagement";
import { AuditLogError } from "@/services/auditLog";
import { AdminMonitoringError } from "@/services/adminMonitoring";

export function sendAdminServiceError(res: Response, cause: unknown) {
  if (
    cause instanceof ConcurrencyPolicyError
    || cause instanceof GenerationQueueError
    || cause instanceof QuotaManagementError
    || cause instanceof AuditLogError
    || cause instanceof AdminMonitoringError
  ) {
    return res.status(cause.status).send(error(cause.message, { code: cause.code }));
  }
  throw cause;
}
