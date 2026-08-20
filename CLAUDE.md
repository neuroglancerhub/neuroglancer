# Working in this repo

Janelia's fork of google/neuroglancer, published as `@janelia-flyem/neuroglancer`.

## The delta

`master` mirrors upstream and is fast-forward only. The fork lives on `janelia-release` as a
commit series on top of it, so `git diff master..janelia-release` is exactly what this fork
changes. Commit there, and keep that diff legible — it is what makes the next upstream sync
cheap, and its absence is what made the previous one expensive.

New files never conflict on rebase; edits to upstream files do. Prefer adding a module and
registering it — the data sources do this through the `#datasource/...` conditions in
`package.json` — over editing an upstream file. When an upstream file must change, keep the edit
contiguous and comment why.

Current edit hotspots, worth extra care:

    src/ui/annotations.ts            src/annotation/index.ts
    src/annotation/type_handler.ts   src/viewer.ts
    src/layer/index.ts               src/layer/segmentation/index.ts

`JANELIA-DELTA.md` lists the series, grouped so upstreamable fixes sit at the bottom; add new
commits to the group they belong to. Read it before restructuring the branch or syncing upstream.
`FLYEM-PORT-AUDIT.md` records what was ported from the old `feature-flyem-newbuild` branch, what
was skipped and why; read it before concluding a feature was missed, and before reviving anything
from `git tag -l 'archive/*'`.

## Verifying a change

`npm run typecheck && npm test`, plus `npx prettier --write` and `npx oxlint` on what you touched.

Three pre-existing failures are unrelated to any change you make:

- `src/util/google_tag_manager.ts` TS2451 in `typecheck`
- a `no-useless-escape` warning and a `consistent-type-imports` error in
  `src/datasource/flyem/{annotation,../clio/backend}.ts` under `oxlint`
- `tests/kvstore/{gcs,s3,icechunk}` fail unless `go` and `uv` are installed; they build a
  fake-gcs-server and run moto

**The suite never compiles GLSL.** A green run says nothing about a shader change, and because
`setColor` reaches every annotation type, one bad setter breaks all annotation rendering rather
than just the feature you touched. Shader work needs a browser: draw a point, a line and a
sphere, and check the console.

## The browser

`../react-neuroglancer` has an example app that loads this checkout through a symlinked
`node_modules/@janelia-flyem/neuroglancer`, with a local annotation layer ready to draw on.
Vite's dev watcher ignores `node_modules`, so **edits here only appear after restarting that
server** — a stale server has cost several rounds of chasing phantom bugs. The user runs the
server; ask rather than starting one.
