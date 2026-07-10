import { createExtractStylePromptRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueStylePromptJobs } from "@/services/productionTextWorkflows";

export { createExtractStylePromptRouter } from "@/lib/productionTextQueueRoutes";

export default createExtractStylePromptRouter(enqueueStylePromptJobs);
