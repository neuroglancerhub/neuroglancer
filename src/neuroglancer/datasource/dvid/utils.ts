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

import {Point} from 'neuroglancer/annotation/index';
import {StringMemoize} from 'neuroglancer/util/memoize';

let EnvMemoize = new StringMemoize();

export let Env = {
    getUser: function () {
        return EnvMemoize.getUncounted(
            'user', () => prompt('User:') || '');
    }
};

export interface DVIDPointAnnotation extends Point {
  kind?: string;
  prop: {[key: string]: string};
}

export class DVIDPointAnnotationFacade {
  constructor(public annotation: DVIDPointAnnotation) {
    this.updateProperties();
  }

  updateProperties() {
    this.annotation.properties = [this.renderingAttribute];
  }

  get kind(): string|undefined {
    return this.annotation.kind;
  }

  set kind(kind: string|undefined) {
    this.annotation.kind = kind;
  }

  set point(point: Float32Array) {
    this.annotation.point = point;
  }

  get comment() {
    return this.prop && this.prop.comment;
  }

  get checked() {
    return this.prop && this.prop.checked === '1' ? true : false;
  }

  get bookmarkType() {
    return this.prop && this.prop.type;
  }

  get custom() {
    return this.prop && this.prop.custom;
  }

  set custom(c) {
    if (this.prop === undefined) {
      this.prop = {};
    }
    this.prop.custom = c;
  }

  get prop(): {[key: string]: string} {
    return this.annotation.prop;
  }

  set prop(prop: {[key: string]: string}) {
    this.annotation.prop = prop;
    this.updateProperties();
  }

  get renderingAttribute() {
    if (this.kind === 'Note') {
      if (this.checked) {
        return 1;
      }
      if (this.bookmarkType) {
        if (this.bookmarkType === 'False Split') {
          return 2;
        } else if (this.bookmarkType === 'False Merge') {
          return 3;
        }
      }
    } else if (this.kind === 'PreSyn') {
      return 4;
    } else if (this.kind === 'PostSyn') {
      return 5;
    }

    return 0;
  }
}

export function getAnnotationDescription(annotation: DVIDPointAnnotation): string {

  let description = '';
  let {prop} = annotation;
  if (prop) {
    description = prop.comment || prop.annotation || '';
    if (prop.type && prop.type !== 'Other') {
      description += ` (Type: ${prop.type})`;
    }
  }

  return description;
}

export function getUserFromToken(token: string): string|null {
  const payload = token.split('.')[1];
  if (payload) {
    const obj = JSON.parse(window.atob(payload));
    if ('user' in obj) {
      return obj['user'];
    } else if ('email' in obj) {
      return obj['email'];
    }
  }

  return null;
}

export const defaultJsonSchema = {
  "definitions": {},
  "type": "object",
  "required": [
    "Prop"
  ],
  "properties": {
    "Prop": {
      "$id": "#/properties/Prop",
      "type": "object",
      "title": "Properties",
      "required": [
        "comment",
      ],
      "properties": {
        "comment": {
          "$id": "#/properties/Prop/properties/comment",
          "type": "string",
          "title": "Comment",
          "default": ""
        }
      }
    }
  }
};