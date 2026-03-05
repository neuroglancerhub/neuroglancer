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

import "#src/util/polyfills.js";
import "#src/layer/enabled_frontend_modules.js";
import "#src/datasource/enabled_frontend_modules.js";
import "#src/kvstore/enabled_frontend_modules.js";

import {
  bindDefaultCopyHandler,
  bindDefaultPasteHandler,
} from "#src/ui/default_clipboard_handling.js";
import { setDefaultInputEventBindings } from "#src/ui/default_input_event_bindings.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { disableContextMenu } from "#src/ui/disable_default_actions.js";

export function setupDefaultViewer(options?: {
  target?: HTMLElement;
}) {
  const viewer = makeMinimalViewer({
    target: options?.target,
  });
  setDefaultInputEventBindings(viewer.inputEventBindings);

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  disableContextMenu();

  return viewer;
}

export default class Neuroglancer {
  version() {
    return "0.0.1";
  }
}
