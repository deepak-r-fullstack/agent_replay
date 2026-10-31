import { useEffect, useState } from "react";

// Returns `value` only after it has stopped changing for `delayMs`, so typing in a search box
// does not ask the server for results on every key press.
export function useDebouncedValue<T>(value: T, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
