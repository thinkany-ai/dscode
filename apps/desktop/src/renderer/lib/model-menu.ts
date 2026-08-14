export type ModelSubmenuSide = "left" | "right";

interface HorizontalBounds {
  left: number;
  right: number;
}

export function chooseModelSubmenuSide(
  menu: HorizontalBounds,
  boundary: HorizontalBounds,
  submenuWidth = 190,
  gap = 6,
  edgeGutter = 10,
): ModelSubmenuSide {
  const requiredSpace = submenuWidth + gap + edgeGutter;
  const leftSpace = menu.left - boundary.left;
  const rightSpace = boundary.right - menu.right;

  if (rightSpace >= requiredSpace && rightSpace > leftSpace) return "right";
  if (leftSpace >= requiredSpace) return "left";
  return rightSpace > leftSpace ? "right" : "left";
}
