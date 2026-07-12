import assert from "node:assert/strict";
import knex from "knex";
import startServe, { closeServe, resolveServerListenConfig } from "@/app";
import initDB from "@/lib/initDB";

async function request(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
  return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
}

async function main() {
  const legacyDb = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await legacyDb.schema.createTable("o_skillList", (table) => table.text("id").primary());
    await legacyDb("o_skillList").insert({ id: "52c51fa8655f899a1b7aae9b6aad7251" });
    await initDB(legacyDb);
    const attributions = await legacyDb("o_skillAttribution").select("skillId", "attribution");
    assert.deepEqual(attributions, [{
      skillId: "52c51fa8655f899a1b7aae9b6aad7251",
      attribution: "universal_agent.md",
    }]);
  } finally {
    await legacyDb.destroy();
  }
  assert.deepEqual(resolveServerListenConfig({ STARS_HOST: "127.0.0.1", STARS_PORT: "18300" }), {
    host: "127.0.0.1",
    port: 18300,
  });
  assert.throws(() => resolveServerListenConfig({ STARS_PORT: "70000" }), /STARS_PORT/);
  const port = await startServe(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const creator = await request(baseUrl, "/");
    assert.equal(creator.status, 200);
    assert.match(creator.contentType, /text\/html/);

    const health = await request(baseUrl, "/healthz");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).status, "ok");

    for (const pathname of ["/admin/login", "/admin/queue"]) {
      const admin = await request(baseUrl, pathname);
      assert.equal(admin.status, 200, `${pathname} should return the Admin SPA entry`);
      assert.match(admin.contentType, /text\/html/);
      assert.match(admin.text, /Stars Flow 管理后台/);
    }

    const api = await request(baseUrl, "/api/not-found");
    assert.equal(api.status, 401);
    assert.doesNotMatch(api.contentType, /text\/html/);
  } finally {
    await closeServe();
  }
}

main().then(
  () => { console.log("R3M static hosting tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
