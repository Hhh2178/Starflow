import { z } from "zod";
import type {
  GenerationExecutionContext,
  GenerationExecutionResult,
  GenerationJobHandler,
} from "@/types/generationQueue";

export const imageGenerationPayloadSchema = z.object({
  operation: z.enum(["asset", "storyboard", "edit"]),
  projectId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  model: z.string().min(1),
  prompt: z.string(),
  referenceResourceIds: z.array(z.number().int().positive()).default([]),
  size: z.enum(["1K", "2K", "4K"]),
  aspectRatio: z.string().min(1),
}).strict();

export type ImageGenerationPayload = z.infer<typeof imageGenerationPayloadSchema>;

export function createImageGenerationHandler<TResult>(
  executor: (
    payload: ImageGenerationPayload,
    context: GenerationExecutionContext,
  ) => Promise<GenerationExecutionResult<TResult>>,
): GenerationJobHandler<ImageGenerationPayload, TResult> {
  return {
    key: "core.image",
    taskType: "image",
    canRetryAfterProviderSubmission: false,
    parsePayload: (value) => imageGenerationPayloadSchema.parse(value),
    execute: (context, payload) => executor(payload, context),
  };
}
