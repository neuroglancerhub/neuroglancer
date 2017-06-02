
Janelia FlyEM Long Term Fork notes
===================================
The Janelia FlyEM team maintains a long-term fork with custom or experimental features. Additionally, FlyEM contributes some of these features upstream.

# Feature overview/relevant code

- Metric Layer
    - a segmentation layer that can toggle between different color modes.
    - metric modes where colors are mapped to metric values for each segmentation
    - standard random color mode
    - code: 
        - [src/neuroglancer/segmentation_metric_user_layer.ts](src/neuroglancer/segmentation_metric_user_layer.ts)
        - [src/neuroglancer/sliceview/custom_color_segmentation_renderlayer.ts](src/neuroglancer/sliceview/custom_color_segmentation_renderlayer.ts)
- DVID Skeletons
    - given a 'skeletons' value in the spec for a dvid segmentation layer, neuroglancer can load skeletons when bodies are selected (double click). The skeleton only displays if a swc file is available for that body, following the naming convention "BODY_ID_swc" as the key in the dvid source keyvalue.
    code:
        - [src/neuroglancer/datasource/dvid/frontend.ts](src/neuroglancer/datasource/dvid/frontend.ts)
        - swc decoding: [src/neuroglancer/skeleton/decode_swc_skeleton.ts](src/neuroglancer/skeleton/decode_swc_skeleton.ts)
- Stack Overlay:
    - ROI (cube) overlay layer.
    - was used in the (Segmentation evaluation console), but is currently not working (see results of loadTestStack).
    - most likely needs to be re-engineered to avoid tight-coupling with the chunk management system.
    - code:
        - [src/neuroglancer/stack](src/neuroglancer/stack)
        - [src/neuroglancer/stack_user_layer.ts](src/neuroglancer/stack_user_layer.ts)
        - [src/neuroglancer/datasource/dvid/frontend.ts]([src/neuroglancer/datasource/dvid/frontend.ts])
- DVID datasource:
    - as dvid continues to evolve, the interface between dvid and neuroglancer needs to be kept up to date. Usually changes should be made in a branch off of vanilla, and a pull request to upstream can be made. Once the PR is accepted, update vanilla from upstream, and merge vanilla into master. This should help minimize merge conflicts and ugly PRs (see 'Current Branching Protocol).
    - code: [src/neuroglancer/datasource/dvid/frontend.ts](src/neuroglancer/datasource/dvid/frontend.ts)

# Current Branching Protocol
- master: main version of neuroglancer used in flyem projects
    - gets upstream updates by merging vanilla into master
    - feature branches off of this: when we have no intention of contributing these changes to the upstream project
- vanilla:
    - never commit or merge to vanilla
    - vanilla is a copy of upstream/master
        - ```git pull upstream master```
    - merge this into origin/master when updates are needed
    - make feature branches of of vanilla when planning on contributing these features to the upstream fork. When making a PR to google/neuroglancer, ensure the feature branch is rebased off the tip of vanilla and vanilla is up to date, then make the PR from this feature branch. When the PR is accepted, delete the feature branch and update vanilla again (then merge into master again if desired)

# Feature testing

At this time, it's challenging to write automated tests for the front-end features flyem has built for our long term fork. To aid in testing, we've built a few utilities that help set up rudimentary test cases for evaluation. It's a good idea to check these after merging in changes from vanilla(upstream).

Currently these tests require emdata2:9000 to be running, but they should be generalized in the future to run with a dvid that automatically spins up with the necessary data. The dvid must have metric data and skeletons, and the tests will need to be modified to work this way.

To setup the tests, run `npm run test-janelia`, and open your browser to localhost:8080. The individual tests can be run from the web console:

1. janelia.loadTestMetricLayer()//loads the metric color layer with two metrics for inspection
1. janelia.loadTestSkeleton()//loads a skeleton and segmentation
1. janelia.loadTestStack()// loads an ROI (stack) overlay. Currently this feature has a display bug. This test can be a starting point towards fixing them.

See config/janeliatest_webpack.config.js and the flyem_testing_support folder for test implementation details.

