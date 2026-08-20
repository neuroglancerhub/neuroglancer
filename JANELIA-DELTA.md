# Janelia delta

Everything this fork adds on top of upstream neuroglancer, in the order it is applied.
`janelia-release` is upstream `master` plus these commits and nothing else, so

    git diff master..janelia-release

is always exactly the fork's delta. Keep it that way.

## How this repo is arranged

- **`master`** mirrors `upstream/master`. Fast-forward only; never commit to it.
- **`janelia-release`** is the fork: upstream plus the series below, maintained by rebase.
- Feature work branches off `janelia-release` and merges back into it.
- Tags mark published states (`janelia-v<upstream-version>-<n>`). Consumers install the published
  package, not the branch, so the branch may be force-pushed after a rebase.

Sync with `janelia/sync-upstream.sh`: it fast-forwards `master`, rebases `janelia-release`,
then typechecks and tests. It pushes nothing. `git rerere` is enabled, so a conflict resolved in
one sync replays in the next.

## The series

Commits are grouped so that the parts which could go upstream sit at the bottom. When one is
accepted upstream, the next rebase drops it automatically - git recognises the patch as already
applied. That is how the copy-URL button left this fork: it went upstream as #868 and came back
in a sync.

### 1. Upstreamable - candidates for a PR to google/neuroglancer

Nothing FlyEM-specific; these are plain bug fixes.

- `0d29ca7e` fix(chunk_manager): tolerate cancelling a download that has no controller

Also upstreamable, but currently folded into a fork-only commit rather than split out:
the rank-0 guard in `TrackableDataSelectionState.restoreState` and the unset-relationships guard in
`AnnotationUserLayer.toJSON`, both inside `fix: port three hunks missed in the first pass`.
Split them out if you open a PR.

### 2. Fork-only features

Janelia data sources and the UI that goes with them. Not intended for upstream.

- `727853ec` feat: migrate FlyEM features from old branch
- `24608fb7` feat(ui/segmentation): allow copying segment ids from view
- `9d5af28f` fix(datasource/flyem): keep api module free of DOM imports
- `c502ab9d` feat(layer/segmentation): look up segment position via the data source
- `53775284` feat(viewer): support embedding in an external UI
- `8b588e90` fix(viewer): route the copy URL button through makeUrlFromState
- `dbe9e915` feat(ui): refresh annotation layers from the layer bar
- `3e0c9ec0` test(annotation): cover childRefreshed on the base source
- `cd2bc1fd` feat(datasource/clio): edit annotations through their schema
- `b70a8bd5` feat(annotation): render spheres as shaded geometry
- `7036f013` feat(ui): add the sphere annotation tool button
- `fb370d63` fix(annotation): correct sphere geometry in the 3-D view
- `98d5948a` feat(annotation): draw the sphere cross section in slice views
- `5c65422b` feat(annotation): stop drawing the sphere axis
- `7d892e8a` fix(annotation): keep the sphere cross section on the current slice
- `f814826d` fix(annotation): compute the sphere cross section by plane intersection
- `566adae6` fix: port three hunks missed in the first pass

### 3. Packaging

Publishes the fork as `@janelia-flyem/neuroglancer` with a `./janelia` entry point.
Always last: most fork-specific, least likely to conflict.

- `8ef65b9c` feat(package): publish a janelia library entry point
- `91fce2f1` feat(package): export a stylesheet for the janelia entry

### 4. Documentation

- `c582e2f9` docs: keep the FlyEM port audit in the repo
- `5cb36ac2` docs: record the re-sweep findings in the port audit

## Keeping the conflict surface small

The delta is roughly half new files and half edits to upstream files. New files never conflict;
the edits are what cost time on every rebase. Current edit hotspots:

    src/datasource/dvid/*        largest delta, but upstream rarely touches it
    src/ui/annotations.ts        edit widget hook, sphere tool button, refresh subscription
    src/annotation/index.ts      SPHERE annotation type
    src/annotation/type_handler.ts   sphere shader setters
    src/viewer.ts                external-UI mode
    src/layer/index.ts           allowingRefresh, selection state, invokeAction target

When adding to the fork, prefer a new module plus a registration hook over editing an upstream
file. The data sources already work this way, through the `#datasource/...` conditions in
package.json. Where a hook is generic rather than FlyEM-specific - an annotation source supplying
its own edit widget, for instance - upstreaming the hook while keeping the implementation here
turns a permanent conflict into none.

See `FLYEM-PORT-AUDIT.md` for how these changes were migrated from the old
`feature-flyem-newbuild` branch, and what was deliberately left behind.

## Archived branches

The fork's old branches were pruned once their content had been ported. Every tip is preserved as
an annotated tag, so nothing became unreachable:

    git tag -l 'archive/*'
    git log archive/feature-flyem-newbuild
    git show archive/feature/vite-library-build:src/datasource/flyem/widgets.ts

Of note:
- `archive/feature-flyem-newbuild` - the long-lived branch this fork was ported from (2024-10-08).
- `archive/feature/vite-library-build` - the February 2026 packaging attempt; the widget code
  came from here.
- `archive/backup/flyem-newbuild-pre-rebase` - the port before it was rebased onto current upstream.
- `archive/keep/pre-reorder` - janelia-release before its commits were regrouped.
- `archive/janelia-version-0.10.0-local` - a local tip that had diverged from origin by three
  unpushed commits.
