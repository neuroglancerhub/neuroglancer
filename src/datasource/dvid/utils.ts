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

import {
  AnnotationFacade,
  PointAnnotation,
} from "#src/datasource/flyem/annotation.js";

export type DVIDPointAnnotation = PointAnnotation;

export type DVIDAnnotation = DVIDPointAnnotation;

export class DVIDAnnotationFacade extends AnnotationFacade {
  get renderingAttribute() {
    if (this.kind === "Note") {
      if (this.checked) {
        return 1;
      }
      if (this.bookmarkType) {
        if (this.bookmarkType === "False Split") {
          return 2;
        } else if (this.bookmarkType === "False Merge") {
          return 3;
        }
      }
    } else if (this.kind === "PreSyn") {
      return 4;
    } else if (this.kind === "PostSyn") {
      return 5;
    }

    return 0;
  }

  get confidence() {
    if (this.kind === "PreSyn" || this.kind === "PostSyn") {
      if (this.prop && this.prop.conf) {
        return parseFloat(this.prop.conf);
      }
    }
    return 0;
  }
}
