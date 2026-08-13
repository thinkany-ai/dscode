import { describe, expect, it } from "vitest";
import { updateConversationTailFollowing } from "./conversation-scroll";

describe("conversation tail following", () => {
  it("stops following as soon as the user scrolls upward", () => {
    expect(updateConversationTailFollowing(true, 900, {
      scrollTop: 760,
      scrollHeight: 1_400,
      clientHeight: 500,
    })).toBe(false);
  });

  it("does not resume while the user scrolls down above the bottom", () => {
    expect(updateConversationTailFollowing(false, 500, {
      scrollTop: 700,
      scrollHeight: 1_400,
      clientHeight: 500,
    })).toBe(false);
  });

  it("resumes once the user reaches the bottom", () => {
    expect(updateConversationTailFollowing(false, 700, {
      scrollTop: 882,
      scrollHeight: 1_400,
      clientHeight: 500,
    })).toBe(true);
  });
});
