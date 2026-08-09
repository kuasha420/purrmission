import { randomUUID } from 'node:crypto';

export interface PawthyCorrelationContext {
  commandId: string;
}

export function createPawthyCorrelationContext(): PawthyCorrelationContext {
  return { commandId: randomUUID() };
}

/** Give each HTTP attempt a unique ID and bind it to the stable command causation ID. */
export function pawthyRequestHeaders(
  context: PawthyCorrelationContext,
  headers: Record<string, string> = {}
): Record<string, string> {
  return {
    ...headers,
    'x-correlation-id': randomUUID(),
    'x-causation-id': context.commandId,
  };
}
