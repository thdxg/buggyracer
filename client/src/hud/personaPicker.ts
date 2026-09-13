import { PERSONAS, PERSONA_DEFAULT } from '../../../shared/personas';
import { fetchVoices } from '../audio/commentary';
import { escapeHtml } from './hud';

/**
 * Commentator picker on the name screen.
 *
 * Lives here rather than in main.ts so the wiring there stays a couple of lines.
 * Mirrors the car picker: buttons with aria-pressed, choice persisted to
 * localStorage, and no dependency on a race existing yet.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PERSONA_KEY = 'buggyracer.persona';
const VOICE_KEY = 'buggyracer.voice';

export interface PersonaChoice {
  persona: string;
  voiceId: string | null;
}

/** Reads the stored choice. Safe before the picker has been built. */
export function storedChoice(): PersonaChoice {
  const persona = localStorage.getItem(PERSONA_KEY) ?? PERSONA_DEFAULT;
  // A stored key from an older build may no longer exist; fall back rather than
  // sending the server a persona it will silently reject.
  const known = PERSONAS.some((p) => p.key === persona);
  return {
    persona: known ? persona : PERSONA_DEFAULT,
    voiceId: localStorage.getItem(VOICE_KEY) || null,
  };
}

/**
 * Builds the picker and calls `onChange` whenever the choice changes.
 *
 * The voice dropdown stays hidden unless the ElevenLabs account actually has
 * voices to choose between - an empty picker is worse than no picker, and with
 * no API key configured that is exactly what it would be.
 */
export function buildPersonaPicker(onChange: (choice: PersonaChoice) => void): void {
  const list = $('persona-list');
  const select = $<HTMLSelectElement>('voice-select');
  let choice = storedChoice();

  list.innerHTML = '';
  for (const p of PERSONAS) {
    const b = document.createElement('button');
    b.className = 'persona';
    b.type = 'button';
    b.dataset.key = p.key;
    b.innerHTML =
      `<span class="persona-name">${escapeHtml(p.name)}</span>` +
      `<span class="persona-blurb">${escapeHtml(p.blurb)}</span>`;
    b.setAttribute('aria-pressed', String(p.key === choice.persona));
    b.addEventListener('click', () => {
      choice = { ...choice, persona: p.key };
      localStorage.setItem(PERSONA_KEY, p.key);
      for (const el of Array.from(list.children)) {
        el.setAttribute('aria-pressed', String((el as HTMLElement).dataset.key === p.key));
      }
      onChange(choice);
    });
    list.appendChild(b);
  }

  select.hidden = true;
  select.addEventListener('change', () => {
    choice = { ...choice, voiceId: select.value || null };
    if (select.value) localStorage.setItem(VOICE_KEY, select.value);
    else localStorage.removeItem(VOICE_KEY);
    onChange(choice);
  });

  // Populated asynchronously; the screen is fully usable before it resolves.
  void fetchVoices().then((voices) => {
    if (!voices.length) return;
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.description ? `${v.name} - ${v.description}` : v.name;
      select.appendChild(opt);
    }
    if (choice.voiceId && voices.some((v) => v.id === choice.voiceId)) {
      select.value = choice.voiceId;
    }
    select.hidden = false;
  });

  onChange(choice);
}
