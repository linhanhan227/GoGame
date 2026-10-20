import React, { useState } from 'react';
import { useGameSocket } from './lib/useGameSocket.js';
import Lobby from './components/Lobby.jsx';
import GameView from './components/GameView.jsx';

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
            {status === 'open' ? '进入棋室' : '连接中…'}
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
  const { status, me, lobby, game, you, queue, result, chat, toasts, actions } = useGameSocket();

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
