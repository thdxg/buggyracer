import QRCode from 'qrcode';
import type { RunSummary } from '../../shared/types';
import { loadTrack, TrackGeometry, type CourseDef } from './game/track';
import { Race } from './game/race';
import { TUNING } from './game/physics';
import { HandTracker, startCamera, type TrackingFrame } from './tracking/hands';
import { Calibrator, SteeringController } from './tracking/steering';
import { SceneRenderer } from './render/scene';
import { demoHills } from './render/elevation';
import { OverlayRenderer } from './render/overlay';
import { Minimap } from './render/minimap';
import {
  CAR_COLOR_HEX,
  CAR_SHAPES,
  SHAPE_LABELS,
  preloadCarSprites,
  spriteUrl,
} from './render/carSprites';
import { Hud, renderLeaderboard, escapeHtml } from './hud/hud';
import { TrackPicker, type PickableCourse } from './hud/trackPicker';
import { describeStyle, findRivalRun, nearestNeighbour, renderSectorBars, rivalLine } from './hud/results';
import { buildPersonaPicker } from './hud/personaPicker';
import { buildSensitivityControls, storedSteerFeel } from './hud/sensitivity';
import { Commentator } from './audio/commentary';
import { Sfx } from './audio/sfx';
import { unlockAudio } from './audio/context';
import { api } from './net/api';
import { MultiplayerSession } from './net/session';
import { LobbyView } from './net/lobby';
import { formatTime } from './util/math';

const TRACK_ID = 'circuit-01';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- DOM -------------------------------------------------------------------
const video = $<HTMLVideoElement>('video');
const gameCanvas = $<HTMLCanvasElement>('game');
const overlayCanvas = $<HTMLCanvasElement>('overlay');
const minimapCanvas = $<HTMLCanvasElement>('minimap');
const debugEl = $<HTMLPreElement>('debug');

const screens = {
  permission: $('screen-permission'),
  name: $('screen-name'),
  track: $('screen-track'),
  calibrate: $('screen-calibrate'),
  results: $('screen-results'),
  qr: $('screen-qr'),
};

// --- State -----------------------------------------------------------------
const hud = new Hud();
const steering = new SteeringController();
const calibrator = new Calibrator();
const commentator = new Commentator();
const sfx = new Sfx();
let picker: TrackPicker | null = null;

let tracker: HandTracker | null = null;
let race: Race | null = null;
let scene: SceneRenderer | null = null;
let overlay: OverlayRenderer;
let minimap: Minimap;
let leaderboard: RunSummary[] = [];

let wheelOpacity = 0;
/** Dev-only synthetic hand input, for previewing the wheel without a camera. */
let simulatedFrame: TrackingFrame | null = null;
let lastFrameTime = performance.now();
let lastDt = 0.016;
let renderFps = 0;
const frameStamps: number[] = [];
let debugVisible = false;
let mode: 'hands' | 'keyboard' = 'hands';
let appPhase: 'setup' | 'calibrating' | 'racing' | 'results' = 'setup';
let playerName = localStorage.getItem('buggyracer.name') ?? '';
let carColor = Number(localStorage.getItem('buggyracer.carColor') ?? '0');
let carShape = Number(localStorage.getItem('buggyracer.carShape') ?? '1');
let spritesLoaded = 0;
let sfxOn = localStorage.getItem('buggyracer.sfx') !== 'off';
/** Webcam as a corner panel (default) or as the full-screen background. Toggle with V. */
let videoPanel = localStorage.getItem('buggyracer.videoPanel') !== 'off';
let lastCountdownPip = -1;

const mp = new MultiplayerSession();
const lobby = new LobbyView({
  onJoin: (room) => { void joinRoom(room); },
  onSolo: () => { mp.leave(); proceedToRace(); },
  onStart: () => mp.requestStart(race?.geom.def.id ?? 'buggy-3lap-v1'),
  onReady: (ready) => mp.setReady(ready),
  onLeave: () => { mp.leave(); lobby.apply(mp.snapshot()); lobby.setHint(''); },
});
mp.onChange((snap) => {
  lobby.apply(snap);
  if (!race) return;
  if (snap.assignedColor != null) (race as any).opts.colorIndex = snap.assignedColor;
  if (snap.assignedShape != null) (race as any).opts.carShape = snap.assignedShape;
});
mp.onRaceStart((ev) => proceedToRace(ev.at));

function applyVideoLayout(): void {
  document.body.classList.toggle('video-panel', videoPanel);
  scene?.setHandsFade(!videoPanel);
}

/**
 * Draws the wheel over the video wherever the video is. In panel mode the
 * overlay is translated and clipped to the panel's rectangle, and drawWheel's
 * cover-fit mapping then matches the panel's own object-fit: cover crop.
 */
function drawWheelOverVideo(input: Parameters<OverlayRenderer['drawWheel']>[0], w: number, h: number): void {
  if (!videoPanel) {
    overlay.drawWheel(input, w, h);
    return;
  }
  const r = video.getBoundingClientRect();
  const ctx = overlayCanvas.getContext('2d')!;
  ctx.save();
  ctx.translate(r.left, r.top);
  ctx.beginPath();
  ctx.rect(0, 0, r.width, r.height);
  ctx.clip();
  overlay.drawWheel(input, r.width, r.height);
  ctx.restore();
}

// --- Canvas sizing ---------------------------------------------------------
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  overlayCanvas.width = Math.round(w * dpr);
  overlayCanvas.height = Math.round(h * dpr);
  overlayCanvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The game canvas is WebGL now; the renderer owns its backing size.
  scene?.resize(w, h, dpr);
}
window.addEventListener('resize', resize);

// --- Boot ------------------------------------------------------------------
async function boot(): Promise<void> {
  const geom = await loadTrack(`/tracks/${TRACK_ID}.json`);
  scene = new SceneRenderer(gameCanvas);
  applyVideoLayout();
  overlay = new OverlayRenderer(overlayCanvas.getContext('2d')!);
  resize();

  spritesLoaded = await preloadCarSprites();
  buildCarPicker();
  buildPersonaPicker(({ persona, voiceId }) => {
    commentator.persona = persona;
    commentator.voiceId = voiceId;
  });

  steering.fullLockDeg = storedSteerFeel().fullLockDeg;
  buildSensitivityControls((feel) => {
    if (race) race.steerGamma = feel.gamma;
    steering.fullLockDeg = feel.fullLockDeg;
  });

  installRace(geom);

  // Surface every commentary line on screen, cached or live, and pull the
  // effects down underneath it so the line stays intelligible.
  commentator.onLine = (text) => {
    hud.setCommentary(text);
    sfx.duck();
  };
  void commentator.init();
  sfx.init();
  sfx.setEnabled(sfxOn);
  void refreshLeaderboard();

  // Dev-only handle for tuning and debugging from the console. Not present in a
  // production build.
  if (import.meta.env.DEV) {
    (window as any).buggyracer = {
      get race() { return race; },
      get tracker() { return tracker; },
      steering,
      commentator,
      mp,
      TUNING,
      /** Feed synthetic hands so the wheel can be seen without a camera. */
      simulateHands(angleDeg: number, spread = 0.22, cy = 0.74) {
        mode = 'hands';
        steering.mode = 'hands';
        const a = (angleDeg * Math.PI) / 180;
        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 720;
        // Build the two hand anchors around the frame centre at this angle.
        const halfX = (Math.cos(a) * spread) / 2;
        const halfY = (Math.sin(a) * spread * (vw / vh)) / 2;
        simulatedFrame = {
          handCount: 2,
          left: { nx: 0.5 - halfX, ny: cy - halfY },
          right: { nx: 0.5 + halfX, ny: cy + halfY },
          rawAngle: Math.atan2(Math.sin(a) * spread * vw / vh * vh, Math.cos(a) * spread * vw),
          sample: { captureTime: performance.now(), quality: 'unavailable', inferenceMs: 0 },
        };
      },
      clearHands() {
        simulatedFrame = null;
      },
      /** Exaggerated synthetic hills in metres, for eyeballing the elevation path; 0 restores the surveyed data. */
      hills(amplitude = 8) {
        if (!race || !scene) return;
        const geom = race.geom;
        scene.setTrack(geom, amplitude ? demoHills(geom.length, amplitude) : (s) => geom.elevationAt(s));
      },
      /** Jump the car to a point on the track, for testing without driving a lap. */
      seek(distance: number) {
        if (!race) return;
        const p = race.geom.pointAt(distance);
        race.car.x = p.x;
        race.car.y = p.y;
        race.car.heading = p.heading;
        race.car.trackDistance = distance;
        race.car.lastSegmentIndex = race.geom.project(p.x, p.y).segmentIndex;
      },
    };
  }

  requestAnimationFrame(loop);
}

/**
 * Binds a course to the renderers and the race. Called once at boot and again
 * whenever a different course is chosen, so switching tracks does not need a
 * page reload.
 */
function installRace(geom: TrackGeometry): void {
  // Rebind the elevation source to THIS course. The renderer rebuilds itself
  // when the geometry changes but keeps whatever function it was last given, so
  // without this a new course is drawn using the previous one's heights.
  scene?.setTrack(geom, (s) => geom.elevationAt(s));
  minimap = new Minimap(minimapCanvas.getContext('2d')!, geom, minimapCanvas.width, minimapCanvas.height);
  race = new Race({
    trackId: geom.def.id,
    playerName: playerName || 'Anon',
    geom,
    colorIndex: carColor,
    carShape,
  });
  // Reapplied here, not once at boot: switching course builds a new Race and
  // would otherwise silently drop the player's sensitivity back to the default.
  race.steerGamma = storedSteerFeel().gamma;
  race.bus.on((e) => {
    if (!race) return;
    switch (e.type) {
      case 'collision': sfx.impact(1); break;
      case 'oil': sfx.oil(); break;
      case 'near_miss': sfx.nearMiss(); break;
      case 'race_finish':
        sfx.finish();
        mp.sendFinish(e.at);
        break;
    }
    commentator.offer(e, race.time, commentaryContext());
  });
}

/** Chosen from the picker: rebuild everything bound to the course, then go. */
function applyCourse(def: PickableCourse): void {
  installRace(new TrackGeometry(def as CourseDef));
  void race?.loadGrid();
  void refreshLeaderboard();
  screens.track.hidden = true;
  // Calibrate before the lobby so a synced start is not spent holding a pose.
  if (mode === 'hands') beginCalibration();
  else showLobby();
}

/** Fresh race context for the commentator, evaluated at the moment of speaking. */
function commentaryContext() {
  const me = race?.standings.find((s) => s.racer.isLocalPlayer);
  return {
    playerName: race?.playerName ?? 'Driver',
    position: me?.position ?? 1,
    fieldSize: race?.standings.length || 1,
    lapProgress: race ? (race.car.trackDistance % race.geom.length) / race.geom.length : 0,
    rivalName: race?.rivalName ?? undefined,
    gap: me?.gapAhead ?? undefined,
    collisions: race?.car.collisionCount ?? 0,
  };
}

async function refreshLeaderboard(): Promise<void> {
  leaderboard = await api.leaderboard(race?.geom.def.id ?? 'buggy-3lap-v1', 25);
}

// --- Setup flow ------------------------------------------------------------
if (!window.isSecureContext) {
  const err = $('permission-error');
  err.hidden = false;
  err.textContent =
    'Camera needs https:// (this is a plain http:// address). Play with arrow keys, or open the https link.';
}

$('btn-enable').addEventListener('click', async () => {
  const err = $('permission-error');
  err.hidden = true;
  try {
    await startCamera(video);
  } catch (e) {
    // A denied or missing camera gets a designed state and a working fallback,
    // never a broken layout.
    err.hidden = false;
    err.textContent = (e as Error).message?.includes('http')
      ? (e as Error).message
      : `Camera unavailable (${(e as Error).name}). Check browser permissions, or play with arrow keys.`;
    return;
  }
  mode = 'hands';
  steering.mode = 'hands';
  tracker = new HandTracker(video, () => {});
  try {
    await tracker.init();
    tracker.start();
  } catch (e) {
    err.hidden = false;
    err.textContent = `Hand tracking failed to load (${(e as Error).message}). Falling back to keyboard.`;
    mode = 'keyboard';
    steering.mode = 'keyboard';
  }
  commentator.unlock();
  unlockAudio();
  goToName();
});

$('btn-keyboard').addEventListener('click', () => {
  mode = 'keyboard';
  steering.mode = 'keyboard';
  commentator.unlock();
  unlockAudio();
  goToName();
});

$('btn-skip-calib').addEventListener('click', () => {
  mode = 'keyboard';
  steering.mode = 'keyboard';
  showLobby();
});

/** Car picker: colour swatches and body shapes, with a live preview. */
function buildCarPicker(): void {
  const colors = $('car-colors');
  const shapes = $('car-shapes');
  colors.innerHTML = '';
  shapes.innerHTML = '';

  CAR_COLOR_HEX.forEach((hex, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = `Colour ${i + 1}`;
    b.setAttribute('aria-pressed', String(i === carColor));
    b.addEventListener('click', () => {
      carColor = i;
      localStorage.setItem('buggyracer.carColor', String(i));
      refreshCarPicker();
    });
    colors.appendChild(b);
  });

  CAR_SHAPES.forEach((shape, i) => {
    const b = document.createElement('button');
    b.className = 'shape';
    b.textContent = SHAPE_LABELS[i];
    b.setAttribute('aria-pressed', String(shape === carShape));
    b.addEventListener('click', () => {
      carShape = shape;
      localStorage.setItem('buggyracer.carShape', String(shape));
      refreshCarPicker();
    });
    shapes.appendChild(b);
  });

  refreshCarPicker();
}

function refreshCarPicker(): void {
  $<HTMLImageElement>('car-preview-img').src = spriteUrl(carColor, carShape);
  Array.from($('car-colors').children).forEach((el, i) =>
    el.setAttribute('aria-pressed', String(i === carColor)),
  );
  Array.from($('car-shapes').children).forEach((el, i) =>
    el.setAttribute('aria-pressed', String(CAR_SHAPES[i] === carShape)),
  );
  if (race) {
    (race as any).opts.colorIndex = carColor;
    (race as any).opts.carShape = carShape;
  }
}

function goToName(): void {
  screens.permission.hidden = true;
  screens.name.hidden = false;
  const input = $<HTMLInputElement>('input-name');
  input.value = playerName;
  input.focus();
}

const submitName = () => {
  const input = $<HTMLInputElement>('input-name');
  playerName = (input.value.trim() || 'Anon').slice(0, 16);
  localStorage.setItem('buggyracer.name', playerName);
  screens.name.hidden = true;
  if (race) {
    (race as any).opts.playerName = playerName;
    (race as any).opts.colorIndex = carColor;
    (race as any).opts.carShape = carShape;
  }
  goToTrack();
};

/** Course selection sits between naming and calibration so the player sees the
 *  shape they are about to drive before the camera work starts. */
function goToTrack(): void {
  screens.track.hidden = false;
  if (!picker) {
    picker = new TrackPicker($('track-picker'), applyCourse);
    void picker.load();
  }
}
$('btn-name').addEventListener('click', submitName);
$<HTMLInputElement>('input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitName();
});

function beginCalibration(): void {
  appPhase = 'calibrating';
  calibrator.reset();
  screens.calibrate.hidden = false;
  hud.hide();
}

function showLobby(): void {
  appPhase = 'setup';
  screens.calibrate.hidden = true;
  screens.results.hidden = true;
  hud.hide();
  lobby.show();
  lobby.apply(mp.snapshot());
}

async function joinRoom(room: string): Promise<void> {
  const ok = await mp.join(room, playerName, carColor, carShape);
  if (!ok) return;
  const health = await api.health();
  const lan = health?.lan ?? [];
  const port = location.port ? `:${location.port}` : '';
  lobby.setHint(
    lan.length
      ? `On this Wi-Fi: ${location.protocol}//${lan[0]}${port} — join room "${room}".`
      : `Share this page and room "${room}".`,
  );
}

function proceedToRace(syncedAt?: number): void {
  lobby.hide();
  startRace(syncedAt);
}

function startRace(syncedAt?: number): void {
  appPhase = 'racing';
  screens.calibrate.hidden = true;
  screens.results.hidden = true;
  steering.reset();
  hud.clearMarkers();
  hud.show();
  commentator.resetForRace();
  lastCountdownPip = -1;
  sfx.start();
  race!.start();
  // Server `at` is GO; trim the local countdown so every client lights out together.
  if (syncedAt != null) {
    race!.countdown = Math.max(0, (syncedAt - Date.now()) / 1000);
  }
}

// --- Main loop -------------------------------------------------------------
function loop(now: number): void {
  requestAnimationFrame(loop);

  // The rAF timestamp approximates when the frame we drew last time was
  // presented, which closes the latency measurement.
  tracker?.latency.framePresented(now);

  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  lastDt = dt;
  frameStamps.push(now);
  while (frameStamps.length > 1 && now - frameStamps[0] > 1000) frameStamps.shift();
  renderFps = frameStamps.length;

  const frame = simulatedFrame ?? tracker?.lastFrame ?? null;

  if (appPhase === 'calibrating') {
    updateCalibration(frame, dt);
  } else if (appPhase === 'racing' && race) {
    race.remoteStates = mp.sampleRemotes(now);
    const steer = steering.update(frame, now / 1000, dt);
    race.update(dt, steer);
    if (race.phase === 'countdown' || race.phase === 'racing') {
      mp.pumpState(now, {
        x: race.car.x,
        y: race.car.y,
        heading: race.car.heading,
        trackDistance: race.car.trackDistance,
        lapProgress: ((race.car.trackDistance % race.geom.length) + race.geom.length) % race.geom.length / race.geom.length,
        lap: race.lap,
      });
    }
    renderRace(dt);
    if (race.phase === 'finished') void showResults();
  }

  if (frame) tracker?.latency.renderSubmitted(frame.sample);
  if (debugVisible) updateDebug();
}

function updateCalibration(frame: TrackingFrame | null, dt: number): void {
  const neutral = calibrator.update(frame, dt);
  $('calib-message').textContent = calibrator.message;
  const ring = $('calib-ring');
  ring.style.strokeDashoffset = String(327 * (1 - calibrator.progress));
  $('calib-sub').textContent =
    frame && frame.handCount >= 2 ? 'Tracking both hands' : 'Both hands must be visible';

  // Render the wheel during calibration too, so the player can see tracking is
  // live before the race rather than discovering it is not during one.
  const w = window.innerWidth;
  const h = window.innerHeight;
  overlay.clear(w, h);
  wheelOpacity += (((frame?.handCount ?? 0) >= 2 ? 1 : 0) - wheelOpacity) * Math.min(1, dt * 8);
  drawWheelOverVideo(
    { left: frame?.left ?? null, right: frame?.right ?? null, opacity: wheelOpacity, videoW: video.videoWidth, videoH: video.videoHeight, oiled: false },
    w, h,
  );

  if (neutral !== null) {
    steering.calibrate(neutral);
    showLobby();
  }
}

function renderRace(dt: number): void {
  if (!race || !scene) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const frame = simulatedFrame ?? tracker?.lastFrame ?? null;

  const racers = race.buildRacerStates();
  scene.render({
    geom: race.geom,
    racers,
    localTrackDistance: race.car.trackDistance,
    offTrack: race.car.offTrack,
    oiled: race.oiled,
    shake: race.shake,
  });

  overlay.clear(w, h);
  overlay.drawEffects({ offTrack: race.car.offTrack, oiled: race.oiled, flash: race.flash }, w, h);

  // Fade the wheel rather than snapping it away - a wheel that flickers on every
  // missed frame looks broken even when the game is fine.
  const target = mode === 'hands' && steering.handsVisible ? 1 : 0;
  wheelOpacity += (target - wheelOpacity) * Math.min(1, dt * 6);
  if (mode === 'hands') {
    drawWheelOverVideo(
      { left: frame?.left ?? null, right: frame?.right ?? null, opacity: wheelOpacity, videoW: video.videoWidth, videoH: video.videoHeight, oiled: race.oiled },
      w, h,
    );
  }

  // --- Audio ---
  // Flush any queued commentary as soon as the debounce window opens.
  commentator.tick(race.time, commentaryContext());
  const speedFactor = race.car.collisionPenalty * (race.car.offTrack ? TUNING.OFF_TRACK_SPEED_FACTOR : 1);
  sfx.update(speedFactor, race.car.offTrack, race.oiled, race.phase === 'racing');
  if (race.phase === 'countdown') {
    const pip = Math.ceil(race.countdown);
    if (pip !== lastCountdownPip && pip > 0) {
      lastCountdownPip = pip;
      sfx.beep(false);
    }
  } else if (lastCountdownPip !== 0 && race.phase === 'racing') {
    lastCountdownPip = 0;
    sfx.beep(true);
  }

  // --- HUD ---
  if (race.phase === 'countdown') hud.setCountdown(race.countdown);
  else if (race.phase === 'racing' && race.time < 0.8) hud.setCountdown(0);
  else hud.setCountdown(null);

  hud.setWarnings(mode === 'hands' && !steering.handsVisible && race.phase !== 'countdown', race.car.offTrack);

  const me = race.standings.find((s) => s.racer.isLocalPlayer);
  hud.updateStats(
    race.time,
    me?.position ?? 1,
    race.standings.length || 1,
    race.car.collisionCount,
    race.pbDelta,
  );
  hud.updateStandings(race.standings);
  hud.updateProgress(race.standings);
  minimap.render(racers);
}

// --- Results ---------------------------------------------------------------
let resultsShown = false;
async function showResults(): Promise<void> {
  if (resultsShown || !race) return;
  resultsShown = true;
  appPhase = 'results';
  hud.hide();

  // The run is saved asynchronously; without waiting for it the rank and the
  // nearest-neighbour exclusion both read stale nulls.
  await race.savePromise;

  const total = race.time;
  $('res-time').textContent = formatTime(total);
  $('res-hits').textContent = String(race.car.collisionCount);
  $('res-off').textContent = `${race.car.offTrackDuration.toFixed(1)}s`;
  $('res-rank').textContent = race.savedRank ? `#${race.savedRank}` : '--';
  screens.results.hidden = false;

  await refreshLeaderboard();
  const rivalRun = findRivalRun(race.matchedRuns, race.rivalName);
  $('res-rival').innerHTML = rivalLine(race.rivalName, total, rivalRun?.totalTime ?? null);
  renderSectorBars($('res-sectors'), race.sectorTimes, rivalRun?.sectorTimes ?? null, race.rivalName ?? 'your rival');

  $('res-style').textContent = describeStyle(
    {
      avgSteeringMagnitude: race.car.steerSamples ? race.car.steerSum / race.car.steerSamples : 0,
      collisionCount: race.car.collisionCount,
      offTrackDuration: race.car.offTrackDuration,
      sectorTimes: race.sectorTimes,
    },
    leaderboard,
  );

  const nn = nearestNeighbour(race.sectorTimes, leaderboard, race.savedRunId);
  $('res-like').textContent = nn ? `You drive most like ${nn.name}.` : '';

  renderLeaderboard($<HTMLOListElement>('res-leaderboard'), leaderboard, race.savedRunId);
}

$('btn-again').addEventListener('click', () => restart());

function restart(): void {
  if (!race) return;
  resultsShown = false;
  screens.results.hidden = true;
  screens.qr.hidden = true;
  if (mp.inRoom) {
    mp.returnToLobby();
    showLobby();
    return;
  }
  void race.loadGrid();
  if (mode === 'hands' && !steering.calibrated) beginCalibration();
  else startRace();
}

// --- QR share --------------------------------------------------------------
$('btn-qr').addEventListener('click', async () => {
  screens.qr.hidden = false;
  const url = location.origin;
  $('qr-url').textContent = url;
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url, { width: 220, margin: 1 });
  const holder = $('qr-code');
  holder.innerHTML = '';
  holder.appendChild(canvas);

  await refreshLeaderboard();
  renderLeaderboard($<HTMLOListElement>('qr-leaderboard'), leaderboard, race?.savedRunId ?? null);
});
$('btn-qr-close').addEventListener('click', () => {
  screens.qr.hidden = true;
});

// --- Keys ------------------------------------------------------------------
steering.attachKeyboard();
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    debugVisible = !debugVisible;
    debugEl.hidden = !debugVisible;
  }
  // One-click full reset. Non-negotiable for repeated demos.
  if ((e.key === 'r' || e.key === 'R') && appPhase !== 'setup') restart();
  if (e.key === 'v' || e.key === 'V') {
    videoPanel = !videoPanel;
    localStorage.setItem('buggyracer.videoPanel', videoPanel ? 'on' : 'off');
    applyVideoLayout();
  }
  if (e.key === 'm' || e.key === 'M') {
    sfxOn = !sfxOn;
    sfx.setEnabled(sfxOn);
    localStorage.setItem('buggyracer.sfx', sfxOn ? 'on' : 'off');
  }
  if (e.key === 'k' || e.key === 'K') {
    mode = mode === 'hands' ? 'keyboard' : 'hands';
    steering.mode = mode;
  }
});

// --- Debug overlay ---------------------------------------------------------
function updateDebug(): void {
  const l = tracker?.latency;
  const lines = [
    `fps        ${renderFps} render / ${tracker?.fps ?? 0} camera  (dt ${(lastDt * 1000).toFixed(1)}ms)`,
    `hands      ${tracker?.handCount ?? 0}/2 ${steering.handsVisible ? '' : '(holding last)'}`,
    `latency    ${l && l.lastMs ? l.lastMs.toFixed(1) + ' ms' : 'n/a (keyboard)'}  p50 ${l && l.p50 ? l.p50.toFixed(1) : '--'}  p95 ${l && l.p95 ? l.p95.toFixed(1) : '--'}`,
    `  source   ${l?.label ?? 'n/a - no camera'}`,
    `inference  ${tracker ? tracker.inferenceMs.toFixed(1) : '--'} ms`,
    `render     ${scene ? `${scene.stats.renderMs.toFixed(1)} ms submit, ${scene.stats.calls} draw calls, ${scene.stats.triangles} tris` : '--'}`,
    `steer      raw ${steering.raw.toFixed(3)}  smooth ${steering.value.toFixed(3)}${race ? `  gamma ${race.steerGamma.toFixed(2)}` : ''}  lock ${steering.fullLockDeg.toFixed(0)}deg`,
    `mode       ${mode}${steering.calibrated ? ' (calibrated)' : ''}  video ${videoPanel ? 'panel' : 'fullscreen'} (V)`,
    race ? `race       ${race.phase} t=${race.time.toFixed(2)} s=${race.car.trackDistance.toFixed(0)}/${race.geom.length.toFixed(0)}` : '',
    race ? `penalty    speed x${(race.car.collisionPenalty * (race.car.offTrack ? TUNING.OFF_TRACK_SPEED_FACTOR : 1)).toFixed(2)}${race.oiled ? ' OILED' : ''}` : '',
    `audio      sfx ${sfxOn ? 'on' : 'off'} (M)  ${commentator.phraseCount} phrases`,
    `cars       ${spritesLoaded}/25 sprites  (you: colour ${carColor} shape ${carShape})`,
    `commentary ${commentator.phraseCount} cached phrases`,
    `backend    ${api ? 'ready' : ''}`,
    `multiplayer ${mp.inRoom ? `room=${mp.snapshot().room} ${mp.snapshot().players.length}p` : 'solo'} ${mp.snapshot().connected ? 'ws' : 'offline'} remotes=${mp.remotes.size}`,
  ];
  debugEl.textContent = lines.filter(Boolean).join('\n');
}

void boot();
