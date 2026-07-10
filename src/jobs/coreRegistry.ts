import { createGenerationJobRegistry } from "@/jobs/registry";
import { createTextGenerationHandler } from "@/jobs/handlers/textGeneration";
import { executeCoreTextGeneration } from "@/jobs/handlers/coreTextExecutor";

export const coreGenerationRegistry = createGenerationJobRegistry([
  createTextGenerationHandler(executeCoreTextGeneration),
]);
