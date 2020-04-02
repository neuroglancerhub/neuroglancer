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

import {Point, Line, AnnotationType, AnnotationId} from 'neuroglancer/annotation/index';
import {StringMemoize} from 'neuroglancer/util/memoize';

let EnvMemoize = new StringMemoize();

export let Env = {
    getUser: function () {
        return EnvMemoize.getUncounted(
            'user', () => prompt('User:') || '');
    }
};

export const lineAnnotationDataName = 'bookmarks';

export interface DVIDPointAnnotation extends Point {
  kind?: string;
  prop: {[key: string]: string};
}

export interface DVIDLineAnnotation extends Line
{
}

export function typeOfAnnotationId(id: AnnotationId) {
  if (id.match(/^\d+_\d+_\d+$/)) {
    return AnnotationType.POINT;
  } else if (id.match(/^\d+_\d+_\d+-\d+_\d+_\d+$/)) {
    return AnnotationType.LINE;
  } else {
    console.log(id);
    throw new Error(`Invalid annotation ID for DVID: ${id}`)
  }
}

export function isAnnotationIdValid(id: AnnotationId) {
  try {
    typeOfAnnotationId(id);
    return true;
  } catch {
    return false;
  }
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
    return (this.prop && this.prop.checked === '1') ? true : false;
  }

  getBooleanProperty(s: boolean) {
    return s ? '1' : '0';
  }

  setChecked(c: string|boolean) {
    if (typeof c === 'string') {
      this.prop.checked = c;
    } else {
      this.prop.checked = c ? '1' : '0';
    }
  }

  get bookmarkType() {
    return this.prop && this.prop.type;
  }

  get timestamp() {
    return (this.prop && this.prop.timestamp) ? Number(this.prop.timestamp) : 0;
  }

  addTimeStamp() {
    this.prop['timestamp'] = String(Date.now());
  }

  get custom() {
    return (this.prop && this.prop.custom === '1') ? true : false;
  }

  setCustom(c: string|boolean) {
    if (typeof c === 'string') {
      this.prop.custom = c;
    } else {
      this.prop.custom = c ? '1' : '0';
    }
  }
  /*
  set custom(c) {
    if (this.prop === undefined) {
      this.prop = {};
    }
    this.prop.custom = c;
  }
  */

  get prop(): {[key: string]: string} {
    if (this.annotation.prop === undefined) {
      this.annotation.prop = {};
    }
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

export function getAnnotationDescription(annotation: DVIDPointAnnotation|DVIDLineAnnotation): string {

  let description = '';
  if (annotation.type === AnnotationType.LINE) {
    return annotation.description || '';
  } else {
    let { prop } = annotation;
    if (prop) {
      description = prop.comment || prop.annotation || '';
      if (prop.type && prop.type !== 'Other') {
        description += ` (Type: ${prop.type})`;
      }
    }
  }

  return description;
}

/*
function getUserFromToken(token: string): string|null {
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
*/

export function getUserFromToken(token: string, defaultUser?: string) {
  let tokenUser:string|undefined = undefined;

  const payload = token.split('.')[1];
  if (payload) {
    const obj = JSON.parse(window.atob(payload));
    if ('user' in obj) {
      tokenUser = obj['user'];
    } else if ('email' in obj) {
      tokenUser = obj['email'];
    }
  }

  // const tokenUser = getUserFromToken(token);
  if (tokenUser) {
    if (defaultUser && (defaultUser !== tokenUser)) {
      return undefined;
    }
  } else {
    tokenUser = defaultUser;
  }

  return tokenUser;
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