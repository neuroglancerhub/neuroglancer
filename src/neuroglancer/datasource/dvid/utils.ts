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

import {Point, Sphere, Line, AnnotationType, AnnotationId} from 'neuroglancer/annotation/index';
import {StringMemoize} from 'neuroglancer/util/memoize';

let EnvMemoize = new StringMemoize();

export let Env = {
    getUser: function () {
        return EnvMemoize.getUncounted(
            'user', () => prompt('User:') || '');
    }
};

export const lineAnnotationDataName = 'bookmarks';
export const sphereAnnotationDataName = 'bookmarks';

export interface DVIDAnnotationBase {
  kind?: string;
  source?: string;
  prop: {[key: string]: string};
}

export interface DVIDPointAnnotation extends Point, DVIDAnnotationBase {
};

export interface DVIDLineAnnotation extends Line, DVIDAnnotationBase
{
}

export interface DVIDSphereAnnotation extends Sphere, DVIDAnnotationBase {
};

export type DVIDAnnotation = DVIDPointAnnotation |  DVIDLineAnnotation | DVIDSphereAnnotation;

// const twoPointAnnotationIdPattern = '-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+';
export function typeOfAnnotationId(id: AnnotationId) {
  if (id.match(/^-?\d+_-?\d+_-?\d+$/)) {
    return AnnotationType.POINT;
  } else if (id.match(/^-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+$/)) {
    return AnnotationType.SPHERE;
  } else if (id.match(/^-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+-Line$/)) {
    return AnnotationType.LINE;
  } else {
    console.log(`Invalid annotation ID for DVID: ${id}`);
    return null;
    // throw new Error(`Invalid annotation ID for DVID: ${id}`)
  }
}

export function getAnnotationId(annotation: DVIDAnnotation) {
  switch (annotation.type) {
    case AnnotationType.POINT:
      return `${annotation.point[0]}_${annotation.point[1]}_${annotation.point[2]}`;
    case AnnotationType.LINE:
      return `${annotation.pointA[0]}_${annotation.pointA[1]}_${annotation.pointA[2]}-${annotation.pointB[0]}_${annotation.pointB[1]}_${annotation.pointB[2]}-Line`;
    case AnnotationType.SPHERE:
      return `${annotation.pointA[0]}_${annotation.pointA[1]}_${annotation.pointA[2]}-${annotation.pointB[0]}_${annotation.pointB[1]}_${annotation.pointB[2]}`;
  }
}

export const DVIDAnnotationKindMap = {
  [AnnotationType.POINT]: 'Note',
  [AnnotationType.LINE]: 'PureLine', 
  [AnnotationType.SPHERE]: 'Line' //for back compatibility
};

export function isAnnotationIdValid(id: AnnotationId) {
  return typeOfAnnotationId(id) !== null;
}

export class DVIDAnnotationFacade {
  constructor(public annotation: DVIDAnnotation) {
    this.updateProperties();
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

  addProp(prop: {[key:string]: string}) {
    this.prop = {...this.prop, ...prop};
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

  get prop(): {[key: string]: string} {
    //Make sure prop exists in annotation
    if (this.annotation.prop === undefined) {
      this.annotation.prop = {};
    }
    return this.annotation.prop;
  }

  set prop(prop: { [key: string]: string }) {
    this.annotation.prop = prop;
    this.updateProperties();
  }

  updateProperties() {
  }
}

export function parseDescription(description: string)
{
  let match = description.match(/^\${(.*):JSON}$/);
  if (match) {
    return JSON.parse(match[1]);
  } else {
    return null;
  }
}

export class DVIDLineAnnotationFacade extends DVIDAnnotationFacade {
  constructor(public annotation: DVIDLineAnnotation) {
    super(annotation);
  }
}

export class DVIDSphereAnnotationFacade extends DVIDAnnotationFacade {
  constructor(public annotation: DVIDSphereAnnotation) {
    super(annotation);
  }

  get renderingAttribute() {
    return this.timestamp > 0 ? 11 : 0;
  }

  updateProperties() {
    this.annotation.properties = [this.renderingAttribute];
  }
}

export class DVIDPointAnnotationFacade extends DVIDAnnotationFacade{
  constructor(public annotation: DVIDPointAnnotation) {
    super(annotation);
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

export function getAnnotationDescription(annotation: DVIDAnnotation): string {
  let description = '';
  let { prop } = annotation;
  if (prop) {
    description = prop.comment || prop.annotation || '';
    if (prop.type && prop.type !== '---') {
      description += ` (Type: ${prop.type})`;
    }

    if (prop.hint) {
      description += ` ⓘ ${prop.hint}`;
    }
  }

  /*
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
  */

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