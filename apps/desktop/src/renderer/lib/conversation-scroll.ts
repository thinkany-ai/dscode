export interface ConversationScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const CONVERSATION_TAIL_THRESHOLD = 24;

export function updateConversationTailFollowing(
  following: boolean,
  previousScrollTop: number,
  metrics: ConversationScrollMetrics,
): boolean {
  if (metrics.scrollTop < previousScrollTop - 1) return false;
  const distanceFromBottom = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  if (distanceFromBottom <= CONVERSATION_TAIL_THRESHOLD) return true;
  return following;
}
