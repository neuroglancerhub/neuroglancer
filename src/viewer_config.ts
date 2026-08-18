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
 * @file Global viewer configuration shared across modules.
 *
 * This lives outside viewer.ts because layer/index.ts needs it and viewer.ts
 * already imports layer/index.ts; importing back would create a cycle.
 */

export const globalViewerConfig = {
  /**
   * Set by an embedding application that supplies its own UI, e.g.
   * react-neuroglancer. While true, neuroglancer keeps its own selection panel
   * from forcing itself visible, and builds state URLs relative to the host
   * page instead of using the browser location.
   */
  expectingExternalUI: false,
};
