// True when MongoDB refused a write because a unique index already holds that value.
export function isDuplicateKeyError(err: unknown) {
  const error = err as { code?: number; writeErrors?: Array<{ code?: number }> };
  return error.code === 11000 || (Array.isArray(error.writeErrors) && error.writeErrors.length > 0 && error.writeErrors.every((item) => item.code === 11000));
}
