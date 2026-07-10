import { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import u from "@/utils";
import { AuthUser, UserRole, normalizeRole } from "@/types/auth";

const PUBLIC_API_PATHS = new Set(["/api/login/login"]);

async function getTokenKey(): Promise<string | null> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  return typeof setting?.value === "string" && setting.value ? setting.value : null;
}

export function hasRole(user: AuthUser | undefined, roles: UserRole[]): boolean {
  if (!user) return false;
  return roles.includes(user.role);
}

export function getAuthUser(req: Request): AuthUser {
  return (req as Request & { user: AuthUser }).user;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();

  const tokenKey = await getTokenKey();
  if (!tokenKey) return res.status(444).send({ message: "服务器秘钥未配置，请联系管理员" });

  const rawToken = req.headers.authorization || (req.query.token as string) || "";
  const token = rawToken.replace("Bearer ", "");
  if (!token) return res.status(401).send({ message: "未提供token" });

  try {
    const decoded = jwt.verify(token, tokenKey) as Partial<AuthUser>;
    if (!decoded.id) return res.status(401).send({ message: "无效的token" });

    const userRecord = await u.db("o_user").where("id", Number(decoded.id)).select("id", "name", "role", "status", "groupId").first();
    if (!userRecord) return res.status(401).send({ message: "账号不存在" });
    if (userRecord.status === "disabled") return res.status(403).send({ message: "账号已停用，请联系管理员" });

    const role = normalizeRole(userRecord.role, Number(userRecord.id) === 1 ? "super_admin" : "creator");
    const groupId = userRecord.groupId == null ? null : Number(userRecord.groupId);
    if (role !== "super_admin" && groupId === null) {
      return res.status(403).send({ message: "账号尚未分配分组，请联系超级管理员" });
    }

    (req as any).user = {
      id: Number(userRecord.id),
      name: String(userRecord.name),
      role,
      groupId,
    } satisfies AuthUser;
    next();
  } catch {
    return res.status(401).send({ message: "无效的token" });
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    const user = (req as any).user as AuthUser | undefined;
    if (!hasRole(user, roles)) return res.status(403).send({ message: "当前账号无权执行该操作" });
    next();
  };
}
