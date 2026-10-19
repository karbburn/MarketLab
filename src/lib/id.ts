let counter = 0;

/** Generates a collision-resistant id with a readable prefix. */
export function createId(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}
