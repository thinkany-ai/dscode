import { AUTH_PROMPT_CANCEL_VALUE } from "../../shared/types";

export function isAgentSessionClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bAgent session closed\b/i.test(message);
}

export function isAuthPromptCancelledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(AUTH_PROMPT_CANCEL_VALUE) || /\bLogin prompt cancelled\b/i.test(message);
}
