export {};

async function main() {
  process.env.STARS_ACCEPTANCE_MODE = "1";
  process.env.STARS_ACCEPTANCE_DELAY_MS ??= "4000";
  const { default: startServe, closeServe } = await import("../src/app");
  const port = await startServe(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[浏览器验收] Creator: ${baseUrl}/`);
  console.log(`[浏览器验收] Admin:   ${baseUrl}/admin/`);
  console.log(`[浏览器验收] Backend: ${baseUrl}/api`);
  console.log("[浏览器验收] 生成执行器: 本地延迟/失败适配器");

  const shutdown = async () => {
    await closeServe();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "浏览器验收服务启动失败");
  process.exit(1);
});
