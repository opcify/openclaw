export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}

export function normalizeSessionId(value: string): string | null {
  const trimmed = value.trim();
  return SESSION_ID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}
