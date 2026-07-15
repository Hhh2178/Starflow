import type { GenerationExecutionContext } from "@/types/generationQueue";

export async function runWithVideoSubmissionMarker<T>(
  context: Pick<GenerationExecutionContext, "jobId" | "setProviderRequestId">,
  submitAndPoll: () => Promise<T>,
): Promise<T> {
  await context.setProviderRequestId(`video:${context.jobId}`);
  return submitAndPoll();
}
