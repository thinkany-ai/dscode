import { describe, expect, it } from "vitest";
import { chooseModelSubmenuSide } from "./model-menu";

describe("model menu placement", () => {
  it("opens left when the picker is close to the right edge", () => {
    expect(chooseModelSubmenuSide(
      { left: 760, right: 938 },
      { left: 0, right: 960 },
    )).toBe("left");
  });

  it("opens right when the picker is close to the left edge", () => {
    expect(chooseModelSubmenuSide(
      { left: 22, right: 200 },
      { left: 0, right: 960 },
    )).toBe("right");
  });

  it("uses the roomier side when neither side fully fits", () => {
    expect(chooseModelSubmenuSide(
      { left: 150, right: 328 },
      { left: 0, right: 420 },
    )).toBe("left");
  });
});
