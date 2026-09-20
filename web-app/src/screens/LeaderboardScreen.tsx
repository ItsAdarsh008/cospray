import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLeaderboard } from '../data/sync';
import { useStore } from '../store';
import type { Painter } from '../types';

/**
 * Port of the native LeaderboardScreen. Top painters by paint used, refreshed every 8 s. When the
 * board can't be reached we fall back to showing just the signed-in painter (same as native); the
 * pull-to-refresh control becomes a refresh button on the web.
 */

const REFRESH_MS = 8_000;

export function LeaderboardScreen() {
  const me = useStore((s) => s.painter);
  const [rows, setRows] = useState<Painter[]>([]);
  const [loading, setLoading] = useState(true); // first fetch starts on mount
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await fetchLeaderboard();
      if (!alive.current) return;
      setRows(next);
      setErr(null);
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error && e.message ? e.message : 'offline');
    }
    if (alive.current) setLoading(false);
  }, []);

  const refresh = useCallback(() => { setLoading(true); void load(); }, [load]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => { alive.current = false; window.clearInterval(id); };
  }, [load, refresh]);

  const data = rows.length ? rows : me ? [me] : [];
  const isMe = (p: Painter) => !!me && (p.id === me.id || p.name === me.name);

  return (
    <div className="tg-board-root">
      <style>{BOARD_CSS}</style>
      <div className="tg-board-head">
        <h1 className="tg-board-h1">TOP PAINTERS</h1>
        <button
          type="button"
          className={`tg-board-refresh${loading ? ' is-loading' : ''}`}
          onClick={() => { if (!loading) refresh(); }}
          aria-label="Refresh leaderboard"
          aria-busy={loading}>
          ↻
        </button>
      </div>
      {err && <div className="tg-board-err">Leaderboard offline ({err}) — showing you only</div>}
      {data.length === 0 ? (
        <div className="tg-board-empty">No painters yet. Go tag something.</div>
      ) : (
        <ol className="tg-board-list">
          {data.map((p, i) => (
            <li key={p.id} className={`tg-board-row${isMe(p) ? ' is-me' : ''}`}>
              <span className="tg-board-rank">{i + 1}</span>
              <span className="tg-board-name">{p.name}</span>
              <span className="tg-board-stat">{Math.round(p.paint_used)} paint</span>
              <span className="tg-board-stat">{p.strokes} strokes</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const BOARD_CSS = `
.tg-board-root{box-sizing:border-box;width:100%;height:100vh;height:100dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#0b0b0f;color:#fff;padding:calc(env(safe-area-inset-top,0px) + 28px) 16px calc(env(safe-area-inset-bottom,0px) + 110px)}
.tg-board-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.tg-board-h1{margin:0;color:#fff;font-weight:900;font-size:22px;letter-spacing:3px}
.tg-board-refresh{appearance:none;-webkit-appearance:none;border:1px solid #ffffff22;background:#ffffff11;color:#fff;font-size:18px;line-height:1;width:36px;height:36px;border-radius:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity .15s}
.tg-board-refresh:active{opacity:.6}
.tg-board-refresh.is-loading{animation:tg-board-spin .8s linear infinite;opacity:.7}
@keyframes tg-board-spin{to{transform:rotate(360deg)}}
.tg-board-err{color:#ff5c1a;font-size:12px;margin-bottom:8px}
.tg-board-list{list-style:none;margin:0;padding:0}
.tg-board-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #ffffff11}
.tg-board-row.is-me{background:#ff2d9522;margin:0 -8px;padding-left:8px;padding-right:8px;border-radius:8px}
.tg-board-rank{color:#ffe600;font-weight:900;width:28px;flex:0 0 28px;font-size:16px}
.tg-board-name{color:#fff;font-weight:800;flex:1;min-width:0;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tg-board-stat{color:#ffffffaa;font-size:12px;white-space:nowrap}
.tg-board-empty{color:#ffffff88;margin-top:40px;text-align:center}
`;
