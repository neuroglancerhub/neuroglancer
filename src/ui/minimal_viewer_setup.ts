/**
 * @license
 * Copyright 2016 Google Inc.
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
 * Minimal viewer setup that does NOT import default_viewer.css.
 * Use this for library/module builds where the html/body styles from
 * default_viewer.css would interfere with the parent application.
 */

import { StatusMessage } from "#src/status.js";
import {
  bindDefaultCopyHandler,
  bindDefaultPasteHandler,
} from "#src/ui/default_clipboard_handling.js";
import { setDefaultInputEventBindings } from "#src/ui/default_input_event_bindings.js";
import {
  disableContextMenu,
  disableWheel,
} from "#src/ui/disable_default_actions.js";
import type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { bindTitle } from "#src/ui/title.js";
import { UrlHashBinding } from "#src/ui/url_hash_binding.js";

declare let NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string | undefined;

/**
 * Sets up a minimal neuroglancer viewer without the html/body CSS styles.
 * This is suitable for embedding neuroglancer in an existing application.
 */
export function setupMinimalViewer(options?: Partial<MinimalViewerOptions>) {
  disableContextMenu();
  disableWheel();

  const viewer = ((<any>window).viewer = makeMinimalViewer(options));
  setDefaultInputEventBindings(viewer.inputEventBindings);

  const hashBinding = viewer.registerDisposer(
    new UrlHashBinding(
      viewer.state,
      viewer.dataSourceProvider.sharedKvStoreContext,
      {
        defaultFragment:
          typeof NEUROGLANCER_DEFAULT_STATE_FRAGMENT !== "undefined"
            ? NEUROGLANCER_DEFAULT_STATE_FRAGMENT
            : undefined,
      },
    ),
  );
  viewer.registerDisposer(
    hashBinding.parseError.changed.add(() => {
      const { value } = hashBinding.parseError;
      if (value !== undefined) {
        const status = new StatusMessage();
        status.setErrorMessage(`Error parsing state: ${value.message}`);
        console.log("Error parsing state", value);
      }
      hashBinding.parseError;
    }),
  );
  hashBinding.updateFromUrlHash();
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}
