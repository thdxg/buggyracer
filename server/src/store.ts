import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Run, RunSummary } from '../../shared/types';

/**
 * One storage backend, on local disk.
 *
 * There was an Atlas backend here too. It is gone: the Atlas Data API reached
 * end-of-life in September 2025, so the browser could never talk to it anyway,
 * and a leaderboard measured in kilobytes does not need a database behind a
 * network. The interface stays because the HUD and the routes are written
 * against it - swapping the backend later means implementing this, not
 * rewriting callers.
 */
export interface RunStore {
  readonly kind: 'file';
  list(trackId: string, limit: number): Promise<RunSummary[]>;
  get(id: string): Promise<Run | null>;
  topWithPaths(trackId: string, limit: number): Promise<Run[]>;
  byIds(ids: string[]): Promise<Run[]>;
  insert(run: Run): Promise<string>;
  matchmake(trackId: string, projectedTime: number, limit: number, excludeName?: string): Promise<Run[]>;
  bestFor(trackId: string, playerName: string): Promise<RunSummary | null>;
  mostRecent(trackId: string): Promise<Run | null>;
  reset(trackId: string, keepSynthetic: boolean): Promise<number>;
  count(trackId: string): Promise<number>;
  close(): Promise<void>;
}

const stripPath = (r: Run): RunSummary => {
  const { path, ...rest } = r;
  return rest as RunSummary;
};

// ---------------------------------------------------------------------------
// File-backed store
// ---------------------------------------------------------------------------
export class FileStore implements RunStore {
  readonly kind = 'file' as const;
  private runs: Run[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {}

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    try {
      this.runs = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.runs = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.runs);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot);
    });
    return this.writing;
  }

  async list(trackId: string, limit: number): Promise<RunSummary[]> {
    await this.ensure();
    return this.runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.totalTime - b.totalTime)
      .slice(0, limit)
      .map(stripPath);
  }

  async get(id: string): Promise<Run | null> {
    await this.ensure();
    return this.runs.find((r) => r._id === id) ?? null;
  }

  async topWithPaths(trackId: string, limit: number): Promise<Run[]> {
    await this.ensure();
    return this.runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.totalTime - b.totalTime)
      .slice(0, limit);
  }

  async byIds(ids: string[]): Promise<Run[]> {
    await this.ensure();
    return this.runs.filter((r) => r._id && ids.includes(r._id));
  }

  async insert(run: Run): Promise<string> {
    await this.ensure();
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.runs.push({ ...run, _id: id });
    await this.persist();
    return id;
  }

  async matchmake(trackId: string, projectedTime: number, limit: number, excludeName?: string): Promise<Run[]> {
    await this.ensure();
    const rank = (pool: Run[]) =>
      [...pool]
        .sort((a, b) => Math.abs(a.totalTime - projectedTime) - Math.abs(b.totalTime - projectedTime))
        .slice(0, limit);
    const all = this.runs.filter((r) => r.trackId === trackId);
    const others = excludeName ? all.filter((r) => r.playerName !== excludeName) : all;
    const picked = rank(others);
    return picked.length < limit ? rank(all) : picked;
  }

  async bestFor(trackId: string, playerName: string): Promise<RunSummary | null> {
    await this.ensure();
    const r = this.runs
      .filter((x) => x.trackId === trackId && x.playerName === playerName)
      .sort((a, b) => a.totalTime - b.totalTime)[0];
    return r ? stripPath(r) : null;
  }

  async mostRecent(trackId: string): Promise<Run | null> {
    await this.ensure();
    const real = this.runs.filter((r) => r.trackId === trackId && !r.synthetic);
    return real.length ? real[real.length - 1] : null;
  }

  async reset(trackId: string, keepSynthetic: boolean): Promise<number> {
    await this.ensure();
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => {
      if (r.trackId !== trackId) return true;
      return keepSynthetic && r.synthetic === true;
    });
    await this.persist();
    return before - this.runs.length;
  }

  async count(trackId: string): Promise<number> {
    await this.ensure();
    return this.runs.filter((r) => r.trackId === trackId).length;
  }

  async close(): Promise<void> {
    await this.writing;
  }
}

export async function createStore(): Promise<RunStore> {
  // Relative by default, which resolves against the working directory - so the
  // container points DATA_FILE at its mounted volume instead.
  const file = process.env.DATA_FILE ?? 'data/runs.json';
  console.log(`[store] file store at ${file}`);
  return new FileStore(file);
}
