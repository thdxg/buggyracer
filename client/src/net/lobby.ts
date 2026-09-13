import type { PlayerInfo } from '../../../shared/net';
import { CAR_COLOR_HEX } from '../render/carSprites';
import type { SessionSnapshot } from './session';

/**
 * Lobby screen. Lives in net/ so hud/ stays blind to multiplayer — if the
 * RacerState boundary holds, nothing under hud/ needs to know this exists.
 *
 * Markup reuses the existing `.screen` / `.card` / button classes so it matches
 * the name and calibration screens without a styles.css edit.
 */

export interface LobbyHandlers {
  onJoin: (room: string) => void;
  onSolo: () => void;
  onStart: () => void;
  onReady: (ready: boolean) => void;
  onLeave: () => void;
}

export class LobbyView {
  readonly el: HTMLElement;
  private statusEl: HTMLElement;
  private hintEl: HTMLElement;
  private roomInput: HTMLInputElement;
  private roomPanel: HTMLElement;
  private roomCodeEl: HTMLElement;
  private rosterEl: HTMLElement;
  private startBtn: HTMLButtonElement;
  private readyBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private ready = false;

  constructor(private handlers: LobbyHandlers) {
    this.el = document.createElement('div');
    this.el.id = 'screen-lobby';
    this.el.className = 'screen';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="card">
        <h1>Race together</h1>
        <p class="lede">Same room, same grid. Ghosts still show up so a two-person field is never empty.</p>
        <input id="input-room" maxlength="16" placeholder="Room name" autocomplete="off" spellcheck="false" />
        <button type="button" class="primary" data-act="join">Join room</button>
        <button type="button" class="ghost" data-act="solo">Race solo</button>
        <p class="muted" data-role="status"></p>
        <div data-role="room" hidden>
          <h2>Room <span data-role="code"></span></h2>
          <ol data-role="roster" id="lobby-roster"></ol>
          <button type="button" class="primary" data-act="start">Start race</button>
          <button type="button" class="ghost" data-act="ready">I'm ready</button>
          <button type="button" class="ghost" data-act="leave">Leave room</button>
        </div>
        <p class="muted" data-role="hint"></p>
      </div>
    `;
    document.body.appendChild(this.el);

    this.statusEl = this.el.querySelector('[data-role="status"]')!;
    this.hintEl = this.el.querySelector('[data-role="hint"]')!;
    this.roomInput = this.el.querySelector('#input-room')!;
    this.roomPanel = this.el.querySelector('[data-role="room"]')!;
    this.roomCodeEl = this.el.querySelector('[data-role="code"]')!;
    this.rosterEl = this.el.querySelector('[data-role="roster"]')!;
    this.startBtn = this.el.querySelector('[data-act="start"]')!;
    this.readyBtn = this.el.querySelector('[data-act="ready"]')!;
    this.joinBtn = this.el.querySelector('[data-act="join"]')!;
    this.leaveBtn = this.el.querySelector('[data-act="leave"]')!;

    this.roomInput.value = localStorage.getItem('buggyracer.room') ?? '';

    this.el.querySelector('[data-act="join"]')!.addEventListener('click', () => this.submitJoin());
    this.el.querySelector('[data-act="solo"]')!.addEventListener('click', () => this.handlers.onSolo());
    this.startBtn.addEventListener('click', () => this.handlers.onStart());
    this.readyBtn.addEventListener('click', () => {
      this.ready = !this.ready;
      this.handlers.onReady(this.ready);
    });
    this.leaveBtn.addEventListener('click', () => this.handlers.onLeave());
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitJoin();
    });

    // Roster list uses the same grid as the in-race standings so it looks native.
    const style = document.createElement('style');
    style.textContent = `
      #lobby-roster { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 4px; text-align: left; }
      #lobby-roster li {
        display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
        padding: 7px 10px; border-radius: 8px; font-size: 13px;
        background: rgba(255,255,255,0.05);
      }
      #lobby-roster li.me { background: rgba(56,189,248,0.2); border: 1px solid rgba(56,189,248,0.45); }
      #lobby-roster .who { display: flex; align-items: center; gap: 8px; }
      #lobby-roster .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      #lobby-roster .tag { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
      #lobby-roster .tag.ready { color: var(--good); }
    `;
    document.head.appendChild(style);
  }

  show(): void {
    this.el.hidden = false;
    this.roomInput.focus();
  }

  hide(): void {
    this.el.hidden = true;
  }

  apply(snap: SessionSnapshot): void {
    this.statusEl.textContent = snap.message;
    this.statusEl.className = snap.status === 'offline' ? 'error' : 'muted';
    this.joinBtn.disabled = snap.status === 'connecting';

    const joined = snap.status === 'lobby' || snap.status === 'racing';
    this.roomPanel.hidden = !joined;
    if (joined && snap.room) {
      this.roomCodeEl.textContent = snap.room.toUpperCase();
      this.renderRoster(snap.players, snap.id, snap.readyIds);
    }

    this.ready = snap.id ? snap.readyIds.has(snap.id) : false;
    this.readyBtn.textContent = this.ready ? 'Ready' : "I'm ready";
    this.readyBtn.setAttribute('aria-pressed', String(this.ready));
    this.startBtn.disabled = snap.players.length < 1 || snap.status !== 'lobby';
  }

  setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  roomValue(): string {
    return this.roomInput.value;
  }

  private submitJoin(): void {
    const room = this.roomInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!room) {
      this.statusEl.textContent = 'Enter a room name first.';
      this.statusEl.className = 'error';
      this.roomInput.focus();
      return;
    }
    this.roomInput.value = room;
    localStorage.setItem('buggyracer.room', room);
    this.handlers.onJoin(room);
  }

  private renderRoster(players: PlayerInfo[], meId: string, readyIds: ReadonlySet<string>): void {
    this.rosterEl.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      if (p.id === meId) li.className = 'me';
      const hex = CAR_COLOR_HEX[p.colorIndex % CAR_COLOR_HEX.length];
      const you = p.id === meId ? ' (you)' : '';
      const ready = readyIds.has(p.id);
      li.innerHTML =
        `<span class="who"><span class="dot" style="background:${hex}"></span>${escapeHtml(p.name)}${you}</span>` +
        `<span class="tag${ready ? ' ready' : ''}">${ready ? 'ready' : 'here'}</span>`;
      this.rosterEl.appendChild(li);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
