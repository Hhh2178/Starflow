import { z } from "zod";
import type {
  GenerationExecutionContext,
  GenerationExecutionResult,
  GenerationJobHandler,
} from "@/types/generationQueue";

export const textGenerationPayloadSchema = z.object({
  operation: z.enum(["novel_events", "video_prompt", "script_agent", "production_agent"]),
  projectId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  model: z.string().min(1),
  prompt: z.string(),
}).strict();

export type TextGenerationPayload = z.infer<typeof textGenerationPayloadSchema>;

export function createTextGenerationHandler<TResult>(
  executor: (
    payload: TextGenerationPayload,
    context: GenerationExecutionContext,
  ) => Promise<GenerationExecutionResult<TResult>>,
): GenerationJobHandler<TextGenerationPayload, TResult> {
  return {
    key: "core.text",
    taskType: "text",
    canRetryAfterProviderSubmission: false,
    parsePayload: (value) => textGenerationPayloadSchema.parse(value),
    execute: (context, payload) => executor(payload, context),
  };
}
