import { useCallback, useEffect, useRef, useState } from 'react';

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
  const closedByUs = useRef(false);

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
    const payload = { type: 'login', userId: getUid(), nickname: nick };
    meRef.current = nick;
    if (!rawSend(payload)) {
      // 连接未就绪，等 onopen 后自动补发
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retryRef.current = 0;
        setStatus('open');
        if (meRef.current) {
          ws.send(
            JSON.stringify({ type: 'login', userId: getUid(), nickname: meRef.current })
          );
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

      ws.onclose = () => {
        if (disposed) return;
        setStatus('closed');
        if (closedByUs.current) return;
        const delay = Math.min(8000, 800 * 2 ** retryRef.current);
        retryRef.current += 1;
        setTimeout(connect, delay);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    };

    connect();
    return () => {
      disposed = true;
      closedByUs.current = true;
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [toast]);

  const actions = {
    login,
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

  return { status, me, lobby, game, you, queue, result, chat, toasts, actions, toast };
}
