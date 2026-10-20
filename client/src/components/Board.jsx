import React, { useMemo, useRef, useState } from 'react';

const CELL = 30;
const PAD = 34;
const LETTERS = 'ABCDEFGHJKLMNOPQRST';

const STARS = {
  9: [2, 4, 6],
  13: [3, 6, 9],
  19: [3, 9, 15],
};

export default function Board({
  size = 19,
  board = [],
  lastMove = null,
  dead = [],
  phase = 'playing',
  canPlay = false,
  myColor = 'black',
  onPlay,
  onMarkDead,
}) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const dim = PAD * 2 + CELL * (size - 1);
  const deadSet = useMemo(() => new Set(dead), [dead]);
  const stars = STARS[size] || STARS[19];

  const pointFromEvent = (e) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scale = dim / rect.width;
    const px = (e.clientX - rect.left) * scale;
    const py = (e.clientY - rect.top) * scale;
    const x = Math.round((px - PAD) / CELL);
    const y = Math.round((py - PAD) / CELL);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    const cx = PAD + x * CELL;
    const cy = PAD + y * CELL;
    if (Math.hypot(px - cx, py - cy) > CELL * 0.62) return null;
    return { x, y };
  };

  const handleMove = (e) => {
    if (phase !== 'playing' || !canPlay) {
      if (hover) setHover(null);
      return;
    }
    const p = pointFromEvent(e);
    if (!p || board[p.y * size + p.x] !== 0) {
      if (hover) setHover(null);
      return;
    }
    if (!hover || hover.x !== p.x || hover.y !== p.y) setHover(p);
  };

  const handleClick = (e) => {
    const p = pointFromEvent(e);
    if (!p) return;
    const idx = p.y * size + p.x;
    if (phase === 'scoring') {
      if (board[idx] !== 0) onMarkDead?.(idx);
      return;
    }
    if (!canPlay || board[idx] !== 0) return;
    onPlay?.(p.x, p.y);
  };

  const stones = [];
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (!v) continue;
    const x = i % size;
    const y = (i - x) / size;
    const cx = PAD + x * CELL;
    const cy = PAD + y * CELL;
    const isDead = deadSet.has(i);
    stones.push(
      <g key={i} opacity={isDead ? 0.3 : 1}>
        <circle
          cx={cx}
          cy={cy + 0.8}
          r={CELL * 0.47}
          fill="rgba(70,45,15,0.28)"
          opacity="0.55"
        />
        <circle
          cx={cx}
          cy={cy}
          r={CELL * 0.47}
          fill={v === 1 ? 'url(#stoneBlack)' : 'url(#stoneWhite)'}
          stroke={v === 1 ? '#000' : '#c9c2b2'}
          strokeWidth={v === 1 ? 0.6 : 0.8}
        />
        {isDead && (
          <g stroke="#b03a2e" strokeWidth="1.8" strokeLinecap="round">
            <line x1={cx - 6} y1={cy - 6} x2={cx + 6} y2={cy + 6} />
            <line x1={cx + 6} y1={cy - 6} x2={cx - 6} y2={cy + 6} />
          </g>
        )}
      </g>
    );
  }

  return (
    <div className="board-wrap">
      <svg
        ref={svgRef}
        className={`board-svg ${phase === 'scoring' ? 'is-scoring' : ''}`}
        viewBox={`0 0 ${dim} ${dim}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        onClick={handleClick}
        role="img"
        aria-label={`${size}路围棋棋盘`}
      >
        <defs>
          <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#eac796" />
            <stop offset="45%" stopColor="#e2b67c" />
            <stop offset="100%" stopColor="#d8a768" />
          </linearGradient>
          <radialGradient id="stoneBlack" cx="34%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#767676" />
            <stop offset="45%" stopColor="#2a2a2a" />
            <stop offset="100%" stopColor="#050505" />
          </radialGradient>
          <radialGradient id="stoneWhite" cx="34%" cy="26%" r="80%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#f3f1ea" />
            <stop offset="100%" stopColor="#d6d1c4" />
          </radialGradient>
          <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="0.6" />
          </filter>
        </defs>

        <rect x="0" y="0" width={dim} height={dim} rx="6" fill="url(#wood)" />
        <rect
          x="1.5"
          y="1.5"
          width={dim - 3}
          height={dim - 3}
          rx="5"
          fill="none"
          stroke="rgba(120,80,30,0.35)"
        />

        {/* 网格 */}
        <g stroke="#5c4526" strokeWidth="1" strokeOpacity="0.82">
          {Array.from({ length: size }).map((_, i) => {
            const p = PAD + i * CELL;
            const end = PAD + (size - 1) * CELL;
            return (
              <g key={i}>
                <line x1={PAD} y1={p} x2={end} y2={p} />
                <line x1={p} y1={PAD} x2={p} y2={end} />
              </g>
            );
          })}
        </g>

        {/* 星位 */}
        <g fill="#4a3718">
          {stars.map((sx) =>
            stars.map((sy) => (
              <circle key={`${sx}-${sy}`} cx={PAD + sx * CELL} cy={PAD + sy * CELL} r="2.8" />
            ))
          )}
        </g>

        {/* 坐标 */}
        <g fill="#7c6134" fontSize="11" fontFamily="ui-sans-serif, system-ui">
          {Array.from({ length: size }).map((_, i) => (
            <g key={i}>
              <text x={PAD + i * CELL} y={dim - 12} textAnchor="middle">
                {LETTERS[i]}
              </text>
              <text x={14} y={PAD + i * CELL + 4} textAnchor="middle">
                {size - i}
              </text>
            </g>
          ))}
        </g>

        {/* 最后一手 */}
        {lastMove && board[lastMove.y * size + lastMove.x] ? (
          <circle
            cx={PAD + lastMove.x * CELL}
            cy={PAD + lastMove.y * CELL}
            r={CELL * 0.17}
            fill={lastMove.color === 'black' || lastMove.color === 1 ? '#ffffff' : '#111111'}
            opacity="0.9"
          />
        ) : null}

        {stones}

        {/* 落子预览 */}
        {hover && phase === 'playing' ? (
          <circle
            cx={PAD + hover.x * CELL}
            cy={PAD + hover.y * CELL}
            r={CELL * 0.45}
            fill={myColor === 'black' ? 'rgba(10,10,10,0.32)' : 'rgba(255,255,255,0.55)'}
            stroke={myColor === 'black' ? 'rgba(0,0,0,0.3)' : 'rgba(140,130,110,0.5)'}
            pointerEvents="none"
          />
        ) : null}
      </svg>
    </div>
  );
}
