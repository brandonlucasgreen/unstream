/**
 * The response a handler gave, for a test that is about to read it.
 *
 * A function's handler is typed as possibly answering nothing: some have a path that falls off
 * the end, and Netlify's own `Handler` type allows it. Wrap the call in this instead of writing
 * `res!.statusCode` at every read, and a handler that really did return nothing fails the test
 * with that sentence rather than a TypeError on `statusCode`.
 */
export async function answered<T>(pending: Promise<T | undefined>): Promise<T> {
  const response = await pending;
  if (response === undefined) throw new Error('The handler returned no response');
  return response;
}
