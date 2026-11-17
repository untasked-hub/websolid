# Round 7 — printability review panel (item 01m6x4b4g5atqzsfqkebtghvqe)

## Shipped change (committed 584a3e556a7ed282c67f98cf1e635b9b70cb6ebf)
Files: `apps/websolid/public/cad.js`, `apps/websolid/public/cad.css`, `apps/websolid/public/cad.html`

`runPrintability()` now renders, for every verdict chip from `SolidPrintability.verdicts()`:

1. **Measured note** — the existing analyzer note (e.g. `1.84 mm vs 1.20 mm min`).
2. **Scope line** — exactly what that check measures and does not:
   - manifold: mesh-wide edge/component census; not slicer or machine certification
   - wall: global centroid raycast estimate; skipped above the analyzer triangle limit
   - hole: compares the nominal hole list diameters; does not measure arbitrary mesh openings
   - overhang: global downward-area/angle check; no viewport location is marked
   - shell: connectedness + volume; not pressure/strength/manufacturing validation
3. **Next step** — a bounded revision hint ("review the wall value, sketch size, holes…", "consider a different orientation…"), prefixed `Next:` on failures and `Review:` on passes.

Summary line (`#print-note`) states either "All analyzed checks passed … Review these estimates before export; this is not a manufacturing or safety guarantee." or "N checks need review before export. These estimates do not identify exact viewport locations or certify manufacturability."

The static disclaimer in `cad.html` still states results are global estimates, not engineering certification.

## Deliberate scope limits
- No new geometry analysis, no spatial highlighting: the analyzer returns aggregate metrics only, so any per-location cue would be invented.
- No safety or manufacturability claims; no slider/slicer certification language.

## Verification checklist (run when tooling is available)
- `node --check apps/websolid/public/cad.js` (and printability.js unchanged).
- Load `/` on the candidate URL, click **Printability → Check** with the default bracket:
  expect 5 chips (Watertight & manifold, Min wall thickness, Hole diameters, Overhang angle, Solid / connected), each with note + scope + next step.
- Set Min wall to 0.4 mm and Profile resin → wall chip flips to fail and shows `Next: review the wall value…`.
- Export STL toast still appends `— Printability: N issues (see panel)`.
- Confirm `#print-note` shows the non-certification sentence in both pass and fail states.

## Blocker this cycle
`change_checks` returns `Check infrastructure error: No eligible funding source
(01m6rp6hyegxg41asm5vezehng: insufficient remaining capacity)` although two
other active credit sources have $10 and $15 remaining. Without passing checks
`change_merge` refuses, so `release_create`/`release_deploy` cannot run.
Bug report filed: 01m6x9pa58dtyv3wbcms3fdqce. Same error blocks `run_python`
and `toolkit_run`.

## Next action once unblocked
1. `change_checks` → `change_merge` proposal `01m6x9f35qwyxq7nqy30w0rxkd` (head 584a3e5).
2. Run the checklist above against the candidate.
3. `release_create` with merged commit → `release_deploy` → smoke candidate → `release_promote` with changelog → `publication_publish`.
4. `improve_phase_advance` back to functional_audit.
