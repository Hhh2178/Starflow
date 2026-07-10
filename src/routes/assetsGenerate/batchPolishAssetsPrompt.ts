import { createBatchPolishAssetsPromptRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueAssetPromptJobs } from "@/services/productionTextWorkflows";

export { createBatchPolishAssetsPromptRouter } from "@/lib/productionTextQueueRoutes";

export default createBatchPolishAssetsPromptRouter(enqueueAssetPromptJobs);
