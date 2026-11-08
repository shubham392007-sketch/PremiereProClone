let counter = 0;

export function createId(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  counter = (counter + 1) % 1000;
  return `${prefix}_${rand}`;
}
