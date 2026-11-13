# WebSolid

A parametric part modeler that runs in the browser. Sketch a profile, add holes,
extrude to a solid, read real mass properties, and export STL / DXF / an SVG
drawing sheet. Parts are stored server-side in Postgres.

Live: https://websolid.untasked.run

## What it does

- **Sketch** — rectangle, circle, polygon or a pasted SVG path / whole SVG file,
  with horizontal, vertical and equal constraints that re-solve on edit.
- **Extrude** — depth, direction and draft, with the feature tree updating live.
- **Holes** — through holes plus counterbore and countersink seats, patterns,
  mirrors, min-wall clearance checks and cosmetic thread callouts.
- **Edits** — planar-face push/pull, chamfer, and keyboard dimension entry.
- **Readouts** — volume, mass, surface area, bounding box, section cut with kept
  and removed volume, cost estimate and printability checks (FDM / resin).
- **Equations** — named variables and expressions that drive any dimension.
- **Export** — binary STL, DXF R12 of the active sketch, CSV bill of materials,
  and an A3 SVG drawing sheet with top / front / right views and a title block.
- **Feature history** — every parametric edit is recorded as a labeled step and
  can be replayed, so a model can be rebuilt from its macro.

## Stack

- `server.js` — Express + `pg`. Serves the static SPA and a JSON API:
  - `GET /healthz` — DB ping
  - `GET /api/parts`, `GET /api/parts/:id`, `POST /api/parts` — parts library
  - `GET /api/state` — projects, tasks, sessions, stats (workspace planner)
- `public/` — dependency-free SPA plus modules:
  - `cad.html` / `cad.css` / `cad.js` — shell, styles, modeler and 3D viewport
  - `svgimport.js` — SVG path and document import (pure functions, unit tested)
  - `equations.js` — expression store and dependency resolution
  - `printability.js` — mesh checks for FDM and resin printers
- `Dockerfile` — node:20-alpine, port 8080.
- `untasked.yaml` — `web.dockerfile`, `web.port` 8080, `web.health` `/healthz`.

The schema is created at boot with `MIGRATION_DATABASE_URL` (owner role) and
granted to the runtime role, because the hosted runtime user has no `CREATE`
on the schema.

## Run locally

```bash
docker compose up --build   # http://localhost:8080
```
