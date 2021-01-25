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

import {AnnotationType, AnnotationId} from 'neuroglancer/annotation/index';
import {DVIDPointAnnotation, DVIDLineAnnotation, DVIDAnnotationFacade, defaultJsonSchema} from 'neuroglancer/datasource/dvid/utils';
// import {JsonObject} from 'neuroglancer/datasource/dvid/jsonschema';
// import {FrontendAnnotationSource, createAnnotationWidget} from 'neuroglancer/datasource/dvid/widgets';

// type ClioAnnotationBase = DVIDAnnotationBase;
// export interface ClioAnnotationBase {
//   kind?: string;
//   prop: {[key: string]: string};
// }

export interface ClioPointAnnotation extends DVIDPointAnnotation {
  verified?: Boolean;
}

export type ClioLineAnnotation = DVIDLineAnnotation;

export type ClioAnnotation = ClioPointAnnotation | ClioLineAnnotation;

// const twoPointAnnotationIdPattern = '-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+';
export function typeOfAnnotationId(id: AnnotationId) {
  if (id.match(/^-?\d+_-?\d+_-?\d+$/) || id.match(/^Pt-?\d+_-?\d+_-?\d+$/)) {
    return AnnotationType.POINT;
  } else if (id.match(/^-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+-Line$/) || id.match(/^Ln-?\d+_-?\d+_-?\d+_-?\d+_-?\d+_-?\d+$/)) {
    return AnnotationType.LINE;
  } {
    console.log(`Invalid ID for Clio annotation: ${id}`);
    return null;
    // throw new Error(`Invalid annotation ID for DVID: ${id}`)
  }
}

export function getAnnotationId(annotation: ClioAnnotation) {
  if (annotation.key) {
    return annotation.key;
  }

  switch (annotation.type) {
    case AnnotationType.POINT:
      return `Pt${annotation.point[0]}_${annotation.point[1]}_${annotation.point[2]}`;
    case AnnotationType.LINE:
      return `Ln${annotation.pointA[0]}_${annotation.pointA[1]}_${annotation.pointA[2]}_${annotation.pointB[0]}_${annotation.pointB[1]}_${annotation.pointB[2]}`;
  }
}

export function isAnnotationIdValid(id: AnnotationId) {
  return typeOfAnnotationId(id) !== null;
}

export class ClioAnnotationFacade extends DVIDAnnotationFacade {
  constructor(public annotation: ClioAnnotation) {
    super(annotation);
  }

  get description() {
    return super.comment;
  }

  set description(value: string) {
    super.addProp({'comment': value});
  }

  get title() {
    return super.prop && super.prop.title;
  }

  set title(value: string) {
    super.addProp({'title': value});
  }

  get user() {
    return super.prop && super.prop.user;
  }

  set user(value: string) {
    super.addProp({'user': value});
  }

  get checked() {
    if (this.annotation.type === AnnotationType.POINT) {
      return this.annotation.verified ? true : false;
    }

    return super.checked;
  }

  set checked(value: boolean) {
    if (this.annotation.type === AnnotationType.POINT) {
      this.annotation.verified = value;
      this.updateProperties();
    } else {
      super.checked = value;
    }
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

export class ClioLineAnnotationFacade extends ClioAnnotationFacade {
  constructor(public annotation: ClioLineAnnotation) {
    super(annotation);
  }

  get renderingAttribute() {
    return this.timestamp > 0 ? 11 : 0;
  }

  updateProperties() {
    this.annotation.properties = [this.renderingAttribute];
  }
}

export class ClioPointAnnotationFacade extends ClioAnnotationFacade {
  constructor(public annotation: ClioPointAnnotation) {
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

  get renderingAttribute(): number {
    if (this.kind === 'Atlas') {
      if (!this.title) {
        return -1;
      } else if (this.checked) {
        return 1;
      }
    }

    return 0;
  }
}

export function getAnnotationDescription(annotation: ClioAnnotation): string {
  let annotationFacade = new ClioAnnotationFacade(annotation);
  let description = '';
  if (annotationFacade.title) {
    description += annotationFacade.title + ': ';
  }
  if (annotationFacade.description) {
    description += annotationFacade.description;
  }

  /*
  if (annotationFacade.user) {
    description += ` ⓤ ${annotationFacade.user}`;
  }
  */

  return description;
}

export const defaultAnnotationSchema = defaultJsonSchema;

export const defaultAtlasSchema = {
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
        "title", "comment"
      ],
      "properties": {
        "title": {
          "$id": "#/properties/Prop/properties/title",
          "type": "string",
          "title": "Title",
          "default": ""
        },
        "comment": {
          "$id": "#/properties/Prop/properties/comment",
          "type": "string",
          "title": "Description",
          "default": ""
        }
      }
    }
  }
};

/*
export const defaultAtlasSchema = {
  "definitions": {},
  "type": "object",
  "required": [
    "Title", "Description"
  ],
  "properties": {
    "Title": {
      "$id": "#/properties/Title",
      "type": "string",
      "title": "Title",
      "default": ""
    },
    "Description": {
      "$id": "#/properties/Description",
      "type": "string",
      "title": "Description",
      "default": ""
    }
  }
};
*/