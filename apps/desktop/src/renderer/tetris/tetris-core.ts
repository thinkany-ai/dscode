// Pure Tetris game logic — no rendering, no side effects.
// Board coordinates: x = column (0..COLS-1), y = row (0..ROWS-1, 0 is the top).

export const COLS = 10;
export const ROWS = 20;

export type TypeId = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
export type Cell = TypeId | null;
export type Board = Cell[][];

export interface Piece {
  type: TypeId;
  matrix: number[][];
  x: number;
  y: number;
}

export interface Game {
  board: Board;
  /** Current falling piece, or null once the game is over. */
  active: Piece | null;
  /** Upcoming pieces, drawn from a 7-bag randomizer. */
  queue: TypeId[];
  hold: TypeId | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  over: boolean;
  paused: boolean;
}

export const COLORS: Record<TypeId, string> = {
  I: "#22d3ee",
  O: "#facc15",
  T: "#c084fc",
  S: "#4ade80",
  Z: "#f87171",
  J: "#60a5fa",
  L: "#fb923c",
};

const SHAPES: Record<TypeId, number[][]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
};

export const ALL_TYPES: TypeId[] = ["I", "O", "T", "S", "Z", "J", "L"];

export function getMatrix(type: TypeId): number[][] {
  return SHAPES[type];
}

export function createEmptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));
}

function shuffle<T>(items: T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Appends another random 7-bag to the queue so previews never run dry. */
export function refillQueue(queue: TypeId[]): TypeId[] {
  return [...queue, ...shuffle(ALL_TYPES)];
}

export function spawnPiece(type: TypeId, board: Board): Piece {
  const matrix = getMatrix(type);
  return {
    type,
    matrix,
    x: Math.floor((COLS - matrix[0].length) / 2),
    y: 0,
  };
}

export function collides(board: Board, piece: Piece): boolean {
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r].length; c++) {
      if (!piece.matrix[r][c]) continue;
      const x = piece.x + c;
      const y = piece.y + r;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && board[y][x]) return true;
    }
  }
  return false;
}

export function merge(board: Board, piece: Piece): Board {
  const next = board.map((row) => row.slice());
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r].length; c++) {
      if (!piece.matrix[r][c]) continue;
      const x = piece.x + c;
      const y = piece.y + r;
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) next[y][x] = piece.type;
    }
  }
  return next;
}

export function clearLines(board: Board): { board: Board; cleared: number } {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = ROWS - remaining.length;
  const empty = Array.from({ length: cleared }, () => Array<Cell>(COLS).fill(null));
  return { board: [...empty, ...remaining], cleared };
}

export function rotateMatrixCW(matrix: number[][]): number[][] {
  const n = matrix.length;
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => matrix[n - 1 - c][r]),
  );
}

// Simplified SRS-style wall kicks: try a few offsets before giving up.
const KICKS: Array<[number, number]> = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [-2, 0],
  [2, 0],
  [-1, -1],
  [1, -1],
];

export function rotated(board: Board, piece: Piece, dir: 1 | -1): Piece {
  let matrix = piece.matrix;
  if (dir === 1) {
    matrix = rotateMatrixCW(matrix);
  } else {
    matrix = rotateMatrixCW(rotateMatrixCW(rotateMatrixCW(matrix)));
  }
  for (const [dx, dy] of KICKS) {
    const candidate: Piece = { ...piece, matrix, x: piece.x + dx, y: piece.y + dy };
    if (!collides(board, candidate)) return candidate;
  }
  return piece;
}

export function moved(board: Board, piece: Piece, dx: number, dy: number): Piece {
  const candidate = { ...piece, x: piece.x + dx, y: piece.y + dy };
  return collides(board, candidate) ? piece : candidate;
}

export function ghostY(board: Board, piece: Piece): number {
  let y = piece.y;
  while (!collides(board, { ...piece, y: y + 1 })) y++;
  return y;
}

export function getDropInterval(level: number): number {
  return Math.max(70, Math.round(820 * Math.pow(0.82, level - 1)));
}

export const LINE_SCORES = [0, 100, 300, 500, 800];

export function createGame(): Game {
  let game: Game = {
    board: createEmptyBoard(),
    active: null,
    queue: refillQueue([]),
    hold: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    over: false,
    paused: false,
  };
  game = ensureQueue(game);
  return spawnActive(game);
}

function ensureQueue(game: Game): Game {
  if (game.queue.length < 5) return { ...game, queue: refillQueue(game.queue) };
  return game;
}

function spawnActive(game: Game): Game {
  const type = game.queue[0];
  const queue = game.queue.slice(1);
  const piece = spawnPiece(type, game.board);
  if (collides(game.board, piece)) {
    return { ...game, queue, active: piece, over: true };
  }
  return { ...game, queue, active: piece, canHold: true };
}

function lockPiece(game: Game): Game {
  if (!game.active) return game;
  const merged = merge(game.board, game.active);
  const { board, cleared } = clearLines(merged);
  const gained = LINE_SCORES[cleared] * game.level;
  const lines = game.lines + cleared;
  const level = Math.floor(lines / 10) + 1;
  return spawnActive({
    ...game,
    board,
    score: game.score + gained,
    lines,
    level,
  });
}

/** Gravity: move down one row, or lock when grounded. */
export function step(game: Game): Game {
  if (game.paused || game.over || !game.active) return game;
  const piece = moved(game.board, game.active, 0, 1);
  return piece !== game.active ? { ...game, active: piece } : lockPiece(game);
}

export function actionMove(game: Game, dx: number): Game {
  if (game.paused || game.over || !game.active) return game;
  return { ...game, active: moved(game.board, game.active, dx, 0) };
}

export function actionRotate(game: Game, dir: 1 | -1): Game {
  if (game.paused || game.over || !game.active) return game;
  return { ...game, active: rotated(game.board, game.active, dir) };
}

export function actionSoftDrop(game: Game): Game {
  if (game.paused || game.over || !game.active) return game;
  const piece = moved(game.board, game.active, 0, 1);
  if (piece !== game.active) return { ...game, active: piece, score: game.score + 1 };
  return lockPiece(game);
}

export function actionHardDrop(game: Game): Game {
  if (game.paused || game.over || !game.active) return game;
  const target = ghostY(game.board, game.active);
  const dist = target - game.active.y;
  const piece = { ...game.active, y: target };
  return lockPiece({ ...game, active: piece, score: game.score + dist * 2 });
}

export function actionHold(game: Game): Game {
  if (game.paused || game.over || !game.active || !game.canHold) return game;
  const current = game.active;
  const hold = game.hold;
  let queue = game.queue;
  let nextType: TypeId;
  if (hold) {
    nextType = hold;
  } else {
    nextType = queue[0];
    queue = queue.slice(1);
  }
  const spawned = spawnPiece(nextType, game.board);
  const next: Game = {
    ...game,
    queue,
    hold: current.type,
    active: spawned,
    canHold: false,
  };
  return collides(game.board, spawned) ? { ...next, over: true } : next;
}

export function actionTogglePause(game: Game): Game {
  if (game.over) return game;
  return { ...game, paused: !game.paused };
}
