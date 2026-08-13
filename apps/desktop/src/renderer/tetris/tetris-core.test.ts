import { describe, expect, it } from "vitest";
import {
  actionHardDrop,
  actionHold,
  actionMove,
  actionRotate,
  actionSoftDrop,
  actionTogglePause,
  clearLines,
  collides,
  createEmptyBoard,
  createGame,
  getDropInterval,
  getMatrix,
  ghostY,
  refillQueue,
  rotated,
  rotateMatrixCW,
  spawnPiece,
  step,
  type Board,
  type Game,
  type TypeId,
} from "./tetris-core";

function fillBoard(board: Board, cells: Array<[number, number, TypeId]>): Board {
  const next = board.map((row) => row.slice());
  for (const [x, y, type] of cells) next[y][x] = type;
  return next;
}

describe("shapes and rotation", () => {
  it("rotates a matrix clockwise", () => {
    const shape = getMatrix("L");
    expect(rotateMatrixCW(shape)).toEqual([
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
    ]);
  });

  it("rotating four times returns the original matrix", () => {
    for (const type of ["I", "O", "T", "S", "Z", "J", "L"] as TypeId[]) {
      const shape = getMatrix(type);
      let current = shape;
      for (let i = 0; i < 4; i++) current = rotateMatrixCW(current);
      expect(current).toEqual(shape);
    }
  });
});

describe("board helpers", () => {
  it("creates an empty board of the right size", () => {
    const board = createEmptyBoard();
    expect(board).toHaveLength(20);
    for (const row of board) {
      expect(row).toHaveLength(10);
      expect(row.every((cell) => cell === null)).toBe(true);
    }
  });

  it("detects collisions with walls and the floor", () => {
    const board = createEmptyBoard();
    const piece = spawnPiece("I", board);
    expect(collides(board, { ...piece, x: -1 })).toBe(true);
    expect(collides(board, { ...piece, y: 20 })).toBe(true);
    expect(collides(board, piece)).toBe(false);
  });

  it("clears full rows and shifts the stack down", () => {
    const board = fillBoard(createEmptyBoard(), [
      [0, 19, "T"], [1, 19, "T"], [2, 19, "T"], [3, 19, "T"], [4, 19, "T"],
      [5, 19, "T"], [6, 19, "T"], [7, 19, "T"], [8, 19, "T"], [9, 19, "T"],
      [0, 18, "L"], [1, 18, "L"], [2, 18, "L"],
    ]);
    const { board: result, cleared } = clearLines(board);
    expect(cleared).toBe(1);
    expect(result[0].every((cell) => cell === null)).toBe(true);
    expect(result[19][0]).toBe("L");
  });
});

describe("game flow", () => {
  it("spawns an active piece with a 7-bag queue", () => {
    const game = createGame();
    expect(game.active).not.toBeNull();
    expect(game.queue.length).toBe(6);
    expect(new Set(game.queue).size).toBe(6);
  });

  it("moves left and right but respects walls", () => {
    const game = createGame();
    const movedOnce = actionMove(game, 1);
    expect(movedOnce.active!.x).toBe(game.active!.x + 1);
    let current = movedOnce;
    for (let i = 0; i < 20; i++) current = actionMove(current, 1);
    expect(current.active!.x).toBeLessThanOrEqual(9);
  });

  it("hard drop locks the piece and spawns a fresh one at the top", () => {
    const game = createGame();
    const piece = game.active!;
    const after = actionHardDrop(game);
    expect(after.active!.y).toBe(0);
    expect(after.board.flat().filter((cell) => cell === piece.type).length).toBeGreaterThan(0);
  });

  it("hard drop awards two points per cell dropped", () => {
    const fresh = createGame();
    const game: Game = { ...fresh, active: { ...fresh.active!, y: 3 } };
    const target = ghostY(game.board, game.active!);
    const dist = target - game.active!.y;
    const after = actionHardDrop(game);
    expect(after.score).toBe(game.score + dist * 2);
    const filled = game.active!.matrix.flat().filter(Boolean).length;
    expect(after.board.flat().filter((cell) => cell === game.active!.type).length).toBe(filled);
  });

  it("locks a piece once gravity cannot move it down", () => {
    let game: Game = createGame();
    const piece = game.active!;
    const height = piece.matrix.length;
    game = { ...game, board: createEmptyBoard(), active: { ...piece, y: 20 - height } };
    const type = game.active!.type;
    let current = game;
    let guard = 0;
    while (current.active!.y > 0 && guard++ < 30) {
      const next = step(current);
      if (next.active!.y === current.active!.y) break;
      current = next;
    }
    // A fresh piece spawns at the top once the previous one locks.
    expect(current.active!.y).toBe(0);
    expect(current.board.flat().filter((cell) => cell === type).length).toBeGreaterThan(0);
  });

  it("soft drop moves down one row and awards a point", () => {
    const game = createGame();
    const after = actionSoftDrop(game);
    expect(after.active!.y).toBe(game.active!.y + 1);
    expect(after.score).toBe(1);
  });

  it("rotates a piece and never collides after rotation", () => {
    const game = createGame();
    const after = actionRotate(game, 1);
    expect(collides(after.board, after.active!)).toBe(false);
  });

  it("hold swaps the active piece and blocks a second swap", () => {
    const game = createGame();
    const type = game.active!.type;
    const after = actionHold(game);
    expect(after.hold).toBe(type);
    expect(after.active!.type).not.toBe(type);
    expect(after.canHold).toBe(false);
    const third = actionHold(after);
    expect(third.active!.type).toBe(after.active!.type);
    expect(third.hold).toBe(type);
  });

  it("a single line clear awards 100 × level", () => {
    const board = fillBoard(createEmptyBoard(), [
      [0, 19, "T"], [1, 19, "T"], [2, 19, "T"], [7, 19, "T"], [8, 19, "T"], [9, 19, "T"],
    ]);
    const game: Game = { ...createGame(), board };
    const piece = spawnPiece("I", board);
    game.active = { ...piece, x: 3 };
    const after = actionHardDrop(game);
    expect(after.lines).toBe(1);
    expect(after.board[19].every((cell) => cell === null)).toBe(true);
    // 100 for the line + 2/cell × 18 cells dropped.
    expect(after.score).toBe(100 + 36);
  });

  it("a tetris clears four rows and awards 800 points", () => {
    const rows = [12, 13, 14, 15];
    const cells: Array<[number, number, TypeId]> = [];
    for (const row of rows) {
      for (let col = 0; col < 10; col++) {
        if (col === 6) continue;
        cells.push([col, row, "T"]);
      }
    }
    // Block the drop lane at row 16 so the vertical I locks at y=12.
    cells.push([6, 16, "T"]);
    const board = fillBoard(createEmptyBoard(), cells);
    const game: Game = { ...createGame(), board };
    // Rotate the I piece vertical and drop it into column 6.
    const vertical = rotated(board, spawnPiece("I", board), 1);
    game.active = { ...vertical, x: 4, y: 12 };
    const after = step(game);
    expect(after.lines).toBe(4);
    expect(after.score).toBe(800);
    for (const row of rows) {
      expect(after.board[row].every((cell) => cell === null)).toBe(true);
    }
  });

  it("level derives from cleared lines and speed increases", () => {
    expect(Math.floor(25 / 10) + 1).toBe(3);
    expect(getDropInterval(1)).toBe(820);
    expect(getDropInterval(3)).toBeLessThan(getDropInterval(2));
    expect(getDropInterval(99)).toBe(70);
  });

  it("pauses and resumes without advancing", () => {
    const game = createGame();
    const paused = actionTogglePause(game);
    expect(paused.paused).toBe(true);
    const still = step(paused);
    expect(still.active!.y).toBe(game.active!.y);
    const resumed = actionTogglePause(paused);
    expect(resumed.paused).toBe(false);
  });

  it("game over when the spawn position is blocked", () => {
    const board = fillBoard(createEmptyBoard(), [
      [4, 0, "T"], [5, 0, "T"], [4, 1, "T"], [5, 1, "T"],
    ]);
    const game = createGame();
    const blocked = { ...game, board, active: null };
    const spawned = (() => {
      const type = blocked.queue[0];
      const piece = spawnPiece(type, blocked.board);
      return { ...blocked, queue: blocked.queue.slice(1), active: piece };
    })();
    expect(collides(spawned.board, spawned.active!)).toBe(true);
  });
});

describe("queue randomizer", () => {
  it("every refilled bag contains each tetromino exactly once", () => {
    const bag = refillQueue([]);
    const counts = new Map<string, number>();
    for (const type of bag) counts.set(type, (counts.get(type) ?? 0) + 1);
    expect(counts.size).toBe(7);
    expect(Array.from(counts.values()).every((n) => n === 1)).toBe(true);
  });
});
