# Port audit: feature-flyem-newbuild -> feature/update-feature-flyem-newbuild

A record of porting the FlyEM features from the long-lived `feature-flyem-newbuild` branch
(last commit 2024-10-08, 160 commits adrift of upstream) onto a current neuroglancer base.
Kept in the repo because it documents what was ported, what was deliberately left behind and
why, and several places where the obvious reading of the old code was wrong.

OLD: origin/feature-flyem-newbuild @ 7228ee8e (2024-10-08), merge-base with upstream
     5f620342 (2022-05-17), 49 files changed
NEW: feature/update-feature-flyem-newbuild @ 34f6bc19, rebased onto master c0f79b10 (2026-08-14)
Upstream path rename: src/neuroglancer/X -> src/X
Scope: src/* plus packaging. Build config from the old branch (.babelrc, config/*, webpack and
babel deps) was excluded as obsolete post-Vite.

## PORTED - verified present
- clio datasource (api/backend/base/credentials_provider/frontend/register_*/utils); symbol sets match.
  Old-only names are obsolete shims (makeRequest, makeRequestWithCredentials, HttpCall, responseText).
- dvid datasource (api/backend/base/frontend/utils); frontend symbols match exactly.
- flyem datasource: annotation.ts, api.ts, datainfo.ts, jsonschema.ts. Neurohub auth present
  (clio/base.ts + flyem/api.ts).
- Sphere annotation TYPE + serialization: annotation/index.ts (SPHERE=5), clio/utils.ts, flyem/annotation.ts.
- PlaceSphereTool + ANNOTATE_SPHERE_TOOL_ID registration (ui/annotations.ts) - reachable via tool id.
- copy-segment-id / add-copy-segment-id (layer/segmentation/index.ts, viewer.ts, default_input_event_bindings.ts).
- viewer.bindCallback().
- main_module.ts customisations -> new src/flyem_main_module.ts.

## NOT PORTED - grouped by feature

### A. True 3-D sphere rendering - PORTED + VERIFIED IN BROWSER 2026-08-19
Commits: 2e9962c6 (body), 848a36cd (toolbar button), cfecd596 (geometry), a2c093f3 (ring +
transparency), e082446d (drop axis bar), 4f1b4fc9 + 34f6bc19 (ring placement/intersection).
Final behaviour, confirmed against the old Clio build by screenshot comparison:
  - perspective view: shaded sphere at half alpha, 20x20 tessellation, plus endpoint markers
  - slice views: cross-section ring that widens toward the centre plane and vanishes at the poles,
    plus endpoint markers; no axis bar
Built on upstream's SphereRenderHelper/emitSphere (as annotation/ellipsoid.ts does), NOT on the old
branch's hand-rolled SphereShader in webgl/circles.ts.
Also fixed: setColor never reached any sphere setter, so vColor was unwritten for spheres; and the
sphere tool had no toolbar button.

TWO MISTAKES WORTH REMEMBERING (both cost a browser round-trip):
1. Radii must be projected into subspace (projectModelVectorToSubspace), not passed as a model-unit
   scalar - otherwise anisotropic voxels render an egg.
2. radiusAdjustment in ellipsoid's getSubspaceParams clips against NON-DISPLAYED dimensions. For 3-D
   data it is always 1. It is NOT what produces the cross section. The cross section comes from
   intersecting with the plane in viewport space, where the slice plane is z=0, so the centre's z is
   its distance d from the plane and the radius is sqrt(R^2 - d^2). Emitting at the object's own
   depth also gets clipped by the slab on every slice but one.
Remaining approximation: R is taken as the longest of the three subspace radii transformed into
viewport space - exact for a true sphere, slightly generous for anisotropic voxels. Ellipsoid's full
quadratic-form path handles that case if it ever matters.

### B. FlyEM annotation edit widget - PORTED 2026-08-19 (commit 3d870343)
Ported widgets.ts from origin/feature/vite-library-build (373-line rewrite on a Dec-2025 base, vs
the 459-line 2024 original); it typechecked against this branch unchanged. That branch never wired
it up either - makeAnnotationEditWidget had no callers - so the integration came from the 2024
branch: makeEditWidget declared as an optional capability on MultiscaleAnnotationSource (next to
invalidateCache), implemented as a method on ClioAnnotationSource, consumed by the annotation
details panel in ui/annotations.ts with fallback to the default description editor.
Dropped the exported testSchema fixture (40 lines of embedded JSON, unused on every branch and in
both embedders).
NOT needed, contrary to the original audit: the frontend_source.ts hooks (hasReference,
updateReference, getUser, referencesChanged, addRef refcount change). The rewritten widget takes a
structural {readonly, update, commit} source, which MultiscaleAnnotationSource already satisfies.
Only point/line/ellipsoid annotations get a form; sphere falls back to the description editor.
Only clio implements the hook - dvid did not on the 2024 branch either.
NOT verified: needs a live clio annotation layer with a schema.

### C. Refresh-on-change / per-layer refresh - PORTED 2026-08-19 (commit 56fb5874)
childRefreshed moved onto AnnotationSourceSignals / AnnotationSource /
MultiscaleAnnotationSource (was declared only on the dvid and clio classes, dispatched, and never
subscribed - the dead wire). ui/annotations.ts now subscribes it to forceUpdateView; the old
branch's clearAnnotationElement was NOT ported because updateView already re-reads every attached
source, rebuilds idToIndex and dispatches the virtual list change - and forceUpdateView is how
upstream wires the neighbouring childrenReordered signal.
makeRefreshButton added to widget/close_button.ts (ikonate refresh.svg?raw). Layer bar shows it in
the button container when the layer sets allowingRefresh; AnnotationUserLayer does. Visibility is
applied in LayerWidget.update(), not at construction as on the old branch, where layer.layer is
still null for a layer that has not loaded yet - that button would never have appeared.
refreshLayerData walks all data sources and subsources rather than [0]/[0].
invalidateCache declared as an optional capability on MultiscaleAnnotationSource via interface
merging (same pattern as getSegmentPosition); only dvid and clio implement it.
NOT verified: no automated coverage - needs a live dvid/clio annotation layer in the browser.

### D. External-UI / embedding mode - PORTED 2026-08-18 (commit 673fe884)
globalViewerConfig now lives in src/viewer_config.ts (not viewer.ts - layer/index.ts needs it and
viewer.ts already imports layer/index.ts; viewer.ts re-exports for the old import path).
Ported: expectingExternalUI getter/setter, makeUrlFromState, closeSelectionTab, public
SidePanelManager.registeredPanels, exported encodeFragment, disableContextMenu(target) +
flyem_main_module passing its target, select(panelOn), toJSON/restoreState panel visibility
defaulting to !expectingExternalUI, closeSelectionTab() after recolor/clear-segments.
Deviations: select-position suppresses the panel only when expectingExternalUI is set (old branch
did it unconditionally, which would regress standalone builds); captureSingleLayerState's
forceShowingPanel param not ported (no caller ever passed it, on any branch or in the sibling repos).
NOT included (belongs to group E): the copy-view-URL button and Viewer.copyJsonStateToUrl().
NOT verified: no automated coverage - needs a real react-neuroglancer build against this branch.

### E. Copy view URL button - ALREADY UPSTREAM (no port needed)
Landed upstream as 230d48ff "feat: Adds copy URL button to bypass browser URL truncation (#868)",
2026-07-16, and arrived here via the rebase. Upstream's version is better than the old branch's:
it encodes the state fresh via encodeStateAsFragment (bigint-safe) instead of reading
window.location, which is what fixes URL truncation. It also adds a showCopyUrlButton
uiConfiguration option.
Follow-up applied (commit 5063092a): the upstream button built its URL inline, bypassing
makeUrlFromState, so react-neuroglancer's override (which strips clio:// layers and targets
ngServer) had no effect on it. The button now calls makeUrlFromState, whose standalone default
reproduces upstream's behaviour.

### F. locate-body / jump-to-body - PORTED 2026-08-18 (commit 90c7a536)
Was: dvid/frontend.ts:799 implemented getSegmentPosition(), but the interface declaration and the
caller were missing, so it was dead code.
Now: getSegmentPosition?(id: bigint) declared on MultiscaleVolumeChunkSource
(sliceview/volume/frontend.ts) via declaration merging, and moveToSegment() in
layer/segmentation/index.ts falls back to it when no mesh layer knows the position. Position is
applied directly to globalPosition, matching the old branch's setLayerPosition(null, ...) path;
errors surface via StatusMessage. Typecheck clean, full suite 786 passed / 0 failed.

## PACKAGING - not ported
NEW keeps package name "neuroglancer"; OLD and origin/feature/vite-library-build use
"@janelia-flyem/neuroglancer". Library-build plumbing (package.json.prepack, bin/copy-workers.js,
src/chunk_worker_janelia.bundle.js) exists only on feature/vite-library-build, not on NEW.
=> NEW cannot currently be published as the npm package react-neuroglancer consumes.
ikonate dep is present on NEW, so the refresh icon in (C) can be restored without adding deps.

## FALSE ALARMS - upstream code, not FlyEM's to port (verified present in base 78ad594c)
- segmentation_display_state/base.ts forEachVisibleSegment rewrite (NONREPRESENTATIVE_EXCLUDED,
  isMinElement) - already upstream.
- layer.ts setLayerPosition - already upstream (src/layer/index.ts).
- chunk_manager/backend.ts downloadCancellationToken guard - WRONG CALL, see below.
- gs+json:// protocol (util/special_protocol_request.ts, util/http_path_completion.ts) - upstream
  kvstore/gcs/index.ts already uses the storage JSON API (storage/v1/b/.../o/...?alt=media); obsolete.

## POST-REBASE FINDING (2026-08-18): clio backend kills the chunk worker

Rebase onto master (c0f79b10) was clean: only package-lock.json conflicted; all source auto-merged;
typecheck clean; branch-only files byte-identical. But `npm test` shows 6 failures that master does
not have (verified by running the same two files on master: 9 passed / 755ms).

Failing: tests/datasource/nifti.browser_test.ts (3), tests/datasource/zarr.browser_test.ts (3).
All are 15s timeouts on content-sniffing auto-detect (raw .nii, |gzip:, |zip:, |ocdbt:, .icechunk) -
i.e. every path that needs the chunk worker. Pure metadata reads pass.

ROOT CAUSE (bisected):
  enabled_backend_modules.ts -> #datasource/clio/backend
    -> clio/api.ts -> flyem/api.ts
      -> #src/credentials_provider/interactive_credentials_provider.js   (VALUE import, line 27)
        -> #src/status.js
          -> import "#src/status.css"          <-- DOM at module scope (asset injection)
          -> import "#src/widget/close_button.js"  <-- also DOM at module scope
          (both probed independently in a worker; each throws on its own)
Worker probe: `new Worker(chunk_worker.bundle.js)` on the branch dies with
"Uncaught ReferenceError: document is not defined"; on master the same probe replies normally.
Probing #src/status.js alone in a worker reproduces it; #src/util/abort.js is clean.
Both of status.ts's imports (status.css, widget/close_button.js) throw independently in a worker.
Disabling only the clio backend import makes nifti+zarr pass 9/9 - single cause for all 6 failures.

NOT caused by the rebase: backup/flyem-newbuild-pre-rebase fails the same 3 nifti tests, and
78ad594c:src/status.ts already imported status.css. The port has always broken the chunk worker.

Note flyem/annotation.ts:29 correctly uses `import type` for frontend_source (erased, harmless).
Only flyem/api.ts:27 is a runtime import of a frontend-only module.

FIXED 2026-08-18 (commit 63d2c4d2): moved FlyEMCredentialsProvider, BaseFlyEMCredentialsProvider,
getAuthTokenFromServer and getNeurohubToken into a new frontend-only module
src/datasource/flyem/credentials_provider.ts; flyem/api.ts now keeps only backend-safe exports
(FlyEMToken, DefaultTokenType, flyEMCredentialsKey, fetchWithFlyEMCredentials).
clio/credentials_provider.ts repointed. Full suite: 786 passed / 0 failed (was 6 failed).

## BRANCH STATE 2026-08-18
feature/update-feature-flyem-newbuild rebased onto master c0f79b10 (2026-08-14), 4 commits ahead,
still unpushed. Backup of pre-rebase tip: branch backup/flyem-newbuild-pre-rebase + tag
pre-rebase-2026-08-18.
ALL GROUPS PORTED (A, B, C, D, F; E was already upstream). Remaining risk is verification,
not missing code: groups A, B, C and D have no automated coverage and need a browser.
E needs no port - it is upstream already (230d48ff).
DONE: D (commit 673fe884), F (commit 90c7a536), plus the worker fix (commit 63d2c4d2).


## CORRECTION 2026-08-19: the cancellation-token guard was NOT obsolete (commit 92a848b2)
The audit listed the old branch's downloadCancellationToken null-guard as a false alarm, on the
grounds that upstream had replaced cancellation tokens with AbortController. The mechanism changed;
the race did not. Running the react-neuroglancer example against this branch threw
  "Cannot read properties of undefined (reading 'abort')" at cancelChunkDownload
  <- evict <- tryToFreeCapacity <- processQueuePromotions_ <- ChunkQueueManager.process
cancelChunkDownload used a non-null assertion on chunk.downloadAbortController. That field is
cleared when a download settles and by cancelChunkDownload itself, while the chunk is only moved
off DOWNLOADING by the caller - so both callers (evict, invalidateSourceCache, the latter being the
clio/dvid refresh path) can reach a chunk in DOWNLOADING with nothing to abort. Now a no-op with a
DEBUG_CHUNK_UPDATES log; the caller requeues the chunk.
Lesson: "upstream rewrote this subsystem" does not mean the fork's defensive fix is stale - check
whether the underlying condition still exists.


## RE-SWEEP 2026-08-20 (commit 8db2109c)
Re-derived the old branch's 49 changed files from scratch and checked each against HEAD rather
than trusting the notes above. Three hunks had never been categorised, all in files upstream had
since moved, which is why the first pass skipped them:

1. LayerManager.invokeAction(action, appliedLayer?) and the copy-segment-id / add-copy-segment-id
   bindings passing this.selectedLayer.layer. Without it those actions ran against every visible
   layer and the clipboard contents depended on layer order. PORTED.
2. TrackableDataSelectionState.restoreState skipping the position when coordinateSpace.rank is 0.
   PORTED - react-neuroglancer wraps restoreState in try/catch today because of this.
3. AnnotationUserLayer.toJSON tolerating an unset localAnnotationRelationships. PORTED -
   react-neuroglancer swallows this error today too.

Deliberately still not ported:
- Null guards on UserLayer.selectionState (old src/layer.ts). Non-optional in the type here and no
  evidence of it being unset; trivial to add if it ever throws.
- webgl/circles.ts SphereShader (+132 lines) - superseded by the SphereRenderHelper approach.
- segmentation_display_state/base.ts forEachVisibleSegment rewrite - already upstream.
- util/http_path_completion.ts + special_protocol_request.ts gs+json support - upstream's
  kvstore/gcs already uses the storage JSON API.
- main_module.ts datasource registrations - covered by enabled_frontend_modules (clio, dvid,
  brainmaps, precomputed, n5, zarr and the four credentials providers all verified present).
- The old branch's build config (.babelrc, .npmignore, config/*) - obsolete post-Vite.

Everything else from the old branch is accounted for. What remains is verification, not code:
group B needs a live clio layer with a schema, group C needs dvid/clio annotations changed out of
band, group D needs react-neuroglancer built against a packed library. Group A is verified in the
browser against the old Clio build.
