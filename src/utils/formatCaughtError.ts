const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key/i;
const MAX_STRING_LENGTH = 1_000;

const sanitizeErrorValue = (value: unknown, seen: WeakSet<object>, depth = 0): unknown => {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= 3) {
    return '[truncated]';
  }
  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeErrorValue(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['config', 'request'].includes(key))
      .slice(0, 20)
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeErrorValue(item, seen, depth + 1)]),
  );
};

export const formatCaughtError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(sanitizeErrorValue(error, new WeakSet()));
  } catch {
    return String(error);
  }
};
