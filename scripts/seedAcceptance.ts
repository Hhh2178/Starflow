import { db, dbReady } from "../src/utils/db";
import { seedAcceptanceFixture } from "../src/services/acceptanceFixture";

async function main() {
  if (process.env.NODE_ENV !== "dev" && process.env.STARS_ALLOW_ACCEPTANCE_FIXTURE !== "1") {
    throw new Error("验收 fixture 只能在开发环境运行");
  }
  const password = process.env.STARS_ACCEPTANCE_PASSWORD ?? "";
  if (!password) throw new Error("请通过 STARS_ACCEPTANCE_PASSWORD 提供本地验收账号密码");
  await dbReady;
  const result = await seedAcceptanceFixture(db, password);
  console.log(JSON.stringify({
    groups: result.groups,
    users: result.users.map(({ id, name, role, groupId }) => ({ id, name, role, groupId })),
    projectIds: result.projectIds,
    taskIds: result.taskIds,
    jobIds: result.jobIds,
  }, null, 2));
}

main().then(
  async () => { await db.destroy(); process.exit(0); },
  async (error) => { console.error(error instanceof Error ? error.message : "验收 fixture 执行失败"); await db.destroy(); process.exit(1); },
);
