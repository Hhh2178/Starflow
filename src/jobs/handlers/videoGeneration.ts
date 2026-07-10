import { z } from "zod";
import type {
  GenerationExecutionContext,
  GenerationExecutionResult,
  GenerationJobHandler,
} from "@/types/generationQueue";

export const videoGenerationPayloadSchema = z.object({
  operation: z.enum(["track", "batch_track"]),
  projectId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  model: z.string().min(1),
  prompt: z.string(),
  referenceResourceIds: z.array(z.number().int().positive()).default([]),
  referenceResources: z.array(z.object({
    kind: z.enum(["asset", "storyboard"]),
    id: z.number().int().positive(),
  }).strict()).default([]),
  duration: z.number().positive(),
  resolution: z.string().min(1),
  aspectRatio: z.enum(["16:9", "9:16"]),
  audio: z.boolean().default(false),
  mode: z.union([z.string(), z.array(z.string())]).default("text"),
}).strict();

export type VideoGenerationPayload = z.infer<typeof videoGenerationPayloadSchema>;

export function createVideoGenerationHandler<TResult>(
  executor: (
    payload: VideoGenerationPayload,
    context: GenerationExecutionContext,
  ) => Promise<GenerationExecutionResult<TResult>>,
): GenerationJobHandler<VideoGenerationPayload, TResult> {
  return {
    key: "core.video",
    taskType: "video",
    canRetryAfterProviderSubmission: false,
    parsePayload: (value) => videoGenerationPayloadSchema.parse(value),
    execute: (context, payload) => executor(payload, context),
  };
}
