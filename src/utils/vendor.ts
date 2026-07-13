import { transform } from "sucrase";
import fs from "fs";
import path from "path";
import u from "@/utils";

export function writeCode(id: string | number, tsCode: string) {
  const rootDir = u.getPath("vendor")
  fs.mkdirSync(rootDir, { recursive: true })
  if (fs.existsSync(path.join(rootDir,  `${id}.ts`))) {
    fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  }
  fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
}

export function getCode(id: string): string {
  const rootDir = u.getPath("vendor");
  const targetFile = path.join(rootDir, `${id}.ts`);
  if (!fs.existsSync(targetFile)) return "";
  return fs.readFileSync(targetFile, "utf-8");
}

export async function getModelList(id: string): Promise<Array<any>> {
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  const code = getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const vendorData = u.vm(jsCode);
  if(!vendorData || !vendorData.vendor || !vendorData.vendor.models) return [];
  const combined = [...JSON.parse(JSON.stringify(vendorData.vendor.models)), ...JSON.parse(models?.models ?? "[]")];
  const map = new Map<string, any>();
  for (const m of combined) {
    map.set(m.modelName, m);
  }
  return [...map.values()];
}

export function getVendor(id: string) {
  const code = getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const vendorData = u.vm(jsCode);
  return vendorData.vendor;
}

export async function hasLegacyVendorRuntime(providerId: string): Promise<boolean> {
  const row = await u.db("o_vendorConfig").where("id", providerId).select("id").first();
  return Boolean(row && getCode(providerId));
}

export async function loadLegacyVendorRuntime(providerId: string, modelId: string): Promise<{ model: any; runtime: any }> {
  const config = await u.db("o_vendorConfig").where("id", providerId).first();
  if (!config) throw new Error(`未找到供应商配置 id=${providerId}`);
  const models = await getModelList(providerId);
  const model = models.find((item: any) => item.modelName === modelId);
  if (!model) throw new Error(`未找到模型 ${modelId} id=${providerId}`);
  const jsCode = transform(getCode(providerId), { transforms: ["typescript"] }).code;
  const runtime = u.vm(jsCode);
  if (!runtime?.vendor) throw new Error(`供应商运行时无效 id=${providerId}`);
  Object.assign(runtime.vendor.inputValues, JSON.parse(config.inputValues ?? "{}"));
  runtime.vendor.models = models;
  return { model, runtime };
}
