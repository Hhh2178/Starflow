import { createExtractAssetsRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueScriptAssetJobs } from "@/services/productionTextWorkflows";

export { createExtractAssetsRouter } from "@/lib/productionTextQueueRoutes";

export default createExtractAssetsRouter(enqueueScriptAssetJobs);
