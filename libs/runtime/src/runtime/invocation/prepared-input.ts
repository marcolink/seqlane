import type { SeqlaneSchema } from "@seqlane/core";

/** Private proof that the owning input schema has already parsed this value. */
export class PreparedInvocationInput {
  readonly #value: unknown;

  private constructor(value: unknown) {
    this.#value = value;
  }

  get value(): unknown {
    return this.#value;
  }

  static parse(
    schema: SeqlaneSchema | undefined,
    input: unknown,
  ): PreparedInvocationInput {
    return new PreparedInvocationInput(
      schema === undefined ? input : schema.parse(input),
    );
  }
}
