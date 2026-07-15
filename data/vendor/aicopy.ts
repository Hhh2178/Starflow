type VideoMode = "singleImage" | "text";

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  audio: false;
  durationResolutionMap: Array<{ duration: number[]; resolution: string[] }>;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: Array<{ type: "image" | "audio" | "video"; sourceType: "base64"; base64: string }>;
  mode: VideoMode;
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
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
  }>;
  inputValues: Record<string, string>;
  models: VideoModel[];
}

declare const fetch: typeof globalThis.fetch;
declare const logger: (message: unknown) => void;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const exports: Record<string, any>;

const vendor: VendorConfig = {
  id: "aicopy",
  version: "1.0",
  name: "AICopy",
  author: "Stars Flow",
  description: "Grok 视频生成服务",
  inputs: [
    { key: "apiKey", label: "API 密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.aicopy.top" },
  models: [
    {
      name: "Grok 1.5 视频预览",
      modelName: "grok-imagine-video-1.5-preview",
      type: "video",
      mode: ["singleImage"],
      audio: false,
      durationResolutionMap: [{ duration: [6, 10, 15], resolution: ["720p"] }],
    },
  ],
};

const headers = () => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API 密钥");
  return {
    Authorization: `Bearer ${vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "")}`,
    "Content-Type": "application/json",
  };
};

const baseUrl = () => vendor.inputValues.baseUrl.replace(/\/+$/, "");

const videoSize = (aspectRatio: string) => {
  if (aspectRatio === "9:16") return "720x1280";
  return "1280x720";
};

const responseTaskId = (value: any): string =>
  String(value?.task_id ?? value?.data?.task_id ?? value?.id ?? value?.data?.id ?? "").trim();

const responseStatus = (value: any): string =>
  String(value?.status ?? value?.data?.status ?? value?.task_status ?? "").trim().toLowerCase();

const responseVideoUrl = (value: any): string => {
  const output =
    value?.video_url ??
    value?.result_url ??
    value?.url ??
    value?.data?.video_url ??
    value?.data?.result_url ??
    value?.data?.url ??
    value?.data?.output ??
    value?.output ??
    value?.data?.video?.url ??
    value?.video?.url;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output[0];
    return typeof first === "string" ? first : String(first?.url ?? first?.video_url ?? "");
  }
  return String(output?.url ?? output?.video_url ?? "");
};

const responseError = (value: any): string =>
  String(value?.error?.message ?? value?.error ?? value?.message ?? value?.msg ?? value?.failure_reason ?? "").trim();

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const imageReferences = (config.referenceList ?? [])
    .filter((reference) => reference.type === "image" && reference.base64)
    .map((reference) => reference.base64);
  if (imageReferences.length === 0) throw new Error("Grok 1.5 视频预览必须提供一张参考图");
  const images = imageReferences.length === 1 ? [imageReferences[0], imageReferences[0]] : imageReferences;
  const body: Record<string, unknown> = {
    model: model.modelName,
    prompt: config.prompt,
    size: videoSize(config.aspectRatio),
    seconds: String(config.duration),
  };
  if (images.length > 0) body.images = images;

  const submit = await fetch(`${baseUrl()}/v1/videos`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`视频任务提交失败：${submitText}`);
  const submitData = JSON.parse(submitText);
  const taskId = responseTaskId(submitData);
  if (!taskId) throw new Error("视频任务提交失败：未返回任务 ID");
  logger(`AICopy 视频任务已提交：${taskId}`);

  const result = await pollTask(
    async () => {
      const response = await fetch(`${baseUrl()}/v1/videos/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: headers(),
      });
      const text = await response.text();
      if (response.status >= 500) return { completed: false };
      if (!response.ok) throw new Error(`视频任务查询失败：${text}`);
      const data = JSON.parse(text);
      const status = responseStatus(data);
      const videoUrl = responseVideoUrl(data);
      if (videoUrl && (!status || ["completed", "succeeded", "success"].includes(status))) {
        return { completed: true, data: videoUrl };
      }
      if (["failed", "failure", "cancelled", "canceled", "expired"].includes(status)) {
        return { completed: true, error: responseError(data) || `视频任务失败：${status}` };
      }
      return { completed: false };
    },
    3000,
    600000,
  );

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("视频任务完成但未返回视频地址");
  return result.data;
};

exports.vendor = vendor;
exports.textRequest = () => undefined;
exports.imageRequest = async () => "";
exports.videoRequest = videoRequest;
exports.ttsRequest = async () => "";
exports.checkForUpdates = async () => ({ hasUpdate: false, latestVersion: vendor.version, notice: "" });
exports.updateVendor = async () => "";

export {};
