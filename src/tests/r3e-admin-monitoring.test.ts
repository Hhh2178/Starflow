import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import knex from "knex";
import initDB from "@/lib/initDB";
import {
  AdminMonitoringError,
  getUsageOverview,
  listAdminProjects,
  listAdminTasks,
} from "@/services/adminMonitoring";
import type { AuthUser } from "@/types/auth";
import { createListProjectsRouter } from "@/routes/admin/projects/listProjects";
import { createListTasksRouter } from "@/routes/admin/tasks/listTasks";
import { createUsageOverviewRouter } from "@/routes/admin/usage/getOverview";

const actors = {
  superAdmin: { id: 1, name: "root", role: "super_admin", groupId: null },
  adminA: { id: 2, name: "admin-a", role: "admin", groupId: 101 },
  creatorA: { id: 3, name: "creator-a", role: "creator", groupId: 101 },
  adminB: { id: 4, name: "admin-b", role: "admin", groupId: 102 },
  creatorB: { id: 5, name: "creator-b", role: "creator", groupId: 102 },
} satisfies Record<string, AuthUser>;

async function expectMonitoringError(operation: Promise<unknown>, status: number, code: string) {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof AdminMonitoringError, true);
    assert.equal((cause as AdminMonitoringError).status, status);
    assert.equal((cause as AdminMonitoringError).code, code);
    return true;
  });
}

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    const now = Date.now();
    await db("o_group").insert([
      { id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
      { id: 102, name: "B组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
    ]);
    await db("o_user").insert(Object.values(actors).map((actor) => ({ ...actor, status: "enabled", createdAt: now, updatedAt: now })));
    await db("o_project").insert([
      { id: 201, name: "A项目一", projectType: "series", type: "漫剧", ownerUserId: 3, groupId: 101, createTime: 100 },
      { id: 202, name: "A项目二", projectType: "short", type: "短剧", ownerUserId: 2, groupId: 101, createTime: 200 },
      { id: 203, name: "B项目", projectType: "series", type: "漫剧", ownerUserId: 5, groupId: 102, createTime: 300 },
    ]);
    await db("o_tasks").insert([
      { id: 301, projectId: 201, ownerUserId: 3, groupId: 101, taskClass: "image", model: "image-a", state: "completed", startTime: 1000 },
      { id: 302, projectId: 202, ownerUserId: 2, groupId: 101, taskClass: "video", model: "video-a", state: "failed", reason: "生成失败", startTime: 2000 },
      { id: 303, projectId: 203, ownerUserId: 5, groupId: 102, taskClass: "text", model: "text-b", state: "completed", startTime: 3000 },
    ]);
    await db("o_generationJob").insert([
      { id: 401, groupId: 101, ownerUserId: 3, projectId: 201, handlerKey: "image.test", taskType: "image", status: "succeeded", priority: 0, payloadJson: "{}", idempotencyKey: "usage-a", queuedAt: 10 },
      { id: 402, groupId: 102, ownerUserId: 5, projectId: 203, handlerKey: "text.test", taskType: "text", status: "succeeded", priority: 0, payloadJson: "{}", idempotencyKey: "usage-b", queuedAt: 20 },
    ]);
    await db("o_usageLedger").insert([
      { jobId: 401, groupId: 101, userId: 3, projectId: 201, providerId: "provider-a", modelId: "image-a", taskType: "image", unitJson: "{}", estimatedCost: 1.123456, currency: "CNY", pricingSnapshotJson: "{}", result: "succeeded", createdAt: 4000 },
      { jobId: 402, groupId: 102, userId: 5, projectId: 203, providerId: "provider-b", modelId: "text-b", taskType: "text", unitJson: "{}", estimatedCost: 9.5, currency: "CNY", pricingSnapshotJson: JSON.stringify({ fixture: true }), result: "succeeded", createdAt: 5000 },
    ]);

    const superProjects = await listAdminProjects(actors.superAdmin, { page: 1, pageSize: 20 }, db);
    assert.equal(superProjects.total, 3);
    assert.deepEqual(superProjects.items.map((item) => item.id), [203, 202, 201]);
    assert.equal(superProjects.items.find((item) => item.id === 201)?.taskCount, 1);

    const adminProjects = await listAdminProjects(actors.adminA, { page: 1, pageSize: 20 }, db);
    assert.deepEqual(adminProjects.items.map((item) => item.id), [202, 201]);
    assert.equal(adminProjects.items.every((item) => item.groupId === 101), true);
    const searchedProjects = await listAdminProjects(actors.adminA, { page: 1, pageSize: 20, search: "一" }, db);
    assert.deepEqual(searchedProjects.items.map((item) => item.id), [201]);
    await expectMonitoringError(listAdminProjects(actors.adminA, { page: 1, pageSize: 20, groupId: 102 }, db), 404, "SCOPE_NOT_FOUND");

    const adminTasks = await listAdminTasks(actors.adminA, { page: 1, pageSize: 20 }, db);
    assert.deepEqual(adminTasks.items.map((item) => item.id), [302, 301]);
    assert.equal(adminTasks.items.every((item) => item.groupId === 101), true);
    const failedTasks = await listAdminTasks(actors.adminA, { page: 1, pageSize: 20, state: "failed" }, db);
    assert.deepEqual(failedTasks.items.map((item) => item.id), [302]);

    const superUsage = await getUsageOverview(actors.superAdmin, { page: 1, pageSize: 20 }, db);
    assert.deepEqual(superUsage.summary, { recordCount: 2, estimatedCost: 10.623456 });
    assert.deepEqual(superUsage.breakdown.map((item) => item.taskType), ["image", "text"]);
    assert.deepEqual(superUsage.items.map((item) => item.pricingSnapshot), [null, null]);
    assert.deepEqual(superUsage.items.map((item) => item.billingMode), [null, null]);
    const adminUsage = await getUsageOverview(actors.adminA, { page: 1, pageSize: 20 }, db);
    assert.deepEqual(adminUsage.summary, { recordCount: 1, estimatedCost: 1.123456 });
    assert.deepEqual(adminUsage.items.map((item) => item.jobId), [401]);
    assert.equal(adminUsage.items[0].groupName, "A组");
    assert.equal(adminUsage.items[0].pricingSnapshot, null);
    assert.equal(adminUsage.items[0].billingMode, null);

    const validSnapshot = {
      pricingId: 7, providerId: "provider-a", modelId: "image-a", taskType: "image", billingMode: "per_request",
      requestPrice: 1.123456, currency: "CNY", version: 2, effectiveAt: now,
    };
    await db("o_usageLedger").where({ jobId: 401 }).update({ pricingSnapshotJson: JSON.stringify(validSnapshot) });
    const usageWithSnapshot = await getUsageOverview(actors.adminA, { page: 1, pageSize: 20 }, db);
    assert.deepEqual(usageWithSnapshot.items[0].pricingSnapshot, validSnapshot);
    assert.equal(usageWithSnapshot.items[0].billingMode, "per_request");

    await expectMonitoringError(listAdminTasks(actors.creatorA, { page: 1, pageSize: 20 }, db), 403, "ADMIN_REQUIRED");
    await expectMonitoringError(getUsageOverview(actors.adminA, { page: 1, pageSize: 20, groupId: 102 }, db), 404, "SCOPE_NOT_FOUND");

    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = req.header("x-test-actor") === "creator" ? actors.creatorA : actors.adminA;
      next();
    });
    app.use("/projects", createListProjectsRouter((actor, input) => listAdminProjects(actor, input, db)));
    app.use("/tasks", createListTasksRouter((actor, input) => listAdminTasks(actor, input, db)));
    app.use("/usage", createUsageOverviewRouter((actor, input) => getUsageOverview(actor, input, db)));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const request = async (path: string, headers: Record<string, string> = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
        return { status: response.status, body: await response.json() as any };
      };
      const projectsRoute = await request("/projects?page=1&pageSize=10&search=A项目");
      assert.equal(projectsRoute.status, 200);
      assert.deepEqual(projectsRoute.body.data.items.map((item: any) => item.id), [202, 201]);
      const tasksRoute = await request("/tasks?page=1&pageSize=10&state=failed");
      assert.equal(tasksRoute.status, 200);
      assert.deepEqual(tasksRoute.body.data.items.map((item: any) => item.id), [302]);
      const usageRoute = await request("/usage?page=1&pageSize=10&taskType=image");
      assert.equal(usageRoute.status, 200);
      assert.deepEqual(usageRoute.body.data.summary, { recordCount: 1, estimatedCost: 1.123456 });
      const crossGroupRoute = await request("/projects?page=1&pageSize=10&groupId=102");
      assert.equal(crossGroupRoute.status, 404);
      assert.equal(crossGroupRoute.body.data.code, "SCOPE_NOT_FOUND");
      const creatorRoute = await request("/usage?page=1&pageSize=10", { "x-test-actor": "creator" });
      assert.equal(creatorRoute.status, 403);
      assert.equal(creatorRoute.body.data.code, "ADMIN_REQUIRED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await db.destroy();
  }
}

main().then(
  () => { console.log("R3E admin monitoring tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
