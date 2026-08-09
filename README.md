# PV Studio

PV Studio is a focused browser workspace for loading photogrammetry site models,
choosing real solar modules, and laying out panels directly on 3D surfaces. The
scope is deliberately small: OBJ/MTL viewing, a data-driven panel chooser, and
manual or automatic panel placement. Shading analysis, string design, energy
estimates, reports, project management, authentication, billing, export, and
multi-user features are out of scope.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The live delivery snapshot is available at
`http://localhost:5173/progress.html` and is intentionally labelled **work in
progress** until every quality gate passes.

## Quality gates

Run the same gates used by CI before handing off a change:

```bash
npm test             # Vitest + Testing Library
npm run typecheck    # strict TypeScript project references
npm run lint         # typed ESLint rules
npm run build        # production Vite bundle
```

`npm run test:watch` starts Vitest in watch mode while developing. Tests share a
small jsdom setup in [`src/test/setup.ts`](src/test/setup.ts) that resets the
DOM and browser storage between cases and supplies deterministic media-query and
animation fallbacks.

## Project shape

- `src/viewer/` contains model metadata, render modes, and surface-selection
  algorithms.
- `src/data/` contains the panel catalog and its JSON source.
- `src/panels/` contains panel-library UI and rendering primitives.
- `src/placement/` contains surface-snapped placement and layout algorithms.
- `src/shell/` owns the application shell and interaction chrome.
- `src/test/` contains shared test setup and test-only helpers.

The Vite configuration is typed through `vitest/config`, so the test runner and
the production bundler use one validated configuration surface. Runtime data is
kept in the browser; no credentials or server-side configuration are required.

## Supported model inputs

Select a WebODM or standard OBJ model with its optional MTL file and associated
JPG/PNG textures. Files are processed locally in the browser and are not sent
to a server.
