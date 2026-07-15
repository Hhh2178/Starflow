import assert from "node:assert/strict";
import test from "node:test";
import { buildSelectableModelList } from "@/services/selectableModels";

test("an empty enabled Provider set is a successful empty model catalog", () => {
  const result = buildSelectableModelList("all", [], []);
  assert.deepEqual(result, []);
});

test("selectable models publish only enabled V2 Provider models", () => {
  const result = buildSelectableModelList(
    "image",
    [
      { id: "fixture-provider", name: "Fixture Provider", enabled: true },
      { id: "disabled-provider", name: "Disabled Provider", enabled: false },
    ],
    [
      { providerId: "fixture-provider", modelId: "text-model", displayName: "文本模型", capability: "text", enabled: true },
      { providerId: "fixture-provider", modelId: "image-model", displayName: "图片模型", capability: "image", enabled: true },
      { providerId: "fixture-provider", modelId: "disabled-image", displayName: "未启用图片", capability: "image", enabled: false },
      { providerId: "disabled-provider", modelId: "hidden-image", displayName: "隐藏图片", capability: "image", enabled: true },
    ],
  );

  assert.deepEqual(result, [{ id: "fixture-provider", label: "图片模型", value: "image-model", type: "image", name: "Fixture Provider" }]);
});
