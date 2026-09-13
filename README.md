# Buggy Racer

Handsfree(?) racing game.

Hold both hands up as if gripping an invisible wheel; a webcam tracks them and
the angle between them steers the car. Steering is the only input.

## Local development

```bash
bun install
bun run fetch-assets     # self-hosts the MediaPipe wasm + hand model (~18MB)
bun run dev              # client on :5173, API on :8787
```

Open <http://localhost:5173>. `localhost` counts as a secure context, so the
camera works without TLS locally. Anywhere else needs real HTTPS.

Optional:

```bash
bun run seed             # 24 synthetic opponents so matchmaking has a field
bun run phrases          # pre-generates commentary audio (needs an ElevenLabs key)
```

Copy `.env.example` to `.env` if you want persistence or commentary. Every key
is optional — with none set the game is fully playable.

Before pushing:

```bash
bun run typecheck
bun run build
bun run diag
bun run check:secrets
```

## Credits

Car sprites from the [Kenney Racing Pack](https://kenney.nl/assets/racing-pack),
CC0. See `client/public/cars/LICENSE.txt`.

The CMU Buggy Course geometry is derived from **OpenStreetMap** data.
© OpenStreetMap contributors, licensed under the
[Open Database Licence](https://www.openstreetmap.org/copyright) (ODbL).
Elevation data from [Open-Meteo](https://open-meteo.com/).

ODbL is share-alike: any redistribution of that geometry — or of a database
derived from it — must keep the credit and stay under ODbL. This is a licence
condition, not a courtesy.
