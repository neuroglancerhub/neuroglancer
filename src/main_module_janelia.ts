/**
 * @license
 * Copyright 2024 Howard Hughes Medical Institute
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
 * Janelia-specific neuroglancer module entry point.
 * Includes all standard datasources plus Janelia-specific ones (clio).
 */

import "#src/util/polyfills.js";
import "#src/layer/enabled_frontend_modules.js";
import "#src/datasource/enabled_frontend_modules.js";
import "#src/kvstore/enabled_frontend_modules.js";

// Janelia-specific datasources are already included via enabled_frontend_modules
// Additional explicit imports can be added here if needed for specific configurations

// Re-export common utilities for library consumers
// Use setupMinimalViewer for embedded use - it doesn't include html/body styles
export { setupMinimalViewer } from "#src/ui/minimal_viewer_setup.js";
// Alias setupDefaultViewer to setupMinimalViewer for backwards compatibility in embedded apps
// The original setupDefaultViewer imports CSS with html/body styles that interfere with parent apps
export { setupMinimalViewer as setupDefaultViewer } from "#src/ui/minimal_viewer_setup.js";
export { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
export type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";
export { Viewer, globalViewerConfig } from "#src/viewer.js";
export type { ViewerOptions } from "#src/viewer.js";
// Note: makeDefaultViewer imports default_viewer.css with html/body styles
// For embedded use, prefer makeMinimalViewer instead
export { makeMinimalViewer as makeDefaultViewer } from "#src/ui/minimal_viewer.js";
export { DisplayContext } from "#src/display_context.js";
export { StatusMessage } from "#src/status.js";

// Utilities used by react-neuroglancer
// Note: Uint64 class has been replaced with native bigint in upstream neuroglancer
// Use parseUint64 to parse strings to bigint
export { parseUint64, urlSafeParse } from "#src/util/json.js";
export { serializeColor } from "#src/util/color.js";
export { encodeFragment } from "#src/ui/url_hash_binding.js";

// Layer types
export { AnnotationUserLayer } from "#src/layer/annotation/index.js";
export { SegmentationUserLayer } from "#src/layer/segmentation/index.js";

// Segmentation utilities
export { getObjectColor } from "#src/segmentation_display_state/frontend.js";
