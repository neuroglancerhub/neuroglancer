/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Janelia library entry point, published as the "./janelia" subpath.
 *
 * Importing this module registers the standard datasources plus the Janelia
 * ones (clio, dvid), and re-exports the API surface that embedding
 * applications - react-neuroglancer and, through it, clio_website - depend on.
 */

import "#src/util/polyfills.js";
import "#src/layer/enabled_frontend_modules.js";
import "#src/datasource/enabled_frontend_modules.js";
import "#src/kvstore/enabled_frontend_modules.js";

// Viewer setup. setupMinimalViewer avoids default_viewer.css, whose html/body
// rules would otherwise leak into the host page; setupDefaultViewer is kept as
// an alias so existing embedders keep working.
export { setupMinimalViewer } from "#src/ui/minimal_viewer_setup.js";
export { setupMinimalViewer as setupDefaultViewer } from "#src/ui/minimal_viewer_setup.js";
export { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
export { makeMinimalViewer as makeDefaultViewer } from "#src/ui/minimal_viewer.js";
export type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";

export { Viewer, globalViewerConfig } from "#src/viewer.js";
export type { ViewerOptions } from "#src/viewer.js";
export { DisplayContext } from "#src/display_context.js";
export { StatusMessage } from "#src/status.js";

// Utilities used by react-neuroglancer. Note that Uint64 is gone upstream -
// segment ids are native bigint now, so use parseUint64 to parse strings.
export { parseUint64, urlSafeParse } from "#src/util/json.js";
export { serializeColor } from "#src/util/color.js";
// encodeStateAsFragment serialises and encodes in one step, applying the
// bigint replacer that plain JSON.stringify needs to avoid throwing on
// segment ids; encodeFragment only encodes an already-serialised string.
export {
  encodeFragment,
  encodeStateAsFragment,
} from "#src/ui/url_hash_binding.js";

export { AnnotationUserLayer } from "#src/layer/annotation/index.js";
export { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
export { getObjectColor } from "#src/segmentation_display_state/frontend.js";
