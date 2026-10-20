import React, { useState } from 'react';

const SIZES = [
  { size: 9, name: '9 路', desc: '快棋 · 5 分钟', tag: '入门' },
  { size: 13, name: '13 路', desc: '中盘 · 8 分钟', tag: '进阶' },
  { size: 19, name: '19 路', desc: '标准 · 10 分钟', tag: '经典' },
];

function relTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export default function Lobby({ lobby, queue, actions, me }) {
  const [size, setSize] = useState(19);
  const waiting = !!queue;

  return (
    <div className="lobby-grid">
      <section className="panel match-panel">
        <div className="panel-head">
          <h2>开始对局</h2>
          <span className="panel-sub">自动匹配在线棋友</span>
        </div>

        <div className="size-grid">
          {SIZES.map((s) => (
            <button
              key={s.size}
              className={`size-card ${size === s.size ? 'is-selected' : ''}`}
              onClick={() => !waiting && setSize(s.size)}
              disabled={waiting}
            >
              <span className="size-tag">{s.tag}</span>
              <span className="size-name">{s.name}</span>
              <span className="size-desc">{s.desc}</span>
              <span className="size-queue">排队 {lobby.queues?.[s.size] || 0} 人</span>
            </button>
          ))}
        </div>

        {waiting ? (
          <div className="matching">
            <div className="radar">
              <span className="radar-ring" />
              <span className="radar-ring delay1" />
              <span className="radar-core" />
            </div>
            <div className="matching-text">
              正在为你匹配 <b>{queue.size} 路</b> 对手…
              <span className="matching-hint">匹配到棋友后自动开局，请保持页面打开</span>
            </div>
            <button className="btn btn-ghost" onClick={actions.cancelQueue}>
              取消匹配
            </button>
          </div>
        ) : (
          <div className="match-actions">
            <button className="btn btn-primary btn-lg" onClick={() => actions.joinQueue(size)}>
              开始匹配
            </button>
            <button className="btn btn-ghost" onClick={() => actions.practice(size)}>
              与 AI 陪练
            </button>
          </div>
        )}

        <div className="match-note">
          中国规则（数子法）· 贴目 7.5 · 双方各 5~10 分钟包干，超时判负。
          <br />
          同一局域网内的其他设备访问本机地址即可参与匹配。
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>在线棋士</h2>
          <span className="panel-sub">{lobby.online} 人在线</span>
        </div>
        <div className="players-list">
          {(!lobby.players || lobby.players.length === 0) && (
            <div className="empty">暂无其他在线用户</div>
          )}
          {(lobby.players || []).map((p) => (
            <div key={p.id} className="player-row">
              <span className="avatar avatar-sm">{p.nickname[0]}</span>
              <span className="player-row-name">{p.nickname}</span>
              {p.id === me?.id && <span className="tag-me">我</span>}
              {p.inGame && <span className="tag-live">对局中</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>排行榜</h2>
          <span className="panel-sub">积分前 10</span>
        </div>
        <div className="rank-list">
          {lobby.leaderboard.length === 0 && <div className="empty">还没有战绩记录</div>}
          {lobby.leaderboard.map((u, i) => (
            <div key={u.id} className={`rank-row ${u.id === me?.id ? 'is-me' : ''}`}>
              <span className={`rank-no rank-${i + 1}`}>{i + 1}</span>
              <span className="rank-name">{u.nickname}</span>
              <span className="rank-record">
                {u.wins} 胜 {u.losses} 负
              </span>
              <span className="rank-score">{u.rating}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>最近对局</h2>
          <span className="panel-sub">来自本地棋谱库</span>
        </div>
        <div className="recent-list">
          {lobby.recent.length === 0 && <div className="empty">还没有完成的对局</div>}
          {lobby.recent.map((g) => (
            <div key={g.id} className="recent-row">
              <span className="recent-size">{g.size}路</span>
              <span className="recent-players">
                {g.black_name} <em>vs</em> {g.white_name}
              </span>
              <span className="recent-result">{g.result}</span>
              <span className="recent-time">{relTime(g.ended_at)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
