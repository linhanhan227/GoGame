import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL } from './config.js';

const UID_KEY = 'go.uid';
const NICK_KEY = 'go.nick';

function getUid() {
  let id = sessionStorage.getItem(UID_KEY);
  if (!id) {
    id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    sessionStorage.setItem(UID_KEY, id);
  }
  return id;
}

export function useGameSocket() {
  const [status, setStatus] = useState('connecting');
  const [conn, setConn] = useState({ url: WS_URL, attempts: 0, error: '', since: Date.now() });
  const [me, setMe] = useState(null);
  const [lobby, setLobby] = useState({ online: 0, leaderboard: [], recent: [], queues: {}, players: [] });
  const [game, setGame] = useState(null);
  const [you, setYou] = useState(null);
  const [queue, setQueue] = useState(null);
  const [result, setResult] = useState(null);
  const [chat, setChat] = useState([]);
  const [toasts, setToasts] = useState([]);

  const wsRef = useRef(null);
  const meRef = useRef(null);
  const retryRef = useRef(0);
  const disposedRef = useRef(false);
  const connectRef = useRef(null);

  const toast = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  const rawSend = (payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  const login = useCallback((nickname) => {
    const nick = (nickname || '').trim().slice(0, 16) || '匿名棋士';
    localStorage.setItem(NICK_KEY, nick);
    meRef.current = nick;
    // 连接未就绪时先记录昵称，onopen 后自动补发登录
    return rawSend({ type: 'login', userId: getUid(), nickname: nick });
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current) return;
      setStatus('connecting');
      setConn((c) => ({ ...c, url: WS_URL }));

      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (e) {
        setStatus('closed');
        setConn((c) => ({ ...c, error: e.message || '地址无效', attempts: c.attempts + 1 }));
        setTimeout(connect, 2000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposedRef.current) return;
        retryRef.current = 0;
        setStatus('open');
        setConn({ url: WS_URL, attempts: 0, error: '', since: Date.now() });
        if (meRef.current) {
          ws.send(JSON.stringify({ type: 'login', userId: getUid(), nickname: meRef.current }));
        }
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'logged_in':
            setMe(msg.user);
            meRef.current = msg.user.nickname;
            if (!msg.resumed) {
              setGame(null);
              setYou(null);
              setResult(null);
              setChat([]);
            }
            break;
          case 'lobby':
            setLobby({
              online: msg.online,
              leaderboard: msg.leaderboard || [],
              recent: msg.recent || [],
              queues: msg.queues || {},
              players: msg.players || [],
            });
            break;
          case 'queued':
            setQueue({ size: msg.size });
            break;
          case 'queue_cancelled':
            setQueue(null);
            break;
          case 'state':
            setGame(msg.game);
            setYou(msg.you);
            setQueue(null);
            if (msg.game.phase === 'finished' && msg.game.result) setResult(msg.game.result);
            break;
          case 'game_over':
            setResult(msg.result);
            setGame((g) => (g ? { ...g, phase: 'finished', result: msg.result } : g));
            break;
          case 'chat':
            setChat((c) => [...c.slice(-80), { from: msg.from, text: msg.text, color: msg.color }]);
            break;
          case 'error':
            toast(msg.message, 'error');
            break;
          default:
            break;
        }
      };

      ws.onclose = (ev) => {
        if (disposedRef.current) return;
        // 已被新连接替换，不再重复重连
        if (wsRef.current !== ws) return;
        setStatus('closed');
        setConn((c) => ({
          ...c,
          attempts: c.attempts + 1,
          error: ev.reason || (ev.code ? `连接被关闭（code ${ev.code}）` : '无法建立连接'),
        }));
        const delay = Math.min(8000, 800 * 2 ** retryRef.current);
        retryRef.current += 1;
        setTimeout(connect, delay);
      };

      ws.onerror = () => {
        setConn((c) => ({
          ...c,
          error: c.error || '握手失败：目标地址不可达，或该端点不是 WebSocket 服务',
        }));
      };
    };

    connectRef.current = connect;
    connect();

    return () => {
      disposedRef.current = true;
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [toast]);

  const actions = {
    login,
    reconnect: () => {
      retryRef.current = 0;
      const old = wsRef.current;
      wsRef.current = null;
      try {
        old?.close();
      } catch {}
      connectRef.current?.();
    },
    joinQueue: (size) => rawSend({ type: 'queue', size }),
    cancelQueue: () => rawSend({ type: 'cancel_queue' }),
    practice: (size) => rawSend({ type: 'practice', size }),
    play: (x, y) => rawSend({ type: 'move', x, y }),
    pass: () => rawSend({ type: 'pass' }),
    resign: () => rawSend({ type: 'resign' }),
    markDead: (point) => rawSend({ type: 'mark_dead', point }),
    confirmScore: () => rawSend({ type: 'confirm_score' }),
    resume: () => rawSend({ type: 'resume' }),
    chat: (text) => rawSend({ type: 'chat', text }),
    leaveTable: () => {
      setGame(null);
      setYou(null);
      setResult(null);
      setChat([]);
    },
  };

  return { status, conn, me, lobby, game, you, queue, result, chat, toasts, actions, toast };
}
