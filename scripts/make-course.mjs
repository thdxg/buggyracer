#!/usr/bin/env bun
/**
 * Builds a bundled course from a closed OpenStreetMap way (a park perimeter,
 * a plaza, a lake shore). Closed ways are used rather than road-graph loops
 * because they are already simple closed curves - no cycle search, no
 * self-intersection to reject.
 *
 *   bun scripts/make-course.mjs --id garden --name "Public Garden" \
 *     --bbox 42.348,-71.076,42.362,-71.056 --way "Boston Public Garden"
 *
 * Coordinates are metres centred on origin, matching the surveyed Buggy Course.
 */
import { writeFileSync } from 'node:fs';
import { resample, scaleToLength, centreOn, shapeReport, projectLatLon, pathLength } from '../shared/course.ts';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const id = arg('id');
const name = arg('name');
const bbox = arg('bbox');
const wayName = arg('way');
const speed = Number(arg('speed', 30));
const lapSeconds = Number(arg('lap', 35));
const sectorCount = Number(arg('sectors', 5));
if (!id || !name || !bbox || !wayName) {
  console.error('need --id --name --bbox lat1,lon1,lat2,lon2 --way "OSM name"');
  process.exit(1);
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const query = `[out:json][timeout:25];
(way["name"="${wayName}"](${bbox}););
out geom;`;

let elements = null;
const failures = [];
// Public Overpass instances are busy and rate-limited, so sweep the mirrors a
// few times with backoff rather than failing on the first 429 or 504.
outer: for (let attempt = 0; attempt < 3 && !elements; attempt++) {
  if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt));
  for (const url of ENDPOINTS) {
    try {
      // Overpass wants a form-encoded `data` field and a real User-Agent;
      // a raw body earns a 406, and an anonymous one gets refused.
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'buggyracer-course-builder/1.0' },
      });
      if (!res.ok) {
        failures.push(`${new URL(url).hostname} ${res.status}`);
        continue;
      }
      elements = (await res.json()).elements;
      break outer;
    } catch (err) {
      failures.push(`${new URL(url).hostname} ${err.message}`);
    }
  }
}
if (!elements) throw new Error(`every Overpass mirror failed: ${failures.join(', ')}`);

const closed = elements.filter(
  (w) => w.geometry?.length > 4 &&
    w.geometry[0].lat === w.geometry.at(-1).lat &&
    w.geometry[0].lon === w.geometry.at(-1).lon,
);
if (!closed.length) throw new Error(`no closed way named "${wayName}" in that bbox`);
const way = closed.sort((a, b) => b.geometry.length - a.geometry.length)[0];

const ring = way.geometry.slice(0, -1);
const lat0 = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
const lon0 = ring.reduce((a, p) => a + p.lon, 0) / ring.length;
const metres = projectLatLon(ring.map((p) => [p.lon, p.lat]), lat0, lon0);

const sourceMetres = Math.round(pathLength(metres, true));
const control = resample(metres, 48, true).map((p) => [p.x, p.y]);
const scaled = centreOn(scaleToLength(control, speed * lapSeconds, 14, true), { x: 0, y: 0 });
const report = shapeReport(scaled, 14, true, speed, 1);

const def = {
  id,
  name,
  sectorCount,
  samplesPerSegment: 14,
  centerline: scaled.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
  obstacles: [],
  obstacleSeed: 1,
  attribution: '© OpenStreetMap contributors (ODbL).',
  meta: {
    sourceMetres,
    lapSeconds: +(report.length / speed).toFixed(1),
    minRadius: +report.minRadius.toFixed(2),
    pr: Math.round(report.pr),
    osmWay: way.id,
  },
};

const out = `client/public/tracks/${id}.json`;
writeFileSync(out, JSON.stringify(def, null, 2) + '\n');
console.log(
  `${out}  ${sourceMetres}m real -> ${report.length.toFixed(0)}m  ` +
  `lap ${def.meta.lapSeconds}s  minRadius ${def.meta.minRadius}m  P/r ${def.meta.pr}`,
);
