import assert from "node:assert/strict";
import startServe, { closeServe } from "@/app";
import { db } from "@/utils/db";

async function assertSchema() {
  let serverStarted = false;

  try {
    await startServe(true);
    serverStarted = true;

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
  } finally {
    if (serverStarted) await closeServe();
  }
}

assertSchema().then(
  () => {
    console.log("R3A group ownership schema smoke passed");
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
