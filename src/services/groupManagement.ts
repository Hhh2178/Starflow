import { AuthUser, UserRole, UserStatus } from "@/types/auth";
import u from "@/utils";
import { db } from "@/utils/db";
import { hashPassword } from "@/utils/password";
import { SAFE_USER_COLUMNS, SafeUser, toSafeUser } from "@/services/userManagement";
import { writeAudit } from "@/services/auditLog";

export interface GroupDto {
  id: number;
  name: string;
  adminUserId: number | null;
  creatorLimit: number;
  status: UserStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateGroupInput {
  name: string;
  adminUserId: number;
  creatorLimit: number;
  status: UserStatus;
}

export interface UpdateGroupInput {
  id: number;
  name?: string;
  adminUserId?: number;
  creatorLimit?: number;
  status?: UserStatus;
}

export interface CreateUserInput {
  name: string;
  password: string;
  role: UserRole;
  groupId?: number;
  groupName?: string;
  creatorLimit?: number;
  status?: UserStatus;
}

export interface UpdateUserInput {
  id: number;
  name?: string;
  role?: UserRole;
  status?: UserStatus;
  groupId?: number;
}

export class ManagementError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireSuperAdmin(actor: AuthUser): void {
  if (actor.role !== "super_admin") throw new ManagementError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可执行该操作");
}

function toGroupDto(row: any): GroupDto {
  return {
    id: Number(row.id),
    name: String(row.name),
    adminUserId: row.adminUserId == null ? null : Number(row.adminUserId),
    creatorLimit: Number(row.creatorLimit),
    status: row.status === "disabled" ? "disabled" : "enabled",
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

async function assertCreatorCapacity(trx: any, groupId: number, excludingUserId?: number): Promise<void> {
  const group = await trx("o_group").where("id", groupId).first();
  if (!group || group.status === "disabled") throw new ManagementError(404, "GROUP_NOT_FOUND", "分组不存在或已停用");

  let query = trx("o_user").where({ groupId, role: "creator", status: "enabled" });
  if (excludingUserId !== undefined) query = query.whereNot("id", excludingUserId);
  const countRow = await query.count({ count: "id" }).first();
  if (Number(countRow?.count ?? 0) >= Number(group.creatorLimit)) {
    throw new ManagementError(409, "CREATOR_LIMIT_REACHED", "本组启用的创作者数量已达到上限");
  }
}

async function nextUserId(trx: any): Promise<number> {
  const row = await trx("o_user").max({ maxId: "id" }).first();
  return Number(row?.maxId ?? 0) + 1;
}

export async function listGroups(actor: AuthUser): Promise<GroupDto[]> {
  requireSuperAdmin(actor);
  const groups = await u.db("o_group").select("*").orderBy("id", "asc");
  return groups.map(toGroupDto);
}

export async function createGroup(actor: AuthUser, input: CreateGroupInput): Promise<GroupDto> {
  requireSuperAdmin(actor);
  return db.transaction(async (trx) => {
    const admin = await trx("o_user").where({ id: input.adminUserId, role: "admin" }).first();
    if (!admin) throw new ManagementError(404, "ADMIN_NOT_FOUND", "管理员账号不存在");
    const bound = await trx("o_group").where("adminUserId", input.adminUserId).first();
    if (bound) throw new ManagementError(409, "ADMIN_ALREADY_ASSIGNED", "该管理员已绑定分组");

    const now = Date.now();
    const [id] = await trx("o_group").insert({
      name: input.name.trim(),
      adminUserId: input.adminUserId,
      creatorLimit: input.creatorLimit,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    });
    await trx("o_user").where("id", input.adminUserId).update({ groupId: id, updatedAt: now });
    await writeAudit({
      actor,
      groupId: Number(id),
      action: "group.create",
      targetType: "group",
      targetId: Number(id),
      summary: { name: input.name.trim(), creatorLimit: input.creatorLimit, status: input.status },
      result: "success",
    }, trx);
    return toGroupDto(await trx("o_group").where("id", id).first());
  });
}

export async function updateGroup(actor: AuthUser, input: UpdateGroupInput): Promise<GroupDto> {
  requireSuperAdmin(actor);
  return db.transaction(async (trx) => {
    const group = await trx("o_group").where("id", input.id).first();
    if (!group) throw new ManagementError(404, "GROUP_NOT_FOUND", "分组不存在");
    const now = Date.now();

    if (input.adminUserId !== undefined && Number(group.adminUserId) !== input.adminUserId) {
      const nextAdmin = await trx("o_user").where({ id: input.adminUserId, role: "admin" }).first();
      if (!nextAdmin) throw new ManagementError(404, "ADMIN_NOT_FOUND", "管理员账号不存在");
      const nextGroup = await trx("o_group").where("adminUserId", input.adminUserId).first();
      const previousAdminId = group.adminUserId == null ? null : Number(group.adminUserId);

      await trx("o_group").where("id", input.id).update({ adminUserId: null, updatedAt: now });

      if (nextGroup && Number(nextGroup.id) !== input.id) {
        await trx("o_group").where("id", nextGroup.id).update({ adminUserId: previousAdminId, updatedAt: now });
        if (previousAdminId !== null) await trx("o_user").where("id", previousAdminId).update({ groupId: nextGroup.id, updatedAt: now });
      } else if (previousAdminId !== null) {
        const [replacementGroupId] = await trx("o_group").insert({
          name: `${group.name}-原管理员组`,
          adminUserId: previousAdminId,
          creatorLimit: 5,
          status: "enabled",
          createdAt: now,
          updatedAt: now,
        });
        await trx("o_user").where("id", previousAdminId).update({ groupId: replacementGroupId, updatedAt: now });
      }
      await trx("o_user").where("id", input.adminUserId).update({ groupId: input.id, updatedAt: now });
    }

    await trx("o_group")
      .where("id", input.id)
      .update({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.adminUserId !== undefined ? { adminUserId: input.adminUserId } : {}),
        ...(input.creatorLimit !== undefined ? { creatorLimit: input.creatorLimit } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: now,
      });
    await writeAudit({
      actor,
      groupId: input.id,
      action: "group.update",
      targetType: "group",
      targetId: input.id,
      summary: { changedFields: Object.keys(input).filter((key) => key !== "id").sort().join(",") },
      result: "success",
    }, trx);
    return toGroupDto(await trx("o_group").where("id", input.id).first());
  });
}

export async function listScopedUsers(actor: AuthUser): Promise<SafeUser[]> {
  let query = u.db("o_user").select(SAFE_USER_COLUMNS).orderBy("id", "asc");
  if (actor.role === "admin") query = query.where({ role: "creator", groupId: actor.groupId });
  return (await query).map(toSafeUser);
}

export async function createScopedUser(actor: AuthUser, input: CreateUserInput): Promise<SafeUser> {
  return db.transaction(async (trx) => {
    const name = input.name.trim();
    if (await trx("o_user").where("name", name).first()) {
      throw new ManagementError(409, "USERNAME_EXISTS", "用户名已存在");
    }

    let role = input.role;
    let groupId: number | null = null;
    if (actor.role === "admin") {
      if (role !== "creator") throw new ManagementError(403, "ROLE_NOT_ALLOWED", "当前账号只能创建创作者");
      if (input.groupId !== undefined && input.groupId !== actor.groupId) {
        throw new ManagementError(403, "GROUP_SCOPE_VIOLATION", "不能为其他分组创建用户");
      }
      groupId = actor.groupId;
    } else if (actor.role === "super_admin") {
      if (role === "creator") {
        if (input.groupId === undefined) throw new ManagementError(400, "GROUP_REQUIRED", "创建创作者时必须选择分组");
        groupId = input.groupId;
      }
    } else {
      throw new ManagementError(403, "ADMIN_REQUIRED", "当前账号不能创建用户");
    }

    const status = input.status === "disabled" ? "disabled" : "enabled";
    if (role === "creator" && status === "enabled") await assertCreatorCapacity(trx, Number(groupId));

    const now = Date.now();
    const id = await nextUserId(trx);
    await trx("o_user").insert({
      id,
      name,
      password: null,
      passwordHash: hashPassword(input.password),
      role,
      status,
      groupId,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      mustChangePassword: true,
    });

    if (role === "admin") {
      const [createdGroupId] = await trx("o_group").insert({
        name: input.groupName?.trim() || `${name}组`,
        adminUserId: id,
        creatorLimit: input.creatorLimit ?? 5,
        status: "enabled",
        createdAt: now,
        updatedAt: now,
      });
      groupId = Number(createdGroupId);
      await trx("o_user").where("id", id).update({ groupId });
    }

    await writeAudit({
      actor,
      groupId,
      action: "user.create",
      targetType: "user",
      targetId: id,
      summary: { name, role, status, groupId },
      result: "success",
    }, trx);

    return toSafeUser(await trx("o_user").select(SAFE_USER_COLUMNS).where("id", id).first());
  });
}

async function getManageableUser(trx: any, actor: AuthUser, id: number): Promise<SafeUser> {
  const row = await trx("o_user").select(SAFE_USER_COLUMNS).where("id", id).first();
  if (!row) throw new ManagementError(404, "USER_NOT_FOUND", "用户不存在");
  const target = toSafeUser(row);
  if (actor.role === "super_admin") return target;
  if (actor.role === "admin" && target.role === "creator" && target.groupId === actor.groupId) return target;
  throw new ManagementError(404, "USER_NOT_FOUND", "用户不存在");
}

export async function updateScopedUser(actor: AuthUser, input: UpdateUserInput): Promise<SafeUser> {
  return db.transaction(async (trx) => {
    const target = await getManageableUser(trx, actor, input.id);
    if (input.role !== undefined && input.role !== target.role) {
      throw new ManagementError(409, "ROLE_CHANGE_REQUIRES_REBINDING", "角色变更必须通过专用的分组绑定操作完成");
    }
    const role = target.role;
    const status = input.status ?? target.status;
    const name = input.name?.trim() ?? target.name;
    let groupId = input.groupId ?? target.groupId;

    if (actor.role === "admin") {
      if (role !== "creator" || groupId !== actor.groupId) throw new ManagementError(403, "SCOPE_VIOLATION", "不能修改该用户的角色或分组");
      groupId = actor.groupId;
    }
    if (actor.id === input.id && (role !== actor.role || status === "disabled")) {
      throw new ManagementError(400, "SELF_LOCKOUT", "不能停用或修改自己的角色");
    }
    if (await trx("o_user").where("name", name).whereNot("id", input.id).first()) {
      throw new ManagementError(409, "USERNAME_EXISTS", "用户名已存在");
    }
    if (target.role === "super_admin" && (role !== "super_admin" || status === "disabled")) {
      const count = await trx("o_user").where({ role: "super_admin", status: "enabled" }).whereNot("id", input.id).count({ count: "id" }).first();
      if (Number(count?.count ?? 0) === 0) throw new ManagementError(400, "LAST_SUPER_ADMIN", "必须保留至少一个启用的超级管理员");
    }
    const creatorGroupChanged = role === "creator" && groupId !== target.groupId;
    if (role === "creator" && status === "enabled" && (target.status !== "enabled" || creatorGroupChanged)) {
      if (groupId === null) throw new ManagementError(400, "GROUP_REQUIRED", "创作者必须属于分组");
      await assertCreatorCapacity(trx, groupId, input.id);
    }

    await trx("o_user").where("id", input.id).update({ name, role, status, groupId, updatedAt: Date.now() });
    await writeAudit({
      actor,
      groupId,
      action: "user.update",
      targetType: "user",
      targetId: input.id,
      summary: { changedFields: Object.keys(input).filter((key) => key !== "id").sort().join(","), role, status, groupId },
      result: "success",
    }, trx);
    return toSafeUser(await trx("o_user").select(SAFE_USER_COLUMNS).where("id", input.id).first());
  });
}

export async function resetScopedPassword(actor: AuthUser, id: number, password: string): Promise<void> {
  await db.transaction(async (trx) => {
    await getManageableUser(trx, actor, id);
    await trx("o_user").where("id", id).update({
      password: null,
      passwordHash: hashPassword(password),
      mustChangePassword: true,
      updatedAt: Date.now(),
    });
    const target = await trx("o_user").where("id", id).select("groupId").first();
    await writeAudit({
      actor,
      groupId: target?.groupId == null ? null : Number(target.groupId),
      action: "user.password_reset",
      targetType: "user",
      targetId: id,
      summary: {},
      result: "success",
    }, trx);
  });
}
