import { z } from "zod";
import type {
  GenerationExecutionContext,
  GenerationExecutionResult,
  GenerationJobHandler,
} from "@/types/generationQueue";

const commonTextPayloadShape = {
  projectId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  model: z.string().min(1),
  prompt: z.string(),
};

const novelEventsPayloadSchema = z.object({
  operation: z.literal("novel_events"),
  ...commonTextPayloadShape,
}).strict();

const videoPromptPayloadSchema = z.object({
  operation: z.literal("video_prompt"),
  projectId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  model: z.literal("universalAi"),
  prompt: z.literal(""),
  videoModel: z.string().min(1),
  mode: z.string().min(1),
  references: z.array(z.object({
    kind: z.enum(["asset", "storyboard"]),
    id: z.number().int().positive(),
  }).strict()),
}).strict();

const scriptAgentPayloadSchema = z.object({
  operation: z.literal("script_agent"),
  ...commonTextPayloadShape,
}).strict();

const productionAgentPayloadSchema = z.object({
  operation: z.literal("production_agent"),
  ...commonTextPayloadShape,
}).strict();

export const textGenerationPayloadSchema = z.discriminatedUnion("operation", [
  novelEventsPayloadSchema,
  videoPromptPayloadSchema,
  scriptAgentPayloadSchema,
  productionAgentPayloadSchema,
]);

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
