import { createGetAiRegexRouter } from "@/lib/productionTextQueueRoutes";
import { enqueueAiRegexJobs } from "@/services/productionTextWorkflows";

export { createGetAiRegexRouter } from "@/lib/productionTextQueueRoutes";

export default createGetAiRegexRouter(enqueueAiRegexJobs);
