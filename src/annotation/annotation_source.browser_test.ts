/**
 * @license
 * Copyright 2020 Google Inc.
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

import { describe, expect, it } from "vitest";
import { AnnotationSource } from "#src/annotation/index.js";

describe("childRefreshed", () => {
  // The dvid and clio sources dispatch this after invalidateCache, and the
  // annotation list view subscribes to it to rebuild itself. It has to live on
  // the base source: it was previously declared only on those two classes,
  // which left the list view with nothing to subscribe to.
  it("is exposed by AnnotationSource and notifies subscribers", () => {
    const source = new AnnotationSource(/*rank=*/ 3);
    let notified = 0;
    const unsubscribe = source.childRefreshed.add(() => {
      ++notified;
    });
    source.childRefreshed.dispatch();
    expect(notified).toBe(1);
    unsubscribe();
    source.childRefreshed.dispatch();
    expect(notified).toBe(1);
  });
});
