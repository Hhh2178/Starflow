import {
  createVideoPromptQueueHandler,
  createVideoPromptQueueRouter,
  type EnqueueVideoPrompts,
} from "@/lib/videoPromptQueueRoute";

export function createGenerateVideoPromptHandler(enqueue?: EnqueueVideoPrompts) {
  return createVideoPromptQueueHandler("single", enqueue);
}

export function createGenerateVideoPromptRouter(enqueue?: EnqueueVideoPrompts) {
  return createVideoPromptQueueRouter("single", enqueue);
}

export default createGenerateVideoPromptRouter();
