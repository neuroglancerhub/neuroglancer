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

import { vec3 } from "#src/util/geom.js";
import {
  parseFiniteVec,
  parseIntVec,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyPositiveInt,
} from "#src/util/json.js";

export class VolumeInfo {
  numChannels: number;
  voxelSize: vec3;
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  blockSize: vec3;
  numLevels = 1;

  constructor(obj: any, format: string) {
    try {
      verifyObject(obj);
      if (format === "dvid") {
        const extended = verifyObjectProperty(obj, "Extended", verifyObject);
        if (extended.MaxDownresLevel) {
          const maxdownreslevel = verifyObjectProperty(
            extended,
            "MaxDownresLevel",
            verifyPositiveInt,
          );
          this.numLevels = maxdownreslevel + 1;
        }

        this.voxelSize = verifyObjectProperty(extended, "VoxelSize", (x) =>
          parseIntVec(vec3.create(), x),
        );
        this.upperVoxelBound = verifyObjectProperty(
          extended,
          "MaxPoint",
          (x) =>
            parseIntVec(
              vec3.create(),
              x.map((a: number) => ++a),
            ),
        );
        this.lowerVoxelBound = verifyObjectProperty(
          extended,
          "MinPoint",
          (x) => parseIntVec(vec3.create(), x),
        );
        this.blockSize = verifyObjectProperty(extended, "BlockSize", (x) =>
          parseIntVec(vec3.create(), x),
        );
      } else if (format === "gs") {
        const scaleInfos = verifyObjectProperty(obj, "scales", (x) => x);
        if (scaleInfos.length === 0)
          throw new Error("Expected at least one scale");
        const baseScale = scaleInfos[0];
        this.voxelSize = verifyObjectProperty(
          baseScale,
          "resolution",
          (x) => parseFiniteVec(vec3.create(), x),
        );
        this.lowerVoxelBound =
          verifyOptionalObjectProperty(baseScale, "offset", (x) =>
            parseIntVec(vec3.create(), x),
          ) || vec3.fromValues(0, 0, 0);
        const boxSize = verifyObjectProperty(baseScale, "size", (x) =>
          parseIntVec(vec3.create(), x),
        );
        this.upperVoxelBound = vec3.add(
          vec3.create(),
          boxSize,
          this.lowerVoxelBound,
        );
        this.blockSize = vec3.fromValues(64, 64, 64);
      } else {
        throw new Error("unrecognized volume info");
      }
    } catch (parseError) {
      throw new Error(
        `Failed to parse volume geometry: ${(parseError as Error).message}`,
      );
    }
  }
}

export class MultiscaleVolumeInfo {
  scales: VolumeInfo[];

  get numChannels() {
    if (this.scales.length === 0) {
      return 0;
    }
    return this.scales[0].numChannels;
  }

  constructor(baseVolumeInfo: VolumeInfo) {
    try {
      this.scales = [];
      this.scales.push(baseVolumeInfo);
      let lastVoxelSize = baseVolumeInfo.voxelSize;
      let lastLowerBounds = baseVolumeInfo.lowerVoxelBound;
      let lastUpperBounds = baseVolumeInfo.upperVoxelBound;
      for (let level = 1; level < baseVolumeInfo.numLevels; ++level) {
        const volumeInfo: VolumeInfo = { ...baseVolumeInfo };
        volumeInfo.voxelSize = vec3.multiply(
          vec3.create(),
          lastVoxelSize,
          vec3.fromValues(2, 2, 2),
        );
        lastVoxelSize = volumeInfo.voxelSize;
        volumeInfo.upperVoxelBound = vec3.ceil(
          vec3.create(),
          vec3.divide(
            vec3.create(),
            lastUpperBounds,
            vec3.fromValues(2, 2, 2),
          ),
        );
        lastUpperBounds = volumeInfo.upperVoxelBound;
        volumeInfo.lowerVoxelBound = vec3.ceil(
          vec3.create(),
          vec3.divide(
            vec3.create(),
            lastLowerBounds,
            vec3.fromValues(2, 2, 2),
          ),
        );
        lastLowerBounds = volumeInfo.lowerVoxelBound;
        this.scales.push(volumeInfo);
      }
    } catch (parseError) {
      throw new Error(
        `Failed to parse multiscale volume specification: ${(parseError as Error).message}`,
      );
    }
  }
}
