import assert from "node:assert/strict";
import test from "node:test";
import oss from "@/utils/oss";

test("browser runtime returns same-origin OSS URLs in development", async () => {
  const previousOssUrl = process.env.ossURL;
  delete process.env.ossURL;

  try {
    assert.equal(await oss.getFileUrl("group/image.png"), "/oss/group/image.png");
  } finally {
    if (previousOssUrl === undefined) delete process.env.ossURL;
    else process.env.ossURL = previousOssUrl;
  }
});
