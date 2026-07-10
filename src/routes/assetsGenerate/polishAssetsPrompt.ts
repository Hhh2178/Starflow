import { createPolishAssetsPromptRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueAssetPromptJobs } from "@/services/productionTextWorkflows";

export { createPolishAssetsPromptRouter } from "@/lib/productionTextQueueRoutes";

export default createPolishAssetsPromptRouter(enqueueAssetPromptJobs);
