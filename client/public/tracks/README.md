# CMU Buggy Course

© OpenStreetMap contributors. Street geometry is available under the Open
Database License (ODbL): https://www.openstreetmap.org/copyright . Elevation data
comes from Open-Meteo. The attribution is also embedded in the track JSON.

Regenerate with `node scripts/convert-buggy.mjs <git-ref>`; the JSON records the
source revision. The default ref is `origin/aden`. World coordinates and widths
are metres. Physics remains on the ground plane.

The converter rotates by ground distance at `finishAt = 0.8564`, resamples at
approximately 3m spacing to prevent spline overshoot at the inserted start line,
and preserves elevation in a parallel array. Runtime length is about 1623m.
There are nine distinct section names, with FINISH STRAIGHT split across the
start line, giving ten splits per lap - and a race is one lap.

Integration handoff:

- Renderer: `TrackGeometry.elevationAt(s)` interpolates render-only height;
  `def.elevation` parallels control points. Camera distances and decorations must
  use metres. The existing pixel-scale renderer still needs Agent A's port.
- HUD: `Race.lap`, `Race.laps`, `Race.sectionName`, and
  `TrackGeometry.sectionNameAt(s)` provide display values. `lap_complete` carries
  `{lap, laps}`; `sector_time` carries `{sector, lap, section, split}`. Agent D
  should display the attribution above in the game and project docs.
- Multiplayer: construct `new TrackGeometry(def, roomSeed)` before creating the
  race to select deterministic obstacles. The default seed is in the JSON.
- Persistence: use `geom.def.id` (`buggy-3lap-v1`), not the asset filename
  `circuit-01`. The new ID isolates incompatible old paths without deleting them.
  Room-specific obstacle layouts share this ghost pool; ghosts remain visual.
- Tuning: speed is 30m/s, car width 1.6m. Road width is not surveyed per course
  any more - `TUNING.TRACK_WIDTH` sets it for every course.
  Full-lock turn rate is 34rad/s to satisfy the measured 1.94m return corner
  (2.19× margin). This aggressive setting needs human hand-steering playtesting.

Verification: typecheck, build, and the curvature, knockback, recorder and
multilap diagnostics. The additional diagnostic checks late/backward ghost
seeks, finish ordering, seeded layouts, sections, elevation and lap events.

`bun run seed` generates 24 deterministic opponents. Optional
`SEED_DRY_RUN=1` skips upload; `SEED_OUTPUT=/tmp/field.json` saves the generated
field. Failed finishes, collision-heavy drivers and implausibly slow runs are
rejected. Local integration seeding uses port 18787 with file store
`data/buggy-runs.json`; production needs its own reseed after integration.

The optional fantasy course is deferred.

# Shakedown Run

The one course here that is not a real place. It is drawn by
`node scripts/draw-course.mjs --id shakedown --name "Shakedown Run"`: a long arc
with a sine meander on its normal, point to point rather than a loop, and with
no obstacle seed, so no cones.

It exists because the surveyed courses ask for 22% to 45% of full lock at their
tightest corner, which is a lot from someone still learning to steer with their
hands. This one peaks at 2% and carries nothing to hit. The `--amp` flag scales
the meander and is the difficulty knob; the script prints the tightest radius it
produced, and `scripts/diag/curvature.ts` prints it for every course side by
side. Everything else about it is normal - `TUNING.TRACK_WIDTH` and
`TUNING.LAPS` apply here as they do everywhere.
