import { createGenerationJobRegistry } from "@/jobs/registry";
import { createTextGenerationHandler } from "@/jobs/handlers/textGeneration";
import { executeCoreTextGeneration } from "@/jobs/handlers/coreTextExecutor";
import { createImageGenerationHandler } from "@/jobs/handlers/imageGeneration";
import { executeCoreImageGeneration } from "@/jobs/handlers/coreImageExecutor";
import { createVideoGenerationHandler } from "@/jobs/handlers/videoGeneration";
import { executeCoreVideoGeneration } from "@/jobs/handlers/coreVideoExecutor";

export const coreGenerationRegistry = createGenerationJobRegistry([
  createTextGenerationHandler((payload) => executeCoreTextGeneration(payload)),
  createImageGenerationHandler(executeCoreImageGeneration),
  createVideoGenerationHandler(executeCoreVideoGeneration),
]);
