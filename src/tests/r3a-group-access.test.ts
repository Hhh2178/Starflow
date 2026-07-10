import assert from "node:assert/strict";
import knex, { Knex } from "knex";
import initDB from "@/lib/initDB";
import * as fixDBModule from "@/lib/fixDB";

type GroupOwnershipMigration = (db: Knex) => Promise<void>;

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

async function main(): Promise<void> {
  const migration = (fixDBModule as typeof fixDBModule & {
    migrateGroupOwnership?: GroupOwnershipMigration;
  }).migrateGroupOwnership;
  assert.equal(typeof migration, "function", "fixDB must export migrateGroupOwnership");
  const migrate = migration as GroupOwnershipMigration;

  await testPreassignedMigration(migrate);
  await testLegacySchemaUpgrade(migrate);
  await testFreshSchema();
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
