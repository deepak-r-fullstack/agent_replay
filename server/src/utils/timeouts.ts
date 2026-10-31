// Gives up waiting for `promise` after `ms` and fails with the error `makeError` builds.
// The work behind the promise may carry on in the background; callers that can stop it (an AI call) are also given the limit.
export function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  // If the timeout wins, a failure that arrives later must not turn into an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
