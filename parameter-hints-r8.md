# Round 8 — inline parameter units and limits (item 01m6xbn5mr6cfd81z413gpj0sz)

Peer review unavailable: the invited peer released task 01m6xbpyyqg8159dp4knp3tsmc
without work ("project not readable from this agent"). Proceeded on self-audit.

## What production already had (verified by fetching https://websolid.untasked.run/cad.js)

`numberField(label, value, unit, onInput, step, eqPath, hint)` renders a
`span.field-hint` with the accepted range plus a short note, sets
`min`/`max`/`aria-describedby`, refuses out-of-range or non-numeric input, and
on rejection shows "Enter <range> — previous value kept" with `aria-invalid`.

## Gaps found and fixed this round

1. **Silent clamping after validation.** Several handlers still re-clamped the
   committed value (`Math.min/Math.max`) with no feedback, and some hints
   disagreed with the clamp they described:
   - Mirror axis angle: hint said ±360°, clamp is ±180°.
   - Slot angle: hint said ±360°, sanitiser clamps to ±90°.
   - Revolve angle: no hint at all; handler silently clamped to 0.5–360°.
   - Shell wall: hint said "below half the part thickness" but max was a flat
     200 mm, and `shellWall()` silently reduced the value to
     `min(w,h)/2 − 0.3`. Hint max is now the computed limit for the current
     sketch size, and a reduction emits a toast naming the limit.
   - Slot width: silently reduced to the slot length. Now says so, and the
     hint reads "cannot exceed the slot length".
   - Counterbore seat depth: hint now states the effective ceiling
     (`extrude depth − 0.1`), which is what `holeCutLevels()` applies.
   - Hole diameter had no hint; now 0.1–2000 mm ("through-hole diameter").
2. Every clamp path that changes the user's number now raises `toast(...)`
   with the applied value, so a rejected-but-accepted edit never looks like
   an exact echo of what was typed.

## Deliberate limits

- Bounds come only from the existing stores (`clampDim`, `shellWall`,
  `holeCutLevels`, sanitisers). No material, strength, or process claims.
- The shell hint is computed for the current sketch; switching sketch size
  re-renders the fields, so the hint and the wall value stay consistent.

## Verification

- `node --check apps/websolid/public/cad.js` → exit 0.
- Post-deploy smoke: load `/` on the candidate; hint text present under
  Width/Height/Depth/Fillet/Dia; typing `0` into Fillet shows
  "Enter 0–500 mm · 0 for none — previous value kept" and the solid is
  unchanged; setting shell wall above `min(w,h)/2 − 0.3` shows the limit toast
  and the field keeps the applied value; revolve angle `720` is refused by the
  field rather than clamped silently.
