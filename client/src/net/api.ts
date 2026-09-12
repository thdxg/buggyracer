import type { Run, RunSummary } from '../../../shared/types';

/**
 * Every call here fails soft. If the backend is down the game must still be
 * fully playable - local only, no ghosts, no leaderboard, no commentary - so
 * nothing in this module is allowed to throw into the game loop.
 */

export interface Health {
  ok: boolean;
  store: 'file';
  ai: { gemini: boolean; elevenlabs: boolean; geminiModel: string };
  ttsCharsUsed: number;
  ttsCharBudget: number;
  rooms?: number;
  lan?: string[];
}

let online = true;
export const isOnline = () => online;

async function call<T>(path: string, init?: RequestInit, timeoutMs = 6000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    online = true;
    return (await res.json()) as T;
  } catch {
    online = false;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => call<Health>('/api/health', undefined, 2500),

  leaderboard: (trackId: string, limit = 25) =>
    call<RunSummary[]>(`/api/runs?trackId=${encodeURIComponent(trackId)}&limit=${limit}`).then((r) => r ?? []),

  topGhosts: (trackId: string, limit = 3) =>
    call<Run[]>(`/api/ghosts?trackId=${encodeURIComponent(trackId)}&limit=${limit}`).then((r) => r ?? []),

  mostRecent: (trackId: string) => call<Run | null>(`/api/recent?trackId=${encodeURIComponent(trackId)}`),

  personalBest: (trackId: string, playerName: string) =>
    call<RunSummary | null>(
      `/api/best?trackId=${encodeURIComponent(trackId)}&playerName=${encodeURIComponent(playerName)}`,
    ),

  saveRun: (run: Omit<Run, '_id' | 'createdAt'>) =>
    call<{ id: string; rank: number | null }>('/api/runs', json(run), 10000),

  matchmake: (trackId: string, projectedTime: number, playerName: string, limit = 4) =>
    call<Run[]>('/api/matchmake', json({ trackId, projectedTime, playerName, limit }), 4000).then((r) => r ?? []),

  commentary: (payload: Record<string, unknown>) =>
    call<{ text: string | null }>('/api/commentary', json(payload), 3500),

  ttsToken: () => call<{ token: string | null; voiceId?: string; model?: string }>('/api/tts-token', json({}), 3000),

  reset: (trackId: string, keepSynthetic = true) =>
    call<{ deleted: number; remaining: number }>('/api/reset', json({ trackId, keepSynthetic })),
};
