import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import knex, { type Knex } from "knex";
import initDB from "@/lib/initDB";
import { createGetSupportContactRouter } from "@/routes/public/support/getContact";
import { createUpdateSupportContactRouter } from "@/routes/admin/system/updateSupportContact";
import {
  getSupportContact,
  SupportContactError,
  updateSupportContact,
} from "@/services/supportContact";
import type { AuthUser } from "@/types/auth";

const actors = {
  superAdmin: { id: 1, name: "root", role: "super_admin", groupId: null },
  admin: { id: 2, name: "admin", role: "admin", groupId: 101 },
  creator: { id: 3, name: "creator", role: "creator", groupId: 101 },
} satisfies Record<string, AuthUser>;

const configuredProfile = {
  enabled: true,
  type: "wechat" as const,
  title: "联系 Stars Flow 支持",
  wechatId: "stars-flow-support",
  qrAssetId: "support/wechat-contact.png",
  description: "工作日 09:00-18:00",
};

function assertPublicDto(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["qrAssetId", "internalAssetPath", "data/oss", "apiKey", "secret"]) {
    assert.equal(serialized.includes(forbidden), false, `public DTO leaked ${forbidden}`);
  }
}

async function expectSupportError(operation: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof SupportContactError, true);
    const error = cause as SupportContactError;
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function testService(db: Knex): Promise<void> {
  await db("o_setting").where({ key: "supportContact" }).del();
  const initial = await getSupportContact(actors.creator, db);
  assert.deepEqual(initial, {
    enabled: false,
    type: "wechat",
    title: "联系支持",
    wechatId: "",
    qrCodeUrl: null,
    description: "",
  });
  assertPublicDto(initial);
  await getSupportContact(actors.admin, db);
  assert.equal(await db("o_setting").where({ key: "supportContact" }).count({ count: "*" }).first().then((row) => Number(row?.count)), 1);

  await expectSupportError(updateSupportContact(actors.admin, configuredProfile, db), 403, "SUPER_ADMIN_REQUIRED");
  await expectSupportError(updateSupportContact(actors.creator, configuredProfile, db), 403, "SUPER_ADMIN_REQUIRED");

  const updated = await updateSupportContact(actors.superAdmin, configuredProfile, db);
  assert.deepEqual(updated, {
    enabled: true,
    type: "wechat",
    title: "联系 Stars Flow 支持",
    wechatId: "stars-flow-support",
    qrCodeUrl: "/oss/support/wechat-contact.png",
    description: "工作日 09:00-18:00",
  });
  assertPublicDto(updated);

  const stored = await db("o_setting").where({ key: "supportContact" }).first();
  assert.equal(typeof stored?.value, "string");
  assert.deepEqual(JSON.parse(stored.value), configuredProfile);
  const audit = await db("o_auditLog").where({ action: "admin.system.support_contact.update" }).first();
  assert.equal(audit.actorUserId, actors.superAdmin.id);
  assert.deepEqual(JSON.parse(audit.summaryJson), { enabled: true, type: "wechat", hasWechatId: true, hasQrAsset: true });
  assertPublicDto(audit);
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function testRoutes(db: Knex): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.headers["x-test-actor"] ?? "creator") as keyof typeof actors;
    (req as any).user = actors[key];
    next();
  });
  app.use("/api/public/support/getContact", createGetSupportContactRouter((actor) => getSupportContact(actor, db)));
  app.use("/api/admin/system/updateSupportContact", createUpdateSupportContactRouter((actor, input) => updateSupportContact(actor, input, db)));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api`;
    const publicResponse = await requestJson(`${base}/public/support/getContact`, {
      headers: { "x-test-actor": "creator" },
    });
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.body.data.wechatId, "stars-flow-support");
    assertPublicDto(publicResponse.body);

    const denied = await requestJson(`${base}/admin/system/updateSupportContact`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": "admin" },
      body: JSON.stringify(configuredProfile),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.data.code, "SUPER_ADMIN_REQUIRED");

    const invalid = await requestJson(`${base}/admin/system/updateSupportContact`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": "superAdmin" },
      body: JSON.stringify({ ...configuredProfile, qrAssetId: "../private.png" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.data.code, "INVALID_PARAMETERS");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    await testService(db);
    await testRoutes(db);
    console.log("R3T support contact tests passed");
  } finally {
    await db.destroy();
  }
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
