import React, { useEffect, useRef, useState } from 'react';
import Board from './Board.jsx';
import { apiUrl } from '../lib/config.js';

const fmt = (s) => {
  const v = Math.max(0, Math.round(s));
  const m = Math.floor(v / 60);
  const r = v % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

function PlayerCard({ player, color, timeLeft, captures, active, disconnected, isMe, phase }) {
  const low = timeLeft <= 60;
  return (
    <div className={`player-card ${active ? 'is-active' : ''}`}>
      <div className={`avatar avatar-${color}`}>{player?.nickname?.[0] || '?'}</div>
      <div className="player-main">
        <div className="player-name">
          {player?.nickname || '等待中'}
          {isMe && <span className="tag-me">我</span>}
        </div>
        <div className="player-meta">
          <span className={`dot dot-${color}`} />
          {color === 'black' ? '执黑' : '执白'} · 提子 {captures}
          {disconnected && <span className="tag-warn">掉线</span>}
        </div>
      </div>
      <div className={`clock ${active && phase === 'playing' ? 'is-running' : ''} ${low ? 'is-low' : ''}`}>
        {fmt(timeLeft)}
      </div>
    </div>
  );
}

export default function GameView({ game, you, result, chat, actions, me }) {
  const [text, setText] = useState('');
  const chatRef = useRef(null);
  const opp = you === 'black' ? 'white' : 'black';
  const myTurn = game.toPlay === you && game.phase === 'playing';
  const canPlay = myTurn && !game.disconnected.includes(you);
  const iConfirmed = game.confirmed.includes(you);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat]);

  const submitChat = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    actions.chat(text.trim());
    setText('');
  };

  return (
    <div className="game-layout">
      <section className="board-panel">
        <div className="game-bar">
          <span className="game-bar-title">
            {game.size} 路 · 贴目 {game.komi}
          </span>
          <span className="game-bar-sub">
            第 {game.moveNumber} 手
            {game.phase === 'scoring' && ' · 点目中'}
          </span>
          <span className={`turn-pill ${myTurn ? 'mine' : ''}`}>
            {game.phase === 'finished'
              ? '已终局'
              : game.phase === 'scoring'
                ? '双方确认死子'
                : myTurn
                  ? '轮到你落子'
                  : '等待对手'}
          </span>
        </div>

        <div className="board-stage">
          <Board
            size={game.size}
            board={game.board}
            lastMove={game.lastMove}
            dead={game.dead}
            phase={game.phase}
            canPlay={canPlay}
            myColor={you}
            onPlay={actions.play}
            onMarkDead={actions.markDead}
          />

          {result && (
            <div className="result-overlay">
              <div className="result-card">
                <div className="result-label">
                  {result.winner === 'draw' ? '和棋' : result.winner === you ? '你赢了' : '你输了'}
                </div>
                <div className="result-text">{result.text}</div>
                <div className="result-sub">
                  共 {game.moveNumber} 手 ·{' '}
                  {result.reason === 'score'
                    ? `黑 ${result.blackScore} / 白 ${result.whiteScore}`
                    : { resign: '中盘认输', timeout: '超时', disconnect: '断线' }[result.reason] || ''}
                </div>
                <div className="result-actions">
                  <button className="btn btn-primary" onClick={actions.leaveTable}>
                    返回大厅
                  </button>
                  <a className="btn btn-ghost" href={apiUrl(`/api/game/${game.id}.sgf`)} download>
                    下载棋谱
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="side-panel">
        <PlayerCard
          player={game.players[opp]}
          color={opp}
          timeLeft={game.timeLeft[opp]}
          captures={game.captures[opp]}
          active={game.toPlay === opp}
          disconnected={game.disconnected.includes(opp)}
          isMe={false}
          phase={game.phase}
        />

        <div className="vs-row">
          <span>VS</span>
        </div>

        <PlayerCard
          player={game.players[you]}
          color={you}
          timeLeft={game.timeLeft[you]}
          captures={game.captures[you]}
          active={game.toPlay === you}
          disconnected={game.disconnected.includes(you)}
          isMe
          phase={game.phase}
        />

        <div className="controls">
          {game.phase === 'playing' && (
            <>
              <button className="btn btn-ghost" onClick={actions.pass} disabled={!canPlay}>
                虚手
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (confirm('确认认输？')) actions.resign();
                }}
              >
                认输
              </button>
            </>
          )}
          {game.phase === 'scoring' && (
            <>
              <div className="scoring-tip">
                点击棋盘上的死子进行标记，双方确认后自动数子。
                {game.provisional && (
                  <div className="provisional">
                    当前估算：黑 {game.provisional.black} · 白{' '}
                    {(game.provisional.white + game.komi).toFixed(1)}（含贴目）
                  </div>
                )}
              </div>
              <button
                className="btn btn-primary"
                onClick={actions.confirmScore}
                disabled={iConfirmed}
              >
                {iConfirmed ? '已确认，等待对手' : '确认结果'}
              </button>
              <button className="btn btn-ghost" onClick={actions.resume}>
                恢复对局
              </button>
            </>
          )}
        </div>

        <div className="chat-panel">
          <div className="chat-head">对局聊天</div>
          <div className="chat-body" ref={chatRef}>
            {chat.length === 0 && <div className="chat-empty">还没有消息</div>}
            {chat.map((c, i) => (
              <div key={i} className={`chat-line ${c.color === you ? 'mine' : ''}`}>
                <span className="chat-from">{c.from}</span>
                <span className="chat-text">{c.text}</span>
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={submitChat}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="说点什么…"
              maxLength={200}
            />
            <button className="btn btn-mini" type="submit">
              发送
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
