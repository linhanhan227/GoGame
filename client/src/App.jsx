import React, { useState } from 'react';
import { useGameSocket } from './lib/useGameSocket.js';
import { connHints } from './lib/config.js';
import Lobby from './components/Lobby.jsx';
import GameView from './components/GameView.jsx';

function ConnBanner({ conn, status, onRetry }) {
  // 首次连接中的正常状态不打扰用户
  if (status === 'open') return null;
  if (status === 'connecting' && conn.attempts === 0) return null;

  return (
    <div className="conn-banner" role="alert">
      <div className="conn-banner-main">
        <span className="conn-banner-title">
          {status === 'connecting' ? '正在重连对战服务…' : '无法连接对战服务'}
        </span>
        <code className="conn-url">{conn.url}</code>
        {conn.attempts > 0 && <span className="conn-meta">已尝试 {conn.attempts} 次</span>}
        {conn.error && <span className="conn-meta conn-error">{conn.error}</span>}
        <button className="btn btn-mini conn-retry" onClick={onRetry}>
          立即重试
        </button>
      </div>
      <ul className="conn-hints">
        {connHints(conn.url).map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

function Login({ onEnter, status }) {
  const [nick, setNick] = useState(localStorage.getItem('go.nick') || '');
  const submit = (e) => {
    e.preventDefault();
    onEnter(nick);
  };
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark">弈</div>
        <h1>在线围棋</h1>
        <p className="login-sub">纯本地部署 · 自动匹配 · 实时对战</p>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="nick">
            你的棋名
          </label>
          <input
            id="nick"
            className="input"
            value={nick}
            maxLength={16}
            autoFocus
            placeholder="例如：清风徐来"
            onChange={(e) => setNick(e.target.value)}
          />
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={status !== 'open'}>
            {status === 'open' ? '进入棋室' : status === 'connecting' ? '连接中…' : '对战服务未连接'}
          </button>
        </form>
        <div className="login-features">
          <span>19 / 13 / 9 路</span>
          <span>中国规则数子</span>
          <span>棋谱入库 SQLite</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { status, conn, me, lobby, game, you, queue, result, chat, toasts, actions } = useGameSocket();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">弈</span>
          <span className="brand-text">在线围棋</span>
        </div>
        <div className="topbar-right">
          <span className={`conn conn-${status}`}>
            <i />
            {status === 'open' ? '已连接' : status === 'connecting' ? '连接中' : '已断开'}
          </span>
          {me && (
            <>
              <span className="online-count">{lobby.online} 人在线</span>
              <span className="user-chip">
                <span className="avatar avatar-sm">{me.nickname[0]}</span>
                <span className="user-name">{me.nickname}</span>
                <span className="user-rating">{me.rating}</span>
              </span>
            </>
          )}
        </div>
      </header>

      <ConnBanner conn={conn} status={status} onRetry={actions.reconnect} />

      {!me ? (
        <Login onEnter={actions.login} status={status} />
      ) : (
        <main className="main">
          {game ? (
            <GameView
              game={game}
              you={you}
              result={result}
              chat={chat}
              actions={actions}
              me={me}
            />
          ) : (
            <Lobby lobby={lobby} queue={queue} actions={actions} me={me} />
          )}
        </main>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
