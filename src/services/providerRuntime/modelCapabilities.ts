export type ModelCapability = "text" | "image" | "video" | "audio" | "json";

export const MODEL_CAPABILITY_TAGS = [
  "text_chat", "image_understanding", "video_understanding", "audio_understanding",
  "reasoning", "reasoning_control", "long_context", "web_search", "tool_calling", "structured_output",
  "image_generation", "image_to_image", "image_edit", "inpainting", "outpainting",
  "multi_reference_image", "character_consistency", "transparent_background",
  "video_generation", "image_to_video", "multi_reference_video", "first_frame_video",
  "last_frame_video", "first_last_frame_video", "video_edit", "video_extend", "native_audio", "lip_sync",
  "tts", "voice_design", "voice_clone", "music_generation", "audio_cover", "audio_extend",
] as const;

export type ModelCapabilityTag = typeof MODEL_CAPABILITY_TAGS[number];

export const VIDEO_FRAME_MODES = [
  "text_only", "reference_images", "first_frame", "last_frame", "first_or_last_frame", "first_last_frame",
] as const;

export type VideoFrameMode = typeof VIDEO_FRAME_MODES[number];

export interface ReferenceInputCapability {
  enabled: boolean;
  min: number;
  max: number;
}

export interface ModelInputCapabilities {
  prompt: boolean;
  systemPrompt: boolean;
  imageReference: ReferenceInputCapability;
  frameModes: VideoFrameMode[];
  mask: boolean;
  videoReference: boolean;
  audioReference: boolean;
}

export interface CapabilityTemplate {
  capabilityTags: ModelCapabilityTag[];
  inputCapabilities: ModelInputCapabilities;
  parameterSchema: Record<string, Record<string, unknown>>;
}

export class ModelCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCapabilityError";
  }
}

const tagSet = new Set<string>(MODEL_CAPABILITY_TAGS);
const frameModeSet = new Set<string>(VIDEO_FRAME_MODES);

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 16) throw new ModelCapabilityError(`${label}必须是 0 到 16 的整数`);
  return number;
}

export function normalizeCapabilityTags(value: unknown): ModelCapabilityTag[] {
  if (!Array.isArray(value)) throw new ModelCapabilityError("能力标签必须是数组");
  if (value.length > MODEL_CAPABILITY_TAGS.length) throw new ModelCapabilityError("能力标签数量超出限制");
  const normalized: ModelCapabilityTag[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !tagSet.has(item)) throw new ModelCapabilityError(`不支持的能力标签：${String(item)}`);
    if (!normalized.includes(item as ModelCapabilityTag)) normalized.push(item as ModelCapabilityTag);
  }
  return normalized;
}

export function normalizeInputCapabilities(capability: ModelCapability, value: unknown): ModelInputCapabilities {
  const source = plainObject(value);
  const reference = plainObject(source.imageReference);
  const referenceEnabled = reference.enabled === true;
  const referenceMin = boundedInteger(reference.min, 0, "引用图最小数量");
  const referenceMax = boundedInteger(reference.max, referenceEnabled ? 1 : 0, "引用图最大数量");
  if (referenceMin > referenceMax) throw new ModelCapabilityError("引用图数量范围无效");
  if (!referenceEnabled && (referenceMin !== 0 || referenceMax !== 0)) throw new ModelCapabilityError("未启用引用图时数量范围必须为 0");

  const rawFrameModes = source.frameModes === undefined ? [] : source.frameModes;
  if (!Array.isArray(rawFrameModes)) throw new ModelCapabilityError("视频帧模式必须是数组");
  if (capability !== "video" && rawFrameModes.length > 0) throw new ModelCapabilityError("只有视频模型可以配置视频帧模式");
  const frameModes: VideoFrameMode[] = [];
  for (const item of rawFrameModes) {
    if (typeof item !== "string" || !frameModeSet.has(item)) throw new ModelCapabilityError(`不支持的视频帧模式：${String(item)}`);
    if (!frameModes.includes(item as VideoFrameMode)) frameModes.push(item as VideoFrameMode);
  }

  return {
    prompt: source.prompt !== false,
    systemPrompt: source.systemPrompt === true,
    imageReference: { enabled: referenceEnabled, min: referenceMin, max: referenceMax },
    frameModes,
    mask: source.mask === true,
    videoReference: source.videoReference === true,
    audioReference: source.audioReference === true,
  };
}

export function capabilityTemplate(capability: ModelCapability): CapabilityTemplate {
  const baseInput = normalizeInputCapabilities(capability, {});
  if (capability === "text") return {
    capabilityTags: ["text_chat"],
    inputCapabilities: baseInput,
    parameterSchema: {
      temperature: { type: "number", min: 0, max: 2, step: 0.1, default: 0.7 },
      topP: { type: "number", min: 0, max: 1, step: 0.05, default: 1 },
      maxTokens: { type: "integer", min: 1, max: 32768, default: 4096 },
    },
  };
  if (capability === "image") return {
    capabilityTags: ["image_generation"],
    inputCapabilities: baseInput,
    parameterSchema: {
      aspectRatio: { type: "select", options: ["1:1", "16:9", "9:16", "4:3", "3:4"], default: "1:1" },
      size: { type: "select", options: ["1024x1024", "1536x1024", "1024x1536"], default: "1024x1024" },
    },
  };
  if (capability === "video") return {
    capabilityTags: ["video_generation"],
    inputCapabilities: baseInput,
    parameterSchema: {
      aspectRatio: { type: "select", options: ["16:9", "9:16", "1:1"], default: "16:9" },
      duration: { type: "integer", min: 1, max: 60, step: 1, default: 6 },
      resolution: { type: "select", options: ["480p", "720p", "1080p"], default: "720p" },
    },
  };
  if (capability === "audio") return {
    capabilityTags: ["tts"],
    inputCapabilities: baseInput,
    parameterSchema: {
      audioFormat: { type: "select", options: ["wav", "mp3", "pcm16"], default: "wav" },
    },
  };
  return { capabilityTags: [], inputCapabilities: baseInput, parameterSchema: {} };
}
