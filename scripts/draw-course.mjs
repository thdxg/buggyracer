#!/usr/bin/env bun
/**
 * Draws a gentle point-to-point course. Nothing is surveyed here: the shape is
 * a formula, because the easy course has to be easy by construction and no real
 * road is.
 *
 *   bun scripts/draw-course.mjs --id shakedown --name "Shakedown Run"
 *
 * The shape is a long arc with a sine meander laid along its normal. Both sines
 * start and finish at a zero crossing, where a sine has no curvature, so the
 * run opens and closes straight without an envelope forcing it - an envelope
 * ramping the meander in or out puts the tightest corner of the course at the
 * start line or the finish, which is exactly where it is least welcome.
 *
 * `--amp` is the difficulty knob, and the only one worth turning: it scales the
 * meander, so the tightest corner tightens with it. The script prints the
 * tightest radius and what fraction of full lock it demands; keep that demand
 * far below the ~45% the surveyed courses ask for, or this stops being the
 * gentle one. Coordinates are metres, matching every other course.
 */
import { writeFileSync } from 'node:fs';
import { resample, scaleToLength, centreOn, shapeReport, selfClearance, densify, pathLength } from '../shared/course.ts';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const id = arg('id');
const name = arg('name');
const amp = Number(arg('amp', 0.6));
const speed = Number(arg('speed', 30));
const lapSeconds = Number(arg('lap', 35));
const sectorCount = Number(arg('sectors', 5));
if (!id || !name) {
  console.error('need --id --name [--amp 0.6] [--lap 35]');
  process.exit(1);
}

const SAMPLES_PER_SEGMENT = 14;
const DRAWN_LENGTH = 1200;   // metres before normalising; only the shape survives
const ARC_RADIUS = 460;      // bends the whole run into a C so it is not a ribbon
const WAVELENGTHS = [600, 200];
const AMPLITUDES = [70, 9];

const path = [];
for (let i = 0; i <= 8000; i++) {
  const t = (i / 8000) * DRAWN_LENGTH;
  const th = t / ARC_RADIUS;
  let offset = 0;
  for (let k = 0; k < WAVELENGTHS.length; k++) {
    offset += amp * AMPLITUDES[k] * Math.sin((2 * Math.PI * t) / WAVELENGTHS[k]);
  }
  // Tangent is (cos th, sin th), so the left normal is (-sin th, cos th).
  path.push({
    x: ARC_RADIUS * Math.sin(th) - Math.sin(th) * offset,
    y: ARC_RADIUS * (1 - Math.cos(th)) + Math.cos(th) * offset,
  });
}

const control = resample(path, 48, false).map((p) => [p.x, p.y]);
const scaled = centreOn(scaleToLength(control, speed * lapSeconds, SAMPLES_PER_SEGMENT, false), { x: 0, y: 0 });
const dense = densify(scaled, SAMPLES_PER_SEGMENT, false);
const report = shapeReport(scaled, SAMPLES_PER_SEGMENT, false, speed, 1);

const def = {
  id,
  name,
  closed: false,
  sectorCount,
  samplesPerSegment: SAMPLES_PER_SEGMENT,
  centerline: scaled.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
  // No seed, so no cones. The gentle course is gentle all the way down.
  obstacles: [],
  meta: {
    lapSeconds: +(report.length / speed).toFixed(1),
    minRadius: +report.minRadius.toFixed(2),
    pr: Math.round(report.pr),
    clearance: +selfClearance(dense, false).toFixed(1),
  },
};

const out = `client/public/tracks/${id}.json`;
writeFileSync(out, JSON.stringify(def, null, 2) + '\n');
console.log(
  `${out}  drawn ${Math.round(pathLength(path, false))}m -> ${report.length.toFixed(0)}m  ` +
  `${def.meta.lapSeconds}s point to point  minRadius ${def.meta.minRadius}m  P/r ${def.meta.pr}  ` +
  `clearance ${def.meta.clearance}m`,
);
