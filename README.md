# Buggy Racer

A browser racing game steered with your hands. Hold them up as if gripping an
invisible wheel; a webcam tracks them and the angle between them steers the car.
Your live video is the background of the whole screen, and the wheel is drawn
into your actual hands.

Speed is constant. There is no throttle, brake or gearshift - steering is the
only input, by design.

Every completed run is recorded as a ghost, so later players race the people who
played before them. Ghosts are pace-matched to your projected finishing time, so
races stay close instead of ending in the first corner.

---

## Quick start

```bash
npm install
npm run fetch-assets     # self-hosts the MediaPipe wasm + hand model (~18MB)
npm run dev              # client on :5173, API on :8787
```

Open <http://localhost:5173>. `localhost` counts as a secure context, so the
camera works without TLS locally. Anywhere else needs real HTTPS.

Optional, but worth doing before a demo:

```bash
npm run seed             # 24 synthetic opponents so matchmaking has a field
npm run phrases          # pre-generates the commentary audio (needs an ElevenLabs key)
```

### Keys

Copy `.env.example` to `.env`. Everything is optional - with no keys at all the
game is fully playable, just without persistence or commentary.

The server loads `.env`, then `.env.local`. Real environment variables win over
both, which is how the container is configured with no file at all. Both are
gitignored.

| Key | Effect if missing |
|---|---|
| `DATA_FILE` | Runs are written to `data/runs.json` |
| `GEMINI_API_KEY` | No live commentary text; the cached phrase bank still plays |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | No new audio; existing cached phrases still play |

---

## Controls

| Key | Action |
|---|---|
| Hands | Rotate both hands like a steering wheel |
| `←` `→` / `A` `D` | Keyboard steering (backup if a camera fails) |
| `R` | Restart the run immediately |
| `D` | Toggle the debug overlay |
| `K` | Switch between hand and keyboard steering |
| `M` | Mute or unmute sound effects |

### Choosing a commentator

The name screen carries a **Commentator** picker: five personas (hype, deadpan,
rival, nature documentary, pirate) defined in
[`shared/personas.ts`](shared/personas.ts), plus a voice dropdown populated from
whatever voices the ElevenLabs account actually has - free plans can only
synthesise with voices added to the account, so a hardcoded id fails at
synthesis time.

The persona changes the commentator's character and delivery, never the facts:
it is spliced onto a base prompt that still carries the event vocabulary and the
rule that there is no throttle, brake or gearbox. Both choices persist in
`localStorage`. With no ElevenLabs key the dropdown stays hidden and everything
else works unchanged.

---

## Tuning

Every constant worth changing is in one block at the top of
[`client/src/game/physics.ts`](client/src/game/physics.ts). Nothing else in the
codebase defines gameplay numbers.

The three that matter most, in the order you should reach for them:

1. **`TRACK_WIDTH`** - if anyone finds the controls hard, widen the track. Then
   widen it again. It is currently 16m, ten times the car's width, and it is the
   width of every course: bundled ones and routes pasted from Google Maps alike.
2. **`MAX_TURN_RATE`** - how sharply the car responds at full lock.
3. **`ONE_EURO_MIN_CUTOFF`** / **`ONE_EURO_BETA`** - steering smoothing. If
   steering feels laggy, *reduce smoothing before anything else*, and measure the
   change in the debug overlay rather than guessing.

### A constraint the track must satisfy

There is no brake, so a corner tighter than the car's minimum turn radius is
impossible to take, not merely hard. After editing the track, check it:

```bash
npm run track:info                     # length, sectors, obstacle count
npx tsx scripts/diag/curvature.ts      # tightest corner vs the car's turn radius
```

Keep the ratio above roughly 2x. The shipped track is 2.11x. An earlier version
was 0.98x, which forced every driver off the track at one corner - the symptom
was every AI run bleeding 2-10 seconds off-track, not an obvious crash.

### Editing the track

[`client/public/tracks/circuit-01.json`](client/public/tracks/circuit-01.json)
is meant to be edited by hand:

- `centerline` is a short list of **control points**, smoothed into a drivable
  polyline by a closed Catmull-Rom spline at load. Move these to reshape the
  circuit. Note the spline overshoots through tightly-spaced points, so the drawn
  curve is sharper than the points look - always re-run the curvature check.
- `obstacles` are placed in **track-relative** coordinates: `s` is distance along
  the centerline from the start line, `d` is lateral offset (positive is right of
  travel). This is far easier to author than raw x/y, and it survives reshaping.
- Types are `cone` (speed penalty), `oil` (inverts steering ~1.5s, no speed
  penalty) and `gate` (a pair of posts with a `gap` between them).

---

## How it fits together

```
client/src/
  game/        physics, track geometry, race orchestration, ghosts, event bus
  tracking/    MediaPipe hand tracking, one-euro filter, calibration, latency
  render/      windshield projection, scene, wheel overlay, minimap, car sprites
  hud/         DOM HUD and the results screen
  audio/       commentary (phrase bank + live) and procedural sound effects
server/src/    Express API, JSON file store, Gemini + ElevenLabs proxies
shared/        types used by both sides
```

Two boundaries are load-bearing:

**`RacerState` is the only shape the HUD ever sees.** The standings list,
minimap, progress bar and stats panel cannot tell whether a car is the local
player, a replayed ghost or a networked opponent. Adding real multiplayer is a
data-source swap, not a rewrite.

**The world model is strictly 2D top-down; the windshield is a render-time
projection.** Physics, collision, track distance, ghost recording and the minimap
all work in world coordinates. `render/projection.ts` is the only file that knows
about perspective. Keeping view maths out of game state is what stops ghost data
from being contaminated by camera changes.

---

## Latency

Input-to-render latency is the quality metric that matters most, so it is
measured rather than estimated. Press `D` to see it.

The measurement uses `requestVideoFrameCallback`: for a camera source,
`metadata.captureTime` is when the sensor captured the frame, so

```
latency = presentation time of our rendered frame - captureTime of the frame we inferred on
```

is a genuine photon-to-photon number. Where `captureTime` is unavailable the
overlay falls back to `presentationTime` and **says so on the line below**,
rather than quietly reporting a different quantity.

**The camera usually dominates, not the code.** Inference is ~12-17ms on GPU. A
30fps webcam contributes ~33ms of frame cadence before anything else, plus
typical sensor and USB latency. The game requests 60fps to halve the cadence
term. If p50 is above 100ms on your machine, check the camera before optimising
anything.

---

## Known limitations

- **`requestVideoFrameCallback` is Chrome and Safari only.** Firefox falls back
  to a `requestAnimationFrame` loop and the latency figure becomes an estimate.
  Demo on Chrome.
- **MediaPipe has no lightweight hand model.** Only one public bundle exists, and
  the 21-landmark output is not optional. The levers are the GPU delegate and
  decoupling inference rate from render rate, both already applied.
- **ElevenLabs free tier is ~10,000 credits a month** and Flash bills 0.5 credits
  per character, so live generation alone covers roughly a dozen races. The
  pre-generated phrase bank is therefore the primary path and live generation is
  capped at 4 calls per race; the server also enforces `TTS_CHAR_BUDGET`.
- **The commentator persona colours live lines only.** The phrase bank was
  synthesised once in the `hype` register and is not regenerated per persona -
  that would cost roughly a thousand credits each. So a non-default persona is
  heard on the handful of contextual moments per race, and the common events
  keep the house voice. Picking `hype` is the one fully consistent option.
- **Live TTS goes through the server rather than a direct browser WebSocket.**
  The token-minting endpoint for the lower-latency direct path exists
  (`/api/tts-token`) but is unverified, so the reliable HTTP path is wired up.
  Cached phrases play instantly either way.
- **Gemini 3.x rejects `thinkingBudget`.** Use `thinkingLevel`. At `medium` the
  model returns an *empty* string because reasoning consumes the output budget.
- **Runs live in one JSON file, not a database.** An Atlas backend used to sit
  behind the same interface; the Data API reached end-of-life on 30 September
  2025, so the browser could never reach it anyway, and a leaderboard this size
  does not need a network hop. Mount a volume at the store's directory or the
  leaderboard dies with the container.
- **Ghosts never collide** with anything, including each other. They are purely
  visual, by design.

## Before demoing somewhere new

- **Check the composition in the actual room.** Test against a bright window
  behind the player, a dark room, and people walking behind them - all three
  happen at a venue. If the track edge is ever hard to see, darken the top of the
  gradient in `#scrim` (`client/src/styles.css`).
- **Measure latency on the demo machine** with `D`. Expect the webcam to dominate,
  not the code.
- **Reset the field between sessions**, keeping the synthetic opponents:
  ```bash
  curl -X POST https://YOUR-DOMAIN/api/reset \
    -H 'content-type: application/json' \
    -d '{"trackId":"circuit-01","keepSynthetic":true}'
  ```
  Note `npm run seed` *adds* to the field rather than replacing it.

## Credits

Car sprites from the [Kenney Racing Pack](https://kenney.nl/assets/racing-pack),
CC0. See `client/public/cars/LICENSE.txt`.

The CMU Buggy Course geometry is derived from **OpenStreetMap** data.
© OpenStreetMap contributors, licensed under the
[Open Database Licence](https://www.openstreetmap.org/copyright) (ODbL).
Elevation data from [Open-Meteo](https://open-meteo.com/).

ODbL is share-alike: the derived track in `client/public/tracks/` carries the
same attribution in its own `attribution` field, and any redistribution of that
geometry - or of a database derived from it - must keep the credit and stay
under ODbL. This is a licence condition, not a courtesy.
