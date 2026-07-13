import type { Knex } from "knex";
import u from "@/utils";
import type { AuthUser } from "@/types/auth";

const SETTING_KEY = "supportContact";

export interface SupportContactProfile {
  enabled: boolean;
  type: "wechat";
  title: string;
  wechatId: string;
  qrAssetId: string | null;
  description: string;
}

export interface PublicSupportContact {
  enabled: boolean;
  type: "wechat";
  title: string;
  wechatId: string;
  qrCodeUrl: string | null;
  description: string;
}

export class SupportContactError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupportContactError";
  }
}

const defaultProfile: SupportContactProfile = {
  enabled: false,
  type: "wechat",
  title: "联系支持",
  wechatId: "",
  qrAssetId: null,
  description: "",
};

function connection(db?: Knex): Knex {
  return db ?? u.db;
}

function validAssetId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("\\");
}

function normalizeProfile(value: unknown): SupportContactProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultProfile };
  const input = value as Partial<SupportContactProfile>;
  return {
    enabled: input.enabled === true,
    type: "wechat",
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : defaultProfile.title,
    wechatId: typeof input.wechatId === "string" ? input.wechatId.trim().slice(0, 100) : "",
    qrAssetId: typeof input.qrAssetId === "string" && validAssetId(input.qrAssetId.trim()) ? input.qrAssetId.trim() : null,
    description: typeof input.description === "string" ? input.description.trim().slice(0, 500) : "",
  };
}

function parseStored(value: unknown): SupportContactProfile {
  if (typeof value !== "string" || !value.trim()) return { ...defaultProfile };
  try {
    return normalizeProfile(JSON.parse(value));
  } catch {
    return { ...defaultProfile };
  }
}

function publicDto(profile: SupportContactProfile): PublicSupportContact {
  return {
    enabled: profile.enabled,
    type: profile.type,
    title: profile.title,
    wechatId: profile.wechatId,
    qrCodeUrl: profile.qrAssetId ? `/oss/${profile.qrAssetId}` : null,
    description: profile.description,
  };
}

async function readProfile(db: Knex): Promise<SupportContactProfile> {
  const row = await db("o_setting").where({ key: SETTING_KEY }).select("value").first();
  if (row) return parseStored(row.value);
  await db("o_setting").insert({ key: SETTING_KEY, value: JSON.stringify(defaultProfile) }).onConflict("key").ignore();
  return { ...defaultProfile };
}

export async function getSupportContact(_actor: AuthUser, db?: Knex): Promise<PublicSupportContact> {
  return publicDto(await readProfile(connection(db)));
}

export async function updateSupportContact(
  actor: AuthUser,
  input: SupportContactProfile,
  db?: Knex,
): Promise<PublicSupportContact> {
  if (actor.role !== "super_admin") {
    throw new SupportContactError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可以修改联系支持配置");
  }
  if (input.type !== "wechat" || (input.qrAssetId !== null && !validAssetId(input.qrAssetId))) {
    throw new SupportContactError(400, "INVALID_PARAMETERS", "联系支持配置参数错误");
  }
  const profile = normalizeProfile(input);
  if (profile.enabled && (!profile.wechatId || !profile.qrAssetId)) {
    throw new SupportContactError(422, "SUPPORT_CONTACT_INCOMPLETE", "启用联系支持前需要填写微信号和二维码资源");
  }
  const dbConnection = connection(db);
  await dbConnection.transaction(async (trx) => {
    await trx("o_setting")
      .insert({ key: SETTING_KEY, value: JSON.stringify(profile) })
      .onConflict("key")
      .merge({ value: JSON.stringify(profile) });
    await trx("o_auditLog").insert({
      actorUserId: actor.id,
      actorRole: actor.role,
      groupId: actor.groupId,
      action: "admin.system.support_contact.update",
      targetType: "system_setting",
      targetId: SETTING_KEY,
      summaryJson: JSON.stringify({
        enabled: profile.enabled,
        type: profile.type,
        hasWechatId: Boolean(profile.wechatId),
        hasQrAsset: Boolean(profile.qrAssetId),
      }),
      result: "success",
      requestId: null,
      createdAt: Date.now(),
    });
  });
  return publicDto(profile);
}
