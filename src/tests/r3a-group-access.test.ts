import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import knex, { Knex } from "knex";
import initDB from "@/lib/initDB";
import * as fixDBModule from "@/lib/fixDB";
import { hashPassword } from "@/utils/password";

type GroupOwnershipMigration = (db: Knex) => Promise<void>;

function assertRouteAccessMatrix(): void {
  const routeRoot = path.resolve("src/routes");
  const guardedDirectories = ["novel", "script", "scriptAgent", "assets", "assetsGenerate", "cornerScape", "production", "general", "project", "task"];
  const policySource = fs.readFileSync(path.resolve("src/middleware/projectAccess.ts"), "utf8");
  const explicitRouteGuards = new Set([
    "/api/project/addProject",
    "/api/project/delProject",
    "/api/project/editProject",
    "/api/project/getProject",
    "/api/project/getModelDetails",
    "/api/project/getVisualManual",
    "/api/project/queryDirectorManual",
    "/api/project/visualManual",
    "/api/task/getProject",
    "/api/task/getTaskApi",
    "/api/task/getTaskCategories",
    "/api/task/taskDetails",
  ]);
  const contextField = /\b(projectId|novelId|novelIds|scriptId|scriptIds|episodesId|assetId|assetIds|assetsId|assetsIds|storyboardId|storyboardIds|videoId|videoIds|trackId|trackIds|taskId|taskIds|flowId)\s*:/;
  const missing: string[] = [];

  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const relative = path.relative(routeRoot, absolute).replace(/\\/g, "/").replace(/\.ts$/, "");
      const route = `/api/${relative}`;
      const source = fs.readFileSync(absolute, "utf8");
      if (!contextField.test(source) && !policySource.includes(`"${route}"`) && !explicitRouteGuards.has(route)) missing.push(route);
    }
  };

  for (const directory of guardedDirectories) visit(path.join(routeRoot, directory));
  assert.deepEqual(missing, [], `routes missing access policy: ${missing.join(", ")}`);
}

function createTestDB(): Knex {
  return knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
}

async function withTestDB(run: (db: Knex) => Promise<void>): Promise<void> {
  const db = createTestDB();
  try {
    await run(db);
  } finally {
    await db.destroy();
  }
}

async function assertRequiredSchema(db: Knex): Promise<void> {
  for (const table of ["o_group", "o_auditLog"]) {
    assert.equal(await db.schema.hasTable(table), true, `${table} must exist`);
  }

  for (const [table, column] of [
    ["o_user", "groupId"],
    ["o_project", "ownerUserId"],
    ["o_project", "groupId"],
    ["o_tasks", "ownerUserId"],
    ["o_tasks", "groupId"],
    ["o_imageFlow", "projectId"],
  ] as const) {
    assert.equal(await db.schema.hasColumn(table, column), true, `${table}.${column} must exist`);
  }
}

async function testFreshSchema(): Promise<void> {
  await withTestDB(async (db) => {
    await initDB(db, false, false);
    await assertRequiredSchema(db);

    const [groupId] = await db("o_group").insert({ name: "Fresh", createdAt: 1, updatedAt: 1 });
    const group = await db("o_group").where({ id: groupId }).first();
    assert.equal(group.adminUserId, null);
    assert.equal(group.creatorLimit, 5);
    assert.equal(group.status, "enabled");

    await assert.rejects(
      Promise.resolve(db("o_group").insert({ createdAt: 1, updatedAt: 1 })),
      /NOT NULL constraint failed: o_group.name/,
    );
    await db("o_group").insert({ name: "Admin A", adminUserId: 77, createdAt: 1, updatedAt: 1 });
    await assert.rejects(
      Promise.resolve(
        db("o_group").insert({ name: "Admin B", adminUserId: 77, createdAt: 1, updatedAt: 1 }),
      ),
      /UNIQUE constraint failed: o_group.adminUserId/,
    );

    const [auditId] = await db("o_auditLog").insert({
      actorUserId: 1,
      actorRole: "super_admin",
      action: "schema.test",
      targetType: "group",
      result: "success",
      createdAt: 1,
    });
    const audit = await db("o_auditLog").where({ id: auditId }).first();
    assert.equal(audit.groupId, null);
    assert.equal(audit.summaryJson, "{}");
    assert.equal(audit.targetId, null);
    assert.equal(audit.requestId, null);
  });
}

async function createOwnershiplessLegacySchema(db: Knex): Promise<void> {
  await db.schema.createTable("o_user", (table) => {
    table.integer("id").primary();
    table.text("name");
    table.text("role");
  });
  await db.schema.createTable("o_project", (table) => {
    table.integer("id").primary();
    table.integer("userId");
  });
  await db.schema.createTable("o_tasks", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
  });
}

async function testLegacySchemaUpgrade(migrate: GroupOwnershipMigration): Promise<void> {
  await withTestDB(async (db) => {
    await createOwnershiplessLegacySchema(db);
    await db("o_user").insert([
      { id: 1, name: "root", role: "super_admin" },
      { id: 2, name: "legacy-admin", role: "admin" },
      { id: 3, name: "legacy-creator", role: "creator" },
    ]);
    await db("o_project").insert([
      { id: 10, userId: 2 },
      { id: 11, userId: 1 },
    ]);
    await db("o_tasks").insert([
      { id: 20, projectId: 10 },
      { id: 21, projectId: 11 },
    ]);

    await migrate(db);
    await assertRequiredSchema(db);
    await migrate(db);

    const pending = await db("o_group").where({ name: "待分配", adminUserId: null });
    assert.equal(pending.length, 1);
    const admin = await db("o_user").where({ id: 2 }).first();
    const creator = await db("o_user").where({ id: 3 }).first();
    assert.notEqual(admin.groupId, null);
    assert.equal(creator.groupId, pending[0].id);

    const adminProject = await db("o_project").where({ id: 10 }).first();
    const superAdminProject = await db("o_project").where({ id: 11 }).first();
    assert.equal(adminProject.ownerUserId, 2);
    assert.equal(adminProject.groupId, admin.groupId);
    assert.equal(superAdminProject.ownerUserId, 1);
    assert.equal(superAdminProject.groupId, pending[0].id);

    const adminTask = await db("o_tasks").where({ id: 20 }).first();
    const superAdminTask = await db("o_tasks").where({ id: 21 }).first();
    assert.equal(adminTask.ownerUserId, 2);
    assert.equal(adminTask.groupId, admin.groupId);
    assert.equal(superAdminTask.ownerUserId, 1);
    assert.equal(superAdminTask.groupId, pending[0].id);
  });
}

async function createPreassignedLegacySchema(db: Knex): Promise<void> {
  await db.schema.createTable("o_group", (table) => {
    table.increments("id").primary();
    table.text("name").notNullable();
    table.integer("adminUserId").unique();
    table.integer("creatorLimit").notNullable().defaultTo(5);
    table.text("status").notNullable().defaultTo("enabled");
    table.integer("createdAt").notNullable();
    table.integer("updatedAt").notNullable();
  });
  await db.schema.createTable("o_user", (table) => {
    table.integer("id").primary();
    table.text("name");
    table.text("role");
    table.integer("groupId");
  });
  await db.schema.createTable("o_project", (table) => {
    table.integer("id").primary();
    table.integer("userId");
    table.integer("ownerUserId");
    table.integer("groupId");
  });
  await db.schema.createTable("o_tasks", (table) => {
    table.integer("id").primary();
    table.integer("projectId");
    table.integer("ownerUserId");
    table.integer("groupId");
  });
}

async function testPreassignedMigration(migrate: GroupOwnershipMigration): Promise<void> {
  await withTestDB(async (db) => {
    await createPreassignedLegacySchema(db);
    await db("o_group").insert([
      { id: 10, name: "alice组", adminUserId: null, createdAt: 1, updatedAt: 1 },
      { id: 11, name: "owner组", adminUserId: 99, createdAt: 1, updatedAt: 1 },
      { id: 12, name: "bob组", adminUserId: 3, createdAt: 1, updatedAt: 1 },
      { id: 13, name: "待分配", adminUserId: null, createdAt: 1, updatedAt: 1 },
    ]);
    await db("o_user").insert([
      { id: 1, name: "root", role: "super_admin", groupId: null },
      { id: 2, name: "alice", role: "admin", groupId: 10 },
      { id: 3, name: "bob", role: "admin", groupId: 11 },
      { id: 4, name: "carol", role: "admin", groupId: null },
      { id: 5, name: "creator-a", role: "creator", groupId: 10 },
      { id: 6, name: "creator-b", role: "creator", groupId: null },
      { id: 7, name: "creator-c", role: "creator", groupId: 999 },
      { id: 99, name: "owner", role: "admin", groupId: 11 },
    ]);
    await db("o_project").insert([
      { id: 100, userId: 5, ownerUserId: null, groupId: null },
      { id: 101, userId: 1, ownerUserId: null, groupId: null },
      { id: 102, userId: 404, ownerUserId: null, groupId: null },
      { id: 103, userId: 7, ownerUserId: null, groupId: null },
      { id: 104, userId: 5, ownerUserId: 6, groupId: 13 },
    ]);
    await db("o_tasks").insert([
      { id: 200, projectId: 100, ownerUserId: null, groupId: null },
      { id: 201, projectId: 104, ownerUserId: 2, groupId: 10 },
    ]);

    await migrate(db);

    const pending = await db("o_group").where({ name: "待分配", adminUserId: null });
    assert.equal(pending.length, 1);
    assert.equal((await db("o_group").where({ name: "alice组" })).length, 1);
    assert.equal((await db("o_group").where({ adminUserId: 4 })).length, 1);

    assert.equal((await db("o_group").where({ id: 10 }).first()).adminUserId, 2);
    assert.equal((await db("o_group").where({ id: 11 }).first()).adminUserId, 99);
    assert.equal((await db("o_user").where({ id: 2 }).first()).groupId, 10);
    assert.equal((await db("o_user").where({ id: 3 }).first()).groupId, 12);
    assert.equal((await db("o_user").where({ id: 6 }).first()).groupId, 13);

    const projects = new Map((await db("o_project").select("*")).map((project) => [project.id, project]));
    assert.deepEqual([projects.get(100).ownerUserId, projects.get(100).groupId], [5, 10]);
    assert.deepEqual([projects.get(101).ownerUserId, projects.get(101).groupId], [1, 13]);
    assert.deepEqual([projects.get(102).ownerUserId, projects.get(102).groupId], [404, 13]);
    assert.deepEqual([projects.get(103).ownerUserId, projects.get(103).groupId], [7, 13]);
    assert.deepEqual([projects.get(104).ownerUserId, projects.get(104).groupId], [6, 13]);

    const tasks = new Map((await db("o_tasks").select("*")).map((task) => [task.id, task]));
    assert.deepEqual([tasks.get(200).ownerUserId, tasks.get(200).groupId], [5, 10]);
    assert.deepEqual([tasks.get(201).ownerUserId, tasks.get(201).groupId], [2, 10]);

    const beforeSecondRun = {
      groups: await db("o_group").select("*").orderBy("id"),
      users: await db("o_user").select("*").orderBy("id"),
      projects: await db("o_project").select("*").orderBy("id"),
      tasks: await db("o_tasks").select("*").orderBy("id"),
    };
    await migrate(db);
    const afterSecondRun = {
      groups: await db("o_group").select("*").orderBy("id"),
      users: await db("o_user").select("*").orderBy("id"),
      projects: await db("o_project").select("*").orderBy("id"),
      tasks: await db("o_tasks").select("*").orderBy("id"),
    };
    assert.deepEqual(afterSecondRun, beforeSecondRun);
  });
}

type ApiResult = { status: number; body: any };

async function request(baseUrl: string, path: string, token?: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
      ...(init.headers || {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const result = await request(baseUrl, "/api/login/login", undefined, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.status, 200, `login failed for ${username}`);
  assert.equal(typeof result.body?.data?.token, "string");
  return result.body.data.token;
}

function projectInput(name: string, groupId?: number): Record<string, unknown> {
  return {
    projectType: "series",
    name,
    intro: "R3A 项目隔离测试",
    type: "short-drama",
    artStyle: "cinematic",
    directorManual: "",
    videoRatio: "16:9",
    imageModel: "test-image",
    videoModel: "test-video",
    imageQuality: "standard",
    mode: "standard",
    ...(groupId === undefined ? {} : { groupId }),
  };
}

async function testAdminSession(): Promise<void> {
  const [{ default: startServe, closeServe }, { default: u }] = await Promise.all([import("@/app"), import("@/utils")]);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
  const adminName = `r3a-admin-${suffix}`;
  const creatorName = `r3a-creator-${suffix}`;
  const orphanName = `r3a-orphan-${suffix}`;
  const adminBName = `r3a-admin-b-${suffix}`;
  const creatorBName = `r3a-creator-b-${suffix}`;
  const createdCreatorNames = Array.from({ length: 5 }, (_, index) => `r3a-created-${index}-${suffix}`);
  const forbiddenAdminName = `r3a-forbidden-${suffix}`;
  const projectNames = [`r3a-project-a-${suffix}`, `r3a-project-b-${suffix}`, `r3a-project-c-${suffix}`];
  const password = "TempPass123";
  const now = Date.now();
  let baseUrl = "";
  let groupId: number | null = null;
  let groupBId: number | null = null;
  let userIds: number[] = [];
  let projectIds: number[] = [];
  let taskIds: number[] = [];
  let resourceIds: Record<string, number> | null = null;
  let auditLogIds: number[] = [];
  let auditActorIds: number[] = [1];

  try {
    const maxUser = await u.db("o_user").max<{ maxId: number | null }>("id as maxId").first();
    const firstUserId = Number(maxUser?.maxId ?? 0) + 1;
    userIds = [firstUserId, firstUserId + 1, firstUserId + 2, firstUserId + 3, firstUserId + 4];
    const [createdGroupId] = await u.db("o_group").insert({
      name: `R3A ${suffix}`,
      adminUserId: userIds[0],
      creatorLimit: 5,
      status: "enabled",
      createdAt: now,
      updatedAt: now,
    });
    groupId = Number(createdGroupId);
    const [createdGroupBId] = await u.db("o_group").insert({
      name: `R3A B ${suffix}`,
      adminUserId: userIds[3],
      creatorLimit: 5,
      status: "enabled",
      createdAt: now,
      updatedAt: now,
    });
    groupBId = Number(createdGroupBId);
    await u.db("o_user").insert([
      {
        id: userIds[0],
        name: adminName,
        passwordHash: hashPassword(password),
        role: "admin",
        status: "enabled",
        groupId,
        createdAt: now,
        updatedAt: now,
        mustChangePassword: false,
      },
      {
        id: userIds[1],
        name: creatorName,
        passwordHash: hashPassword(password),
        role: "creator",
        status: "enabled",
        groupId,
        createdAt: now,
        updatedAt: now,
        mustChangePassword: false,
      },
      {
        id: userIds[3],
        name: adminBName,
        passwordHash: hashPassword(password),
        role: "admin",
        status: "enabled",
        groupId: groupBId,
        createdAt: now,
        updatedAt: now,
        mustChangePassword: false,
      },
      {
        id: userIds[4],
        name: creatorBName,
        passwordHash: hashPassword(password),
        role: "creator",
        status: "enabled",
        groupId: groupBId,
        createdAt: now,
        updatedAt: now,
        mustChangePassword: false,
      },
    ]);

    const port = await startServe(true);
    baseUrl = `http://127.0.0.1:${port}`;
    await u.db("o_user").insert({
      id: userIds[2],
      name: orphanName,
      passwordHash: hashPassword(password),
      role: "admin",
      status: "enabled",
      groupId: null,
      createdAt: now,
      updatedAt: now,
      mustChangePassword: false,
    });
    const adminToken = await login(baseUrl, adminName, password);
    const creatorToken = await login(baseUrl, creatorName, password);
    const orphanToken = await login(baseUrl, orphanName, password);

    const adminSession = await request(baseUrl, "/api/admin/auth/session", adminToken);
    assert.equal(adminSession.status, 200);
    assert.equal(adminSession.body.data.role, "admin");
    assert.equal(adminSession.body.data.groupId, groupId);
    assert.equal(adminSession.body.data.groupName, `R3A ${suffix}`);

    const creatorSession = await request(baseUrl, "/api/admin/auth/session", creatorToken);
    assert.equal(creatorSession.status, 403);

    const orphanSession = await request(baseUrl, "/api/setting/loginConfig/me", orphanToken);
    assert.equal(orphanSession.status, 403);
    assert.match(orphanSession.body.message, /尚未分配分组/);

    for (const name of createdCreatorNames.slice(0, 4)) {
      const created = await request(baseUrl, "/api/admin/users/createUser", adminToken, {
        method: "POST",
        body: JSON.stringify({ name, password, role: "creator" }),
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.data.groupId, groupId);
    }
    const overLimit = await request(baseUrl, "/api/admin/users/createUser", adminToken, {
      method: "POST",
      body: JSON.stringify({ name: createdCreatorNames[4], password, role: "creator" }),
    });
    assert.equal(overLimit.status, 409);

    const adminUsers = await request(baseUrl, "/api/admin/users/listUsers", adminToken);
    assert.equal(adminUsers.status, 200);
    assert.equal(adminUsers.body.data.length, 5);
    assert.ok(adminUsers.body.data.every((user: any) => user.role === "creator" && user.groupId === groupId));
    assert.equal(adminUsers.body.data.some((user: any) => user.id === userIds[3] || user.id === userIds[4]), false);
    auditActorIds = [...new Set([1, ...userIds, ...adminUsers.body.data.map((user: any) => Number(user.id))])];

    const creatorSameGroupToken = await login(baseUrl, createdCreatorNames[0], password);
    const creatorOtherGroupToken = await login(baseUrl, creatorBName, password);
    const adminOtherGroupToken = await login(baseUrl, adminBName, password);
    for (const [token, name] of [
      [creatorToken, projectNames[0]],
      [creatorSameGroupToken, projectNames[1]],
      [creatorOtherGroupToken, projectNames[2]],
    ] as const) {
      const created = await request(baseUrl, "/api/project/addProject", token, {
        method: "POST",
        body: JSON.stringify(projectInput(name, groupBId ?? undefined)),
      });
      assert.equal(created.status, 200);
    }

    const projects = await u.db("o_project").whereIn("name", projectNames).select("id", "name", "ownerUserId", "groupId");
    assert.equal(projects.length, 3);
    const projectsByName = new Map(projects.map((project: any) => [project.name, project]));
    const projectA = projectsByName.get(projectNames[0]);
    const projectB = projectsByName.get(projectNames[1]);
    const projectC = projectsByName.get(projectNames[2]);
    assert.ok(projectA && projectB && projectC);
    projectIds = [Number(projectA.id), Number(projectB.id), Number(projectC.id)];
    assert.deepEqual([projectA.ownerUserId, projectA.groupId], [userIds[1], groupId]);
    assert.equal(projectB.groupId, groupId);
    assert.deepEqual([projectC.ownerUserId, projectC.groupId], [userIds[4], groupBId]);

    const visibleProjectIds = async (token: string): Promise<number[]> => {
      const result = await request(baseUrl, "/api/project/getProject", token, { method: "POST", body: "{}" });
      assert.equal(result.status, 200);
      return result.body.data.map((project: any) => Number(project.id)).filter((id: number) => projectIds.includes(id));
    };
    assert.deepEqual(await visibleProjectIds(creatorToken), [projectIds[0]]);
    assert.deepEqual(await visibleProjectIds(creatorSameGroupToken), [projectIds[1]]);
    assert.deepEqual((await visibleProjectIds(adminToken)).sort(), [projectIds[0], projectIds[1]].sort());
    assert.deepEqual(await visibleProjectIds(adminOtherGroupToken), [projectIds[2]]);

    const sameGroupEdit = await request(baseUrl, "/api/project/editProject", adminToken, {
      method: "POST",
      body: JSON.stringify({ ...projectInput(`组内编辑-${suffix}`), id: projectIds[1] }),
    });
    assert.equal(sameGroupEdit.status, 200);

    const taskIdBase = Date.now() + 1000;
    taskIds = [taskIdBase, taskIdBase + 1, taskIdBase + 2];
    await u.db("o_tasks").insert([
      {
        id: taskIds[0], projectId: projectIds[0], ownerUserId: userIds[1], groupId,
        taskClass: `task-a-${suffix}`, state: "completed", startTime: now,
      },
      {
        id: taskIds[1], projectId: projectIds[1], ownerUserId: projectB.ownerUserId, groupId,
        taskClass: `task-b-${suffix}`, state: "completed", startTime: now,
      },
      {
        id: taskIds[2], projectId: projectIds[2], ownerUserId: userIds[4], groupId: groupBId,
        taskClass: `task-c-${suffix}`, state: "completed", startTime: now,
      },
    ]);

    const visibleTaskIds = async (token: string): Promise<number[]> => {
      const result = await request(baseUrl, "/api/task/getTaskApi", token, {
        method: "POST",
        body: JSON.stringify({ page: 1, limit: 20 }),
      });
      assert.equal(result.status, 200);
      return result.body.data.data.map((task: any) => Number(task.id)).filter((id: number) => taskIds.includes(id));
    };
    assert.deepEqual(await visibleTaskIds(creatorToken), [taskIds[0]]);
    assert.deepEqual((await visibleTaskIds(adminToken)).sort(), [taskIds[0], taskIds[1]].sort());
    assert.deepEqual(await visibleTaskIds(adminOtherGroupToken), [taskIds[2]]);

    const taskProjects = await request(baseUrl, "/api/task/getProject", adminToken, { method: "POST", body: "{}" });
    assert.equal(taskProjects.status, 200);
    const taskProjectIds = taskProjects.body.data.map((project: any) => Number(project.id));
    assert.equal(taskProjectIds.includes(projectIds[2]), false);
    const taskCategories = await request(baseUrl, "/api/task/getTaskCategories", adminToken, { method: "POST", body: "{}" });
    assert.equal(taskCategories.status, 200);
    assert.equal(taskCategories.body.data.some((item: any) => item.taskClass === `task-c-${suffix}`), false);
    const crossGroupTaskDetail = await request(baseUrl, "/api/task/taskDetails", adminToken, {
      method: "POST",
      body: JSON.stringify({ taskId: taskIds[2] }),
    });
    assert.equal(crossGroupTaskDetail.status, 404);

    const resourceIdBase = Date.now() + 5000;
    resourceIds = {
      novel: resourceIdBase,
      script: resourceIdBase + 1,
      asset: resourceIdBase + 2,
      image: resourceIdBase + 3,
      storyboard: resourceIdBase + 4,
      track: resourceIdBase + 5,
      video: resourceIdBase + 6,
    };
    await u.db("o_novel").insert({ id: resourceIds.novel, projectId: projectIds[2], chapter: "外组原文", chapterData: "不可见" });
    await u.db("o_script").insert({ id: resourceIds.script, projectId: projectIds[2], name: "外组剧本", content: "不可见" });
    await u.db("o_assets").insert({ id: resourceIds.asset, projectId: projectIds[2], name: "外组资产", describe: "不可见" });
    await u.db("o_image").insert({ id: resourceIds.image, assetsId: resourceIds.asset, state: "已完成" });
    await u.db("o_storyboard").insert({ id: resourceIds.storyboard, projectId: projectIds[2], scriptId: resourceIds.script, prompt: "原提示" });
    await u.db("o_videoTrack").insert({ id: resourceIds.track, projectId: projectIds[2], scriptId: resourceIds.script, prompt: "原视频提示" });
    await u.db("o_video").insert({ id: resourceIds.video, projectId: projectIds[2], scriptId: resourceIds.script, videoTrackId: resourceIds.track });

    const crossGroupNovelList = await request(baseUrl, "/api/novel/getNovelData", adminToken, {
      method: "POST",
      body: JSON.stringify({ projectId: projectIds[2] }),
    });
    assert.equal(crossGroupNovelList.status, 404);

    const deniedResourceMutations = [
      ["/api/novel/updateNovel", { id: resourceIds.novel, index: 1, reel: "1", chapter: "越权", chapterData: "越权", event: "" }],
      ["/api/script/updateScript", { id: resourceIds.script, name: "越权", content: "越权", assets: [] }],
      ["/api/assets/updateAssets", { id: resourceIds.asset, name: "越权", describe: "越权" }],
      ["/api/assets/delImage", { id: resourceIds.image }],
      ["/api/production/storyboard/editStoryboardInfo", { id: resourceIds.storyboard, prompt: "越权", videoDesc: "越权" }],
      ["/api/production/workbench/updateVideoPrompt", { id: resourceIds.track, prompt: "越权" }],
    ] as const;
    for (const [path, body] of deniedResourceMutations) {
      const result = await request(baseUrl, path, adminToken, { method: "POST", body: JSON.stringify(body) });
      assert.equal(result.status, 404, `${path} must hide cross-group resources`);
    }
    assert.equal((await u.db("o_novel").where("id", resourceIds.novel).select("chapter").first())?.chapter, "外组原文");
    assert.equal((await u.db("o_script").where("id", resourceIds.script).select("name").first())?.name, "外组剧本");
    assert.equal((await u.db("o_assets").where("id", resourceIds.asset).select("name").first())?.name, "外组资产");
    assert.equal((await u.db("o_image").where("id", resourceIds.image).first())?.id, resourceIds.image);
    assert.equal((await u.db("o_storyboard").where("id", resourceIds.storyboard).select("prompt").first())?.prompt, "原提示");
    assert.equal((await u.db("o_videoTrack").where("id", resourceIds.track).select("prompt").first())?.prompt, "原视频提示");

    const { authenticateSocketProject } = await import("@/socket/auth");
    assert.equal(await authenticateSocketProject(creatorToken, projectIds[2]), null);
    const socketActor = await authenticateSocketProject(creatorToken, projectIds[0]);
    assert.equal(socketActor?.id, userIds[1]);
    assert.equal(socketActor?.groupId, groupId);
    assert.equal(await authenticateSocketProject(creatorToken, projectIds[0], resourceIds.script), null);

    const adminGlobalManualMutation = await request(baseUrl, "/api/project/deleteVisualManual", adminToken, {
      method: "POST",
      body: JSON.stringify({ name: `不存在-${suffix}` }),
    });
    assert.equal(adminGlobalManualMutation.status, 403);

    const crossGroupEdit = await request(baseUrl, "/api/project/editProject", adminToken, {
      method: "POST",
      body: JSON.stringify({ ...projectInput("不可见项目"), id: projectIds[2] }),
    });
    assert.equal(crossGroupEdit.status, 404);
    const crossOwnerDelete = await request(baseUrl, "/api/project/delProject", creatorSameGroupToken, {
      method: "POST",
      body: JSON.stringify({ id: projectIds[0] }),
    });
    assert.equal(crossOwnerDelete.status, 404);
    const creatorPermanentDelete = await request(baseUrl, "/api/project/delProject", creatorToken, {
      method: "POST",
      body: JSON.stringify({ id: projectIds[0] }),
    });
    assert.equal(creatorPermanentDelete.status, 403);

    const crossGroupUpdate = await request(baseUrl, "/api/admin/users/updateUser", adminToken, {
      method: "POST",
      body: JSON.stringify({ id: userIds[4], status: "disabled" }),
    });
    assert.equal(crossGroupUpdate.status, 404);
    const crossGroupReset = await request(baseUrl, "/api/admin/users/resetPassword", adminToken, {
      method: "POST",
      body: JSON.stringify({ id: userIds[4], password: "ResetPass123" }),
    });
    assert.equal(crossGroupReset.status, 404);

    const adminGroups = await request(baseUrl, "/api/admin/groups/listGroups", adminToken);
    assert.equal(adminGroups.status, 403);

    const adminCreateAdmin = await request(baseUrl, "/api/admin/users/createUser", adminToken, {
      method: "POST",
      body: JSON.stringify({ name: forbiddenAdminName, password, role: "admin" }),
    });
    assert.equal(adminCreateAdmin.status, 403);

    const superAdminToken = await login(baseUrl, "admin", "admin123");
    const changeRoleWithoutRebinding = await request(baseUrl, "/api/admin/users/updateUser", superAdminToken, {
      method: "POST",
      body: JSON.stringify({ id: userIds[4], role: "admin" }),
    });
    assert.equal(changeRoleWithoutRebinding.status, 409);
    assert.equal((await u.db("o_user").where("id", userIds[4]).select("role").first())?.role, "creator");

    const swapGroupAdmins = await request(baseUrl, "/api/admin/groups/updateGroup", superAdminToken, {
      method: "POST",
      body: JSON.stringify({ id: groupId, adminUserId: userIds[3] }),
    });
    assert.equal(swapGroupAdmins.status, 200);
    assert.equal((await u.db("o_group").where("id", groupId).select("adminUserId").first())?.adminUserId, userIds[3]);
    assert.equal((await u.db("o_group").where("id", groupBId).select("adminUserId").first())?.adminUserId, userIds[0]);
    assert.equal((await u.db("o_user").where("id", userIds[0]).select("groupId").first())?.groupId, groupBId);
    assert.equal((await u.db("o_user").where("id", userIds[3]).select("groupId").first())?.groupId, groupId);

    await u.db("o_group").where("id", groupBId).update({ creatorLimit: 1 });
    const moveIntoFullGroup = await request(baseUrl, "/api/admin/users/updateUser", superAdminToken, {
      method: "POST",
      body: JSON.stringify({ id: userIds[1], groupId: groupBId }),
    });
    assert.equal(moveIntoFullGroup.status, 409);
    const creatorAfterRejectedMove = await u.db("o_user").where("id", userIds[1]).select("groupId").first();
    assert.ok(creatorAfterRejectedMove);
    assert.equal(creatorAfterRejectedMove.groupId, groupId);

    const allGroups = await request(baseUrl, "/api/admin/groups/listGroups", superAdminToken);
    assert.equal(allGroups.status, 200);
    assert.ok(allGroups.body.data.some((group: any) => group.id === groupId));
    assert.ok(allGroups.body.data.some((group: any) => group.id === groupBId));

    const auditLogs = await u
      .db("o_auditLog")
      .whereIn("actorUserId", auditActorIds)
      .where("createdAt", ">=", now)
      .select("id", "action", "summaryJson");
    auditLogIds = auditLogs.map((log: any) => Number(log.id));
    const auditActions = new Set(auditLogs.map((log: any) => log.action));
    for (const action of ["user.create", "user.update.rejected", "user.password_reset.rejected", "project.create", "project.update", "group.update", "resource.access.rejected"]) {
      assert.equal(auditActions.has(action), true, `missing audit action ${action}`);
    }
    for (const log of auditLogs) {
      assert.doesNotMatch(String(log.summaryJson), /password|passwordHash|apiKey|token/i);
    }
  } finally {
    if (baseUrl) await closeServe();
    if (auditLogIds.length) await u.db("o_auditLog").whereIn("id", auditLogIds).delete();
    if (resourceIds) {
      await u.db("o_video").where("id", resourceIds.video).delete();
      await u.db("o_videoTrack").where("id", resourceIds.track).delete();
      await u.db("o_storyboard").where("id", resourceIds.storyboard).delete();
      await u.db("o_image").where("id", resourceIds.image).delete();
      await u.db("o_assets").where("id", resourceIds.asset).delete();
      await u.db("o_script").where("id", resourceIds.script).delete();
      await u.db("o_novel").where("id", resourceIds.novel).delete();
    }
    if (taskIds.length) await u.db("o_tasks").whereIn("id", taskIds).delete();
    if (projectIds.length) await u.db("o_project").whereIn("id", projectIds).delete();
    await u.db("o_user").whereIn("name", [...createdCreatorNames, forbiddenAdminName]).delete();
    if (userIds.length) await u.db("o_user").whereIn("id", userIds).delete();
    if (groupId !== null) await u.db("o_group").where("id", groupId).delete();
    if (groupBId !== null) await u.db("o_group").where("id", groupBId).delete();
  }
}

async function main(): Promise<void> {
  assertRouteAccessMatrix();
  const migration = (fixDBModule as typeof fixDBModule & {
    migrateGroupOwnership?: GroupOwnershipMigration;
  }).migrateGroupOwnership;
  assert.equal(typeof migration, "function", "fixDB must export migrateGroupOwnership");
  const migrate = migration as GroupOwnershipMigration;

  await testPreassignedMigration(migrate);
  await testLegacySchemaUpgrade(migrate);
  await testFreshSchema();
  await testAdminSession();
}

main().then(
  () => {
    console.log("R3A group ownership schema and migration tests passed");
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
