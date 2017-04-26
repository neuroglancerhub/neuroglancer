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
 * @file Main entry point for default neuroglancer viewer.
 */
// import {setupDefaultViewer} from 'neuroglancer/ui/default_viewer_setup';
import {makeDefaultViewer} from 'neuroglancer/default_viewer';
import {makeDefaultKeyBindings} from 'neuroglancer/default_key_bindings';
// window.addEventListener('DOMContentLoaded', () => {
//   const viewer = setupDefaultViewer();
// });

// let neuroglancerElement =

export function InitializeNeuroglancer(config: any) {
  let viewer = (<any>window)['viewer'] = makeDefaultViewer(config);
  makeDefaultKeyBindings(viewer.keyMap);
}

(<any>window).InitializeNeuroglancer = InitializeNeuroglancer

