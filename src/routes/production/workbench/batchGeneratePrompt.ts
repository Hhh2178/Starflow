import {
  createVideoPromptQueueHandler,
  createVideoPromptQueueRouter,
  type EnqueueVideoPrompts,
} from "@/lib/videoPromptQueueRoute";

export function createBatchGeneratePromptHandler(enqueue?: EnqueueVideoPrompts) {
  return createVideoPromptQueueHandler("batch", enqueue);
}

export function createBatchGeneratePromptRouter(enqueue?: EnqueueVideoPrompts) {
  return createVideoPromptQueueRouter("batch", enqueue);
}

export default createBatchGeneratePromptRouter();
