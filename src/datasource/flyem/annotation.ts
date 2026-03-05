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

import type {
  Annotation,
  AnnotationBase,
  AnnotationId,
  Line,
  Point,
} from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type { AnnotationGeometryChunkSource } from "#src/annotation/frontend_source.js";
import { registerRPC } from "#src/worker_rpc.js";

export const ANNOTATION_COMMIT_ADD_SIGNAL_RPC_ID = "annotation.add.signal";

registerRPC(ANNOTATION_COMMIT_ADD_SIGNAL_RPC_ID, function (x) {
  const source = <AnnotationGeometryChunkSource>this.get(x.id);
  const newAnnotation: Annotation | null = x.newAnnotation;
  if (newAnnotation) {
    (source as any).parent?.updateReference?.(newAnnotation);
    (source as any).parent?.childAdded?.dispatch(newAnnotation);
  }
});

type GConstructor<T> = new (...args: any[]) => T;

export function WithFlyEMProp<TBase extends GConstructor<AnnotationBase>>(
  Base: TBase,
) {
  class C extends Base {
    kind?: string;
    source?: string;
    key?: string;
    prop?: { [key: string]: any };
    ext?: { [key: string]: any };
    constructor(...args: any[]) {
      super(...args);
    }
  }

  return C;
}

class TAnnotationBase implements AnnotationBase {
  description?: string | undefined | null;
  id: AnnotationId = "";
  type: AnnotationType = AnnotationType.POINT;
  relatedSegments?: BigUint64Array[];
  properties: any[] = [];
}

class TPoint extends TAnnotationBase implements Point {
  point: Float32Array = new Float32Array(3);
  type: AnnotationType.POINT = AnnotationType.POINT;
}

class TLine extends TAnnotationBase implements Line {
  pointA: Float32Array = new Float32Array(3);
  pointB: Float32Array = new Float32Array(3);
  type: AnnotationType.LINE = AnnotationType.LINE;
}

/**
 * Sphere annotation is represented like a Line (two endpoints: center and
 * surface point) but renders as a sphere.
 */
class TSphere extends TAnnotationBase {
  pointA: Float32Array = new Float32Array(3);
  pointB: Float32Array = new Float32Array(3);
  type: AnnotationType.SPHERE = AnnotationType.SPHERE;
}

export class PointAnnotation extends WithFlyEMProp(TPoint) {}

export class LineAnnotation extends WithFlyEMProp(TLine) {}

export class SphereAnnotation extends WithFlyEMProp(TSphere) {}

export type FlyEMAnnotation =
  | PointAnnotation
  | LineAnnotation
  | SphereAnnotation;

export class AnnotationFacade {
  annotation: FlyEMAnnotation;
  constructor(annotation: AnnotationBase) {
    this.annotation = annotation as FlyEMAnnotation;
  }

  get renderingAttribute(): number {
    if (this.kind === "Atlas") {
      if (!this.title) {
        return -1;
      } else if (this.checked) {
        return 1;
      }
    } else {
      if (this.bookmarkType === "False Split") {
        return 2;
      } else if (this.bookmarkType === "False Merge") {
        return 3;
      }
    }

    return 0;
  }

  get confidence(): number {
    return 0;
  }

  updateProperties() {
    this.annotation.properties = [this.renderingAttribute, this.confidence];
  }

  get ext() {
    if (this.annotation.ext === undefined) {
      this.annotation.ext = {};
    }

    return this.annotation.ext;
  }

  get prop() {
    return this.annotation.prop;
  }

  set prop(value: { [key: string]: any } | undefined) {
    this.annotation.prop = value;
  }

  get bookmarkType() {
    if (this.prop) {
      switch (this.prop.type) {
        case "Split":
          return "False Merge";
        case "Merge":
          return "False Split";
        default:
          break;
      }
    }

    return "Other";
  }

  get type() {
    return this.annotation.type;
  }

  get kind() {
    return this.annotation.kind;
  }

  set kind(value) {
    this.annotation.kind = value;
    this.update();
  }

  roundPos() {
    if (this.annotation.type === AnnotationType.POINT) {
      const point = this.annotation as PointAnnotation;
      point.point = Float32Array.from(point.point, (x) => Math.round(x));
    } else if (
      this.annotation.type === AnnotationType.LINE ||
      this.annotation.type === AnnotationType.SPHERE
    ) {
      const line = this.annotation as LineAnnotation | SphereAnnotation;
      line.pointA = Float32Array.from(line.pointA, (x) => Math.round(x));
      line.pointB = Float32Array.from(line.pointB, (x) => Math.round(x));
    }
  }

  setProp(prop: { [key: string]: any }) {
    this.prop = { ...this.prop, ...prop };
  }

  get user() {
    return this.prop && this.prop.user;
  }

  set user(value) {
    this.setProp({ user: value });
  }

  get comment() {
    return this.prop && this.prop.comment;
  }

  get description() {
    return this.comment;
  }

  updatePresentation() {
    if (this.title) {
      this.annotation.description = this.title + ": ";
    } else {
      this.annotation.description = "";
    }

    if (this.description) {
      this.annotation.description += this.description;
    }
  }

  update() {
    this.updatePresentation();
    this.updateProperties();
  }

  set comment(s) {
    this.setProp({ comment: s });
    this.updatePresentation();
  }

  updateComment() {
    this.comment = this.annotation.description || "";
    this.annotation.description = undefined;
  }

  get title() {
    return this.prop && this.prop.title;
  }

  set title(s) {
    this.setProp({ title: s });
    this.updatePresentation();
  }

  get timestamp() {
    return this.prop && this.prop.timestamp
      ? Number(this.prop.timestamp)
      : 0;
  }

  addTimeStamp() {
    this.setProp({ timestamp: String(Date.now()) });
  }

  get checked() {
    return (
      (this.ext && this.ext.verified) ||
      (this.prop && this.prop.checked) ||
      false
    );
  }

  set checked(c) {
    this.setProp({ checked: c });
  }

  get presentation() {
    this.updatePresentation();

    return this.annotation.description || "";
  }

  set presentation(value: string) {
    this.annotation.description = value;
  }
}

export function typeOfAnnotationId(id: AnnotationId) {
  if (
    id.match(/^-?\d+_-?\d+_-?\d+[\[]?/) ||
    id.match(/^Pt-?\d+_-?\d+_-?\d+/)
  ) {
    return AnnotationType.POINT;
  } else if (
    id.match(/^-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+-Line$/) ||
    id.match(/^Ln-?\d+_-?\d+_-?\d+_?\d+_-?\d+_-?\d+/)
  ) {
    return AnnotationType.LINE;
  } else if (
    id.match(/^-?\d+_-?\d+_-?\d+--?\d+_-?\d+_-?\d+-Sphere$/) ||
    id.match(/^Sp-?\d+_-?\d+_-?\d+_?\d+_-?\d+_-?\d+/)
  ) {
    return AnnotationType.SPHERE;
  } else {
    console.log(`Invalid annotation ID for DVID: ${id}`);
    return null;
  }
}

function getAnnotationUser(annotation: FlyEMAnnotation) {
  return (
    (annotation.ext && annotation.ext.user) ||
    (annotation.prop && annotation.prop.user)
  );
}

export function getAnnotationKey(
  annotation: FlyEMAnnotation,
  keyHandle?: string,
) {
  let key = keyHandle || annotation.key;

  if (!key) {
    switch (annotation.type) {
      case AnnotationType.POINT: {
        const point = annotation as PointAnnotation;
        key = `Pt${point.point[0]}_${point.point[1]}_${point.point[2]}`;
        break;
      }
      case AnnotationType.LINE: {
        const line = annotation as LineAnnotation;
        key = `Ln${line.pointA[0]}_${line.pointA[1]}_${line.pointA[2]}_${line.pointB[0]}_${line.pointB[1]}_${line.pointB[2]}`;
        break;
      }
      case AnnotationType.SPHERE: {
        const sphere = annotation as SphereAnnotation;
        key = `Sp${sphere.pointA[0]}_${sphere.pointA[1]}_${sphere.pointA[2]}_${sphere.pointB[0]}_${sphere.pointB[1]}_${sphere.pointB[2]}`;
        break;
      }
    }
  }

  return key;
}

export function getAnnotationId(
  annotation: FlyEMAnnotation,
  keyHandle?: string,
) {
  return `${getAnnotationKey(annotation, keyHandle)}[user:${getAnnotationUser(annotation)}]`;
}

export function parseAnnotationId(id: string) {
  const matched = id.match(/(.*)\\[user:(.*)\\]/);

  return matched && { key: matched[1], user: matched[2] };
}

export function isAnnotationIdValid(id: AnnotationId) {
  return typeOfAnnotationId(id) !== null;
}

/**
 * Decode a JWT token payload.
 * Adapted from https://stackoverflow.com/questions/38552003/how-to-decode-jwt-token-in-javascript-without-using-a-library
 */
function parseToken(token: string) {
  const base64Url = token.split(".")[1];
  if (base64Url) {
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      window
        .atob(base64)
        .split("")
        .map(function (c) {
          return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join(""),
    );

    return JSON.parse(jsonPayload);
  }
}

export function getUserFromToken(token: string, defaultUser?: string) {
  let tokenUser: string | undefined = undefined;
  const obj = parseToken(token);
  if (obj) {
    if ("user" in obj) {
      tokenUser = obj["user"];
    } else if ("email" in obj) {
      tokenUser = obj["email"];
    }
  }

  if (tokenUser) {
    if (defaultUser && defaultUser !== tokenUser) {
      return undefined;
    }
  } else {
    tokenUser = defaultUser;
  }

  return tokenUser;
}

export const defaultJsonSchema = {
  definitions: {},
  type: "object",
  required: ["Prop"],
  properties: {
    Prop: {
      $id: "#/properties/Prop",
      type: "object",
      title: "Properties",
      required: ["comment"],
      properties: {
        comment: {
          $id: "#/properties/Prop/properties/comment",
          type: "string",
          title: "Comment",
          default: "",
        },
      },
    },
  },
};
