import { createGenerationJobRegistry } from "@/jobs/registry";
import { createTextGenerationHandler, type TextGenerationPayload } from "@/jobs/handlers/textGeneration";
import { executeCoreTextGeneration } from "@/jobs/handlers/coreTextExecutor";
import { createImageGenerationHandler, type ImageGenerationPayload } from "@/jobs/handlers/imageGeneration";
import { executeCoreImageGeneration } from "@/jobs/handlers/coreImageExecutor";
import { createVideoGenerationHandler, type VideoGenerationPayload } from "@/jobs/handlers/videoGeneration";
import { executeCoreVideoGeneration } from "@/jobs/handlers/coreVideoExecutor";
import type { GenerationExecutionContext, GenerationExecutionResult } from "@/types/generationQueue";
import { createAcceptanceGenerationRegistry, type AcceptanceGenerationOptions } from "@/jobs/acceptanceRegistry";

type CoreExecutor<TPayload> = (
  payload: TPayload,
  context: GenerationExecutionContext,
) => Promise<GenerationExecutionResult<unknown>>;

export interface CoreGenerationExecutors {
  text: CoreExecutor<TextGenerationPayload>;
  image: CoreExecutor<ImageGenerationPayload>;
  video: CoreExecutor<VideoGenerationPayload>;
}

export function createCoreGenerationRegistry(overrides: Partial<CoreGenerationExecutors> = {}) {
  return createGenerationJobRegistry([
    createTextGenerationHandler(overrides.text ?? executeCoreTextGeneration),
    createImageGenerationHandler(overrides.image ?? executeCoreImageGeneration),
    createVideoGenerationHandler(overrides.video ?? executeCoreVideoGeneration),
  ]);
}

export const coreGenerationRegistry = createCoreGenerationRegistry();

export function selectGenerationRegistry(
  options: AcceptanceGenerationOptions & { acceptanceMode: boolean },
) {
  return options.acceptanceMode ? createAcceptanceGenerationRegistry(options) : coreGenerationRegistry;
}
