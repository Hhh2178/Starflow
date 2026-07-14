import assert from "node:assert/strict";
import test from "node:test";
import { buildSelectableModelList } from "@/services/selectableModels";

test("an empty enabled Provider set is a successful empty model catalog", async () => {
  let modelLoads = 0;
  let providerLoads = 0;
  const result = await buildSelectableModelList(
    "all",
    [],
    async () => {
      modelLoads += 1;
      return [];
    },
    async () => {
      providerLoads += 1;
      return { name: "unused" };
    },
  );

  assert.deepEqual(result, []);
  assert.equal(modelLoads, 0);
  assert.equal(providerLoads, 0);
});

test("selectable models keep Provider identity and requested capability filtering", async () => {
  const result = await buildSelectableModelList(
    "image",
    [{ id: "fixture-provider" }],
    async () => [
      { name: "文本模型", modelName: "text-model", type: "text" },
      { name: "图片模型", modelName: "image-model", type: "image" },
    ],
    async () => ({ name: "Fixture Provider" }),
  );

  assert.deepEqual(result, [{ id: "fixture-provider", label: "图片模型", value: "image-model", type: "image", name: "Fixture Provider" }]);
});
