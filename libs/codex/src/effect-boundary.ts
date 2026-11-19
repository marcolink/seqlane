import { Effect } from "effect";

/** Native SDK Promise edge; Effect supplies its interruption signal. */
export const codexEffect = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
) => Effect.tryPromise({ try: operation, catch: (cause) => cause });
