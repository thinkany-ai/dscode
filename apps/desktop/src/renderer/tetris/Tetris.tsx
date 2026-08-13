import { useCallback, useEffect, useRef, useState } from "react";
import {
  COLS,
  COLORS,
  ROWS,
  actionHardDrop,
  actionHold,
  actionMove,
  actionRotate,
  actionSoftDrop,
  actionTogglePause,
  createGame,
  getDropInterval,
  getMatrix,
  ghostY,
  step,
  type Game,
  type TypeId,
} from "./tetris-core";
import "./tetris.css";

const CELL = 28;
const BOARD_W = COLS * CELL;
const BOARD_H = ROWS * CELL;
const MINI_CELL = 18;
const MINI_SIZE = 84;

interface Hud {
  score: number;
  lines: number;
  level: number;
  over: boolean;
  paused: boolean;
  hold: TypeId | null;
  next: TypeId[];
}

function snapshotHud(game: Game): Hud {
  return {
    score: game.score,
    lines: game.lines,
    level: game.level,
    over: game.over,
    paused: game.paused,
    hold: game.hold,
    next: game.queue.slice(0, 3),
  };
}

export default function Tetris({ onClose }: { onClose?: () => void }) {
  const gameRef = useRef<Game>(createGame());
  const [hud, setHud] = useState<Hud>(() => snapshotHud(gameRef.current));
  const boardCanvasRef = useRef<HTMLCanvasElement>(null);
  const holdCanvasRef = useRef<HTMLCanvasElement>(null);
  const nextCanvasRef = useRef<HTMLCanvasElement>(null);

  const syncHud = useCallback(() => {
    setHud(snapshotHud(gameRef.current));
  }, []);

  const draw = useCallback(() => {
    const game = gameRef.current;
    const boardCtx = boardCanvasRef.current?.getContext("2d");
    if (boardCtx) drawBoard(boardCtx, game);
    const holdCtx = holdCanvasRef.current?.getContext("2d");
    if (holdCtx) {
      holdCtx.clearRect(0, 0, MINI_SIZE, MINI_SIZE);
      if (game.hold) drawMiniPiece(holdCtx, MINI_SIZE / 2, MINI_SIZE / 2, MINI_CELL, getMatrix(game.hold), COLORS[game.hold]);
    }
    const nextCtx = nextCanvasRef.current?.getContext("2d");
    if (nextCtx) {
      nextCtx.clearRect(0, 0, MINI_SIZE, MINI_SIZE * 3);
      game.queue.slice(0, 3).forEach((type, index) => {
        drawMiniPiece(nextCtx, MINI_SIZE / 2, MINI_CELL * 2 + index * MINI_CELL * 4, MINI_CELL, getMatrix(type), COLORS[type]);
      });
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const game = gameRef.current;
      if (!game.paused && !game.over) {
        const interval = getDropInterval(game.level);
        if (now - last >= interval) {
          gameRef.current = step(game);
          last = now;
          syncHud();
        }
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw, syncHud]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const game = gameRef.current;
      const handled = ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " "].includes(event.key);
      if (handled) event.preventDefault();
      switch (event.key) {
        case "ArrowLeft": gameRef.current = actionMove(game, -1); break;
        case "ArrowRight": gameRef.current = actionMove(game, 1); break;
        case "ArrowDown": gameRef.current = actionSoftDrop(game); break;
        case "ArrowUp":
        case "x":
        case "X": gameRef.current = actionRotate(game, 1); break;
        case "z":
        case "Z": gameRef.current = actionRotate(game, -1); break;
        case " ": gameRef.current = actionHardDrop(game); break;
        case "c":
        case "C": gameRef.current = actionHold(game); break;
        case "p":
        case "P": gameRef.current = actionTogglePause(game); break;
        case "Escape":
          if (onClose) { onClose(); return; }
          gameRef.current = actionTogglePause(game);
          break;
        case "r":
        case "R":
          if (game.over) gameRef.current = createGame();
          break;
        case "Enter":
          if (game.over) gameRef.current = createGame();
          else if (game.paused) gameRef.current = actionTogglePause(game);
          break;
        default: return;
      }
      syncHud();
    };
    // Capture phase: game keys win over the app's global shortcuts.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, syncHud]);

  useEffect(() => {
    const onBlur = () => {
      const game = gameRef.current;
      if (!game.paused && !game.over) {
        gameRef.current = actionTogglePause(game);
        syncHud();
      }
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [syncHud]);

  const restart = () => {
    gameRef.current = createGame();
    syncHud();
  };

  return (
    <div className="tetris-screen">
      <div className="tetris-wrap">
        <aside className="tetris-panel">
          <div className="tetris-card">
            <div className="tetris-label">HOLD <kbd>C</kbd></div>
            <canvas ref={holdCanvasRef} width={MINI_SIZE} height={MINI_SIZE} className="tetris-mini" />
          </div>
          <div className="tetris-card">
            <div className="tetris-label">SCORE</div>
            <div className="tetris-value">{hud.score.toLocaleString()}</div>
          </div>
          <div className="tetris-card">
            <div className="tetris-label">LINES</div>
            <div className="tetris-value">{hud.lines}</div>
          </div>
          <div className="tetris-card">
            <div className="tetris-label">LEVEL</div>
            <div className="tetris-value">{hud.level}</div>
          </div>
        </aside>

        <div className="tetris-board-wrap">
          <canvas ref={boardCanvasRef} width={BOARD_W} height={BOARD_H} className="tetris-canvas" />
          {hud.paused && !hud.over && (
            <div className="tetris-overlay">
              <strong>PAUSED</strong>
              <span>Press P or Enter to resume</span>
              <button onClick={() => { gameRef.current = actionTogglePause(gameRef.current); syncHud(); }}>Resume</button>
            </div>
          )}
          {hud.over && (
            <div className="tetris-overlay">
              <strong>GAME OVER</strong>
              <span>Score {hud.score.toLocaleString()} · {hud.lines} lines</span>
              <button onClick={restart}>Play again</button>
            </div>
          )}
        </div>

        <aside className="tetris-panel">
          <div className="tetris-card">
            <div className="tetris-label">NEXT</div>
            <canvas ref={nextCanvasRef} width={MINI_SIZE} height={MINI_SIZE * 3} className="tetris-mini tetris-mini-next" />
          </div>
          <div className="tetris-actions">
            {onClose && <button className="tetris-action" onClick={onClose}>Close ✕</button>}
            <button className="tetris-action" onClick={() => { gameRef.current = actionTogglePause(gameRef.current); syncHud(); }}>Pause</button>
            <button className="tetris-action" onClick={restart}>Restart</button>
          </div>
        </aside>
      </div>

      <div className="tetris-controls">
        <button onClick={() => { gameRef.current = actionHold(gameRef.current); syncHud(); }}>Hold</button>
        <button onClick={() => { gameRef.current = actionMove(gameRef.current, -1); syncHud(); }}>←</button>
        <button onClick={() => { gameRef.current = actionRotate(gameRef.current, 1); syncHud(); }}>↻</button>
        <button onClick={() => { gameRef.current = actionMove(gameRef.current, 1); syncHud(); }}>→</button>
        <button onClick={() => { gameRef.current = actionSoftDrop(gameRef.current); syncHud(); }}>↓</button>
        <button onClick={() => { gameRef.current = actionHardDrop(gameRef.current); syncHud(); }}>⤓</button>
      </div>
    </div>
  );
}

function drawBoard(ctx: CanvasRenderingContext2D, game: Game) {
  const { board, active } = game;
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);
  ctx.fillStyle = "rgba(10, 12, 18, 0.92)";
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
  ctx.lineWidth = 1;
  for (let c = 1; c < COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * CELL + 0.5, 0);
    ctx.lineTo(c * CELL + 0.5, BOARD_H);
    ctx.stroke();
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * CELL + 0.5);
    ctx.lineTo(BOARD_W, r * CELL + 0.5);
    ctx.stroke();
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c]) drawCell(ctx, c, r, COLORS[board[r][c] as TypeId]);
    }
  }
  if (active && !game.over) {
    const ghostRow = ghostY(board, active);
    if (ghostRow !== active.y) {
      for (let r = 0; r < active.matrix.length; r++) {
        for (let c = 0; c < active.matrix[r].length; c++) {
          if (active.matrix[r][c]) drawCell(ctx, active.x + c, ghostRow + r, COLORS[active.type], true);
        }
      }
    }
    for (let r = 0; r < active.matrix.length; r++) {
      for (let c = 0; c < active.matrix[r].length; c++) {
        if (active.matrix[r][c]) drawCell(ctx, active.x + c, active.y + r, COLORS[active.type]);
      }
    }
  }
}

function drawCell(ctx: CanvasRenderingContext2D, col: number, row: number, color: string, ghost = false) {
  const pad = 1;
  const x = col * CELL + pad;
  const y = row * CELL + pad;
  const size = CELL - pad * 2;
  ctx.globalAlpha = ghost ? 0.22 : 1;
  ctx.fillStyle = color;
  roundRect(ctx, x, y, size, size, 4);
  ctx.fill();
  if (!ghost) {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x + 2, y + 2, size - 4, (size - 4) * 0.28, 3);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawMiniPiece(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  cell: number,
  matrix: number[][],
  color: string,
) {
  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (!matrix[r][c]) continue;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  const w = (maxC - minC + 1) * cell;
  const h = (maxR - minR + 1) * cell;
  const ox = centerX - w / 2;
  const oy = centerY - h / 2;
  ctx.fillStyle = color;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (!matrix[r][c]) continue;
      roundRect(ctx, ox + (c - minC) * cell + 1, oy + (r - minR) * cell + 1, cell - 2, cell - 2, 3);
      ctx.fill();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
