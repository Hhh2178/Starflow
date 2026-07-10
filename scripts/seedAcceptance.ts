export {};

async function main() {
  if (process.env.NODE_ENV !== "dev" && process.env.STARS_ALLOW_ACCEPTANCE_FIXTURE !== "1") {
    throw new Error("验收 fixture 只能在开发环境运行");
  }
  const password = process.env.STARS_ACCEPTANCE_PASSWORD ?? "";
  if (!password) throw new Error("请通过 STARS_ACCEPTANCE_PASSWORD 提供本地验收账号密码");
  process.env.STARS_ACCEPTANCE_MODE = "1";
  const [{ db, dbReady }, { seedAcceptanceFixture }] = await Promise.all([
    import("../src/utils/db"),
    import("../src/services/acceptanceFixture"),
  ]);
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
  () => process.exit(0),
  (error) => { console.error(error instanceof Error ? error.message : "验收 fixture 执行失败"); process.exit(1); },
);
