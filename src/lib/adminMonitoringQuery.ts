import type { Request } from "express";

export function optionalQueryNumber(req: Request, key: string): number | undefined {
  const value = req.query[key];
  if (value === undefined || value === "") return undefined;
  return Number(Array.isArray(value) ? value[0] : value);
}

export function optionalQueryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  const normalized = String(Array.isArray(value) ? value[0] : value).trim();
  return normalized || undefined;
}

export function paginationQuery(req: Request) {
  return {
    page: optionalQueryNumber(req, "page") ?? 1,
    pageSize: optionalQueryNumber(req, "pageSize") ?? 20,
  };
}
