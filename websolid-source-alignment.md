# WebSolid source-alignment check

Checked stable production on 2026-11-06:

- `https://websolid.untasked.run/` returned HTTP 200 and rendered the WebSolid parametric part modeler: FeatureManager, modeling toolbar, model viewport, mass properties, export, drawing, and BOM controls.
- `https://websolid.untasked.run/index.html` also returned HTTP 200, but rendered a separate stale page titled “Solid — solo work, kept solid” with task/focus-management UI and a “Saved to Postgres” claim.

The root URL is correct. The explicit `/index.html` path exposes an unbranded, unrelated application from the inherited fork. This could confuse visitors and presents unverified/inapplicable product claims. Fix by making `public/index.html` a branded entry/redirect to the modeler (`cad.html`) or by removing the stale page and configuring the modeler as the canonical static index. Verify both `/` and `/index.html` on the candidate and stable URLs after deployment.

This is an observation from HTTP response text, not a full visual or interaction audit of either page.