import assert from "node:assert/strict";
import startServe, { closeServe } from "@/app";

async function request(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
  return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
}

async function main() {
  const port = await startServe(true);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const creator = await request(baseUrl, "/");
    assert.equal(creator.status, 200);
    assert.match(creator.contentType, /text\/html/);

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
