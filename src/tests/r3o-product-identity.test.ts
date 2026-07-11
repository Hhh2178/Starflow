import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("Provider and built-in asset display copy uses Stars Flow identity", () => {
  const vendorDirectory = path.join(root, "data", "vendor");
  const vendorCopy = fs
    .readdirSync(vendorDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(vendorDirectory, name), "utf8"))
    .join("\n");
  const materialRoute = fs.readFileSync(path.join(root, "src", "routes", "assets", "getMaterialData.ts"), "utf8");
  const bundledVendorCopy = fs.readFileSync(path.join(root, "src", "lib", "vendor.json"), "utf8");

  assert.doesNotMatch(vendorCopy, /Toonflow|GitHub|github\.com/);
  assert.doesNotMatch(bundledVendorCopy, /Toonflow|GitHub|github\.com/);
  assert.doesNotMatch(materialRoute, /Toonflow|GitHub|github\.com/);
});

test("legacy Provider data is upgraded to the rebranded 3.3 adapter", () => {
  const providerAdapter = fs.readFileSync(path.join(root, "data", "vendor", "toonflow.ts"), "utf8");
  const migration = fs.readFileSync(path.join(root, "src", "lib", "fixDB.ts"), "utf8");

  assert.match(providerAdapter, /version:\s*["']3\.3["']/);
  assert.match(migration, /toonflowVer\)\s*<\s*3\.3/);
});
