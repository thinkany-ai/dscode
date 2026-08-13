export function isAgentSessionClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bAgent session closed\b/i.test(message);
}
