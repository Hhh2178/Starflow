import type { GenerationJobHandler } from "@/types/generationQueue";

export interface GenerationJobRegistry {
  get(key: string): GenerationJobHandler | undefined;
  keys(): string[];
}

export function createGenerationJobRegistry(handlers: GenerationJobHandler[]): GenerationJobRegistry {
  const byKey = new Map<string, GenerationJobHandler>();
  for (const handler of handlers) {
    if (byKey.has(handler.key)) throw new Error(`重复的生成任务处理器: ${handler.key}`);
    byKey.set(handler.key, handler);
  }
  return {
    get: (key) => byKey.get(key),
    keys: () => [...byKey.keys()],
  };
}

export const generationJobRegistry = createGenerationJobRegistry([]);
