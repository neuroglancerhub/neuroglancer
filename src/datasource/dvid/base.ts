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

import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import { vec3 } from "#src/util/geom.js";

const annotationChunkDataSize = vec3.fromValues(128, 128, 128);

export enum VolumeChunkEncoding {
  JPEG = 0,
  RAW = 1,
  COMPRESSED_SEGMENTATION = 2,
  COMPRESSED_SEGMENTATIONARRAY = 3,
}

export class DVIDSourceParameters {
  baseUrl: string;
  nodeKey: string;
  dataInstanceKey: string;
  authServer?: string;
  user?: string;
  usertag?: boolean;
  dvidService?: string;
  forceDvidService?: boolean;
  supervoxels?: boolean;
}

export class VolumeChunkSourceParameters extends DVIDSourceParameters {
  dataScale: string;
  encoding: VolumeChunkEncoding;
  static RPC_ID = "dvid/VolumeChunkSource";
}

export class SkeletonSourceParameters extends DVIDSourceParameters {
  static RPC_ID = "dvid/SkeletonSource";
}

export class MeshSourceParameters extends DVIDSourceParameters {
  segmentationName: string;
  static RPC_ID = "dvid/MeshSource";
}

export class AnnotationSourceParametersBase extends DVIDSourceParameters {
  chunkDataSize = annotationChunkDataSize;
  properties: AnnotationPropertySpec[];
  syncedLabel?: string;
  readonly?: boolean;
  schema?: any;
}

export class AnnotationSourceParameters extends AnnotationSourceParametersBase {
  static RPC_ID = "dvid/AnnotationSource";
}

export class AnnotationChunkSourceParameters extends AnnotationSourceParametersBase {
  static RPC_ID = "dvid/AnnotationChunkSource";
}
