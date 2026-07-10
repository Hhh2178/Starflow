import { createBatchBindAudioRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueAssetAudioJobs } from "@/services/productionTextWorkflows";

export { createBatchBindAudioRouter } from "@/lib/productionTextQueueRoutes";

export default createBatchBindAudioRouter(enqueueAssetAudioJobs);
