interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  inputs: Array<{
    key: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    placeholder?: string;
  }>;
  inputValues: Record<string, string>;
  models: TextModel[];
}

declare const createOpenAI: any;
declare const exports: Record<string, any>;

const vendor: VendorConfig = {
  id: "mimo",
  version: "1.0",
  name: "小米 MiMo",
  author: "Stars Flow",
  description: "小米 MiMo 文本模型服务",
  inputs: [
    { key: "apiKey", label: "API 密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.xiaomimimo.com/v1",
  },
  models: [
    { name: "MiMo V2.5", modelName: "mimo-v2.5", type: "text", think: true },
    { name: "MiMo V2.5 Pro", modelName: "mimo-v2.5-pro", type: "text", think: true },
  ],
};

const textRequest = (model: TextModel) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API 密钥");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseURL = vendor.inputValues.baseUrl.replace(/\/+$/, "");
  return createOpenAI({ baseURL, apiKey }).chat(model.modelName);
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = async () => "";
exports.videoRequest = async () => "";
exports.ttsRequest = async () => "";
exports.checkForUpdates = async () => ({ hasUpdate: false, latestVersion: vendor.version, notice: "" });
exports.updateVendor = async () => "";

export {};
