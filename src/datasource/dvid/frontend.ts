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
 * @file
 * Support for DVID (https://github.com/janelia-flyem/dvid) servers.
 */

import type { Annotation } from "#src/annotation/index.js";
import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { BoundingBox } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type { DVIDToken } from "#src/datasource/dvid/api.js";
import {
  credentialsKey,
  fetchWithDVIDCredentials,
} from "#src/datasource/dvid/api.js";
import type { DVIDSourceParameters } from "#src/datasource/dvid/base.js";
import {
  AnnotationChunkSourceParameters,
  AnnotationSourceParameters,
  MeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/dvid/base.js";
import {
  VolumeInfo,
  MultiscaleVolumeInfo,
} from "#src/datasource/flyem/datainfo.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import {
  applyCompletionOffset,
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import { mat4, vec3 } from "#src/util/geom.js";
import {
  parseArray,
  parseQueryStringParameters,
  verifyMapKey,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectAsMap,
  verifyObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { Signal } from "#src/util/signal.js";

const serverDataTypes = new Map<string, DataType>();
serverDataTypes.set("uint8", DataType.UINT8);
serverDataTypes.set("uint32", DataType.UINT32);
serverDataTypes.set("uint64", DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string {
    return this.obj.TypeName;
  }

  get compressionName(): string {
    return this.obj.Compression;
  }

  get tags() {
    return this.obj.Tags;
  }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, "TypeName", verifyString);
  }
}

export class DataInstanceInfo {
  volumeInfo: VolumeInfo;

  get lowerVoxelBound() {
    return this.volumeInfo.lowerVoxelBound;
  }

  get upperVoxelBound() {
    return this.volumeInfo.upperVoxelBound;
  }

  get blockSize() {
    return this.volumeInfo.blockSize;
  }

  get voxelSize() {
    return this.volumeInfo.voxelSize;
  }

  get numLevels() {
    return this.volumeInfo.numLevels;
  }

  constructor(
    obj: any,
    public name: string,
    public base: DataInstanceBaseInfo,
  ) {
    this.volumeInfo = new VolumeInfo(
      getVolumeInfoResponseFromTags(base.tags, obj),
      "dvid",
    );
  }
}

class DVIDVolumeChunkSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

class DVIDSkeletonSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(SkeletonSource),
  SkeletonSourceParameters,
) {}

class DVIDMeshSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(MeshSource),
  MeshSourceParameters,
) {}

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  meshSrc: string;
  skeletonSrc: string;

  constructor(
    obj: any,
    name: string,
    base: DataInstanceBaseInfo,
    public encoding: VolumeChunkEncoding,
    instanceNames: Array<string>,
  ) {
    super(obj, name, base);
    const extended = verifyObjectProperty(obj, "Extended", verifyObject);
    const extendedValues = verifyObjectProperty(extended, "Values", (x) =>
      parseArray(x, verifyObject),
    );
    if (extendedValues.length < 1) {
      throw new Error(
        "Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.",
      );
    }

    const instSet = new Set<string>(instanceNames);
    if (encoding !== VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      while (instSet.has(name + "_" + this.volumeInfo.numLevels.toString())) {
        this.volumeInfo.numLevels += 1;
      }
    }

    if (instSet.has(name + "_meshes")) {
      this.meshSrc = name + "_meshes";
    } else {
      this.meshSrc = "";
    }

    if (instSet.has(name + "_skeletons")) {
      this.skeletonSrc = name + "_skeletons";
    } else {
      this.skeletonSrc = "";
    }

    this.dataType = verifyObjectProperty(extendedValues[0], "DataType", (x) =>
      verifyMapKey(x, serverDataTypes),
    );
  }

  get volumeType() {
    return this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
      this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY
      ? VolumeType.SEGMENTATION
      : VolumeType.IMAGE;
  }

  getSources(
    chunkManager: ChunkManager,
    parameters: DVIDSourceParameters,
    volumeSourceOptions: VolumeSourceOptions,
    credentialsProvider: CredentialsProvider<DVIDToken>,
  ) {
    const { encoding } = this;
    const sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    // must be 64 block size to work with neuroglancer properly
    const blocksize = 64;
    for (let level = 0; level < this.numLevels; ++level) {
      const downsampleFactor = 2 ** level;
      const invDownsampleFactor = 2 ** -level;
      const lowerVoxelBound = vec3.create();
      const upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        const lowerVoxelNotAligned = Math.floor(
          this.lowerVoxelBound[i] * invDownsampleFactor,
        );
        // adjust min to be a multiple of blocksize
        lowerVoxelBound[i] =
          lowerVoxelNotAligned - (lowerVoxelNotAligned % blocksize);
        const upperVoxelNotAligned = Math.ceil(
          this.upperVoxelBound[i] * invDownsampleFactor,
        );
        upperVoxelBound[i] = upperVoxelNotAligned;
        // adjust max to be a multiple of blocksize
        if (upperVoxelNotAligned % blocksize !== 0) {
          upperVoxelBound[i] += blocksize - (upperVoxelNotAligned % blocksize);
        }
      }
      let dataInstanceKey = parameters.dataInstanceKey;

      if (encoding !== VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
        if (level > 0) {
          dataInstanceKey += "_" + level.toString();
        }
      }

      const volParameters: VolumeChunkSourceParameters = {
        ...parameters,
        dataInstanceKey,
        dataScale: level.toString(),
        encoding,
      };
      const chunkToMultiscaleTransform = mat4.create();
      for (let i = 0; i < 3; ++i) {
        chunkToMultiscaleTransform[5 * i] = downsampleFactor;
        chunkToMultiscaleTransform[12 + i] =
          lowerVoxelBound[i] * downsampleFactor;
      }
      const alternatives = makeDefaultVolumeChunkSpecifications({
        rank: 3,
        chunkToMultiscaleTransform,
        dataType: this.dataType,

        baseVoxelOffset: lowerVoxelBound,
        upperVoxelBound: vec3.subtract(
          vec3.create(),
          upperVoxelBound,
          lowerVoxelBound,
        ),
        volumeType: this.volumeType,
        volumeSourceOptions,
        compressedSegmentationBlockSize:
          encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
          encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY
            ? vec3.fromValues(8, 8, 8)
            : undefined,
      }).map((spec) => ({
        chunkSource: chunkManager.getChunkSource(DVIDVolumeChunkSource, {
          spec,
          parameters: volParameters,
          credentialsProvider,
        }),
        chunkToMultiscaleTransform,
      }));
      sources.push(alternatives);
    }
    return transposeNestedArrays(sources);
  }
}

function getSyncedLabel(dataInfo: any): string {
  const baseInfo = verifyObjectProperty(dataInfo, "Base", verifyObject);
  const syncs = verifyObjectProperty(baseInfo, "Syncs", verifyStringArray);

  if (syncs.length === 1) {
    return syncs[0];
  }
  return "";
}

function getVolumeInfoResponseFromTags(tags: any, defaultObj: any) {
  if (!tags) {
    return defaultObj;
  }

  const defaultExtended = (defaultObj && defaultObj.Extended) || {};
  let { MaxDownresLevel, MaxPoint, MinPoint, VoxelSize, BlockSize } =
    defaultExtended;

  try {
    if (tags.MaxDownresLevel && typeof tags.MaxDownresLevel === "string") {
      MaxDownresLevel = parseInt(
        verifyObjectProperty(tags, "MaxDownresLevel", verifyString),
      );
      if (MaxDownresLevel < 0) {
        MaxDownresLevel = defaultExtended.MaxDownresLevel;
      }
    } else if (typeof tags.MaxDownresLevel === "number") {
      MaxDownresLevel = verifyObjectProperty(
        tags,
        "MaxDownresLevel",
        verifyNonnegativeInt,
      );
    }
  } catch (_e) {
    // ignore
  }

  try {
    if (tags.MaxPoint && typeof tags.MaxPoint === "string") {
      MaxPoint = JSON.parse(
        verifyObjectProperty(tags, "MaxPoint", verifyString),
      );
    } else if (Array.isArray(tags.MaxPoint) && tags.MaxPoint.length === 3) {
      MaxPoint = tags.MaxPoint;
    }
  } catch (_e) {
    // ignore
  }

  try {
    if (tags.MinPoint && typeof tags.MinPoint === "string") {
      MinPoint = JSON.parse(
        verifyObjectProperty(tags, "MinPoint", verifyString),
      );
    } else if (Array.isArray(tags.MinPoint) && tags.MinPoint.length === 3) {
      MinPoint = tags.MinPoint;
    }
  } catch (_e) {
    // ignore
  }

  try {
    if (tags.VoxelSize && typeof tags.VoxelSize === "string") {
      VoxelSize = JSON.parse(
        verifyObjectProperty(tags, "VoxelSize", verifyString),
      );
    } else if (Array.isArray(tags.VoxelSize) && tags.VoxelSize.length === 3) {
      VoxelSize = tags.VoxelSize;
    }
  } catch (_e) {
    // ignore
  }

  try {
    if (tags.BlockSize && typeof tags.BlockSize === "string") {
      BlockSize = JSON.parse(
        verifyObjectProperty(tags, "BlockSize", verifyString),
      );
    } else if (Array.isArray(tags.BlockSize) && tags.BlockSize.length === 3) {
      BlockSize = tags.BlockSize;
    }
  } catch (_e) {
    // ignore
  }

  const defaultBase = defaultObj && defaultObj.Base;
  const response: any = {
    Base: defaultBase || {},
    Extended: {
      ...defaultExtended,
      VoxelSize,
      MinPoint,
      MaxPoint,
      MaxDownresLevel,
      BlockSize,
    },
  };

  return response;
}

export class AnnotationDataInstanceInfo extends DataInstanceInfo {
  get tags() {
    return verifyObjectProperty(this.base.obj, "Tags", verifyObject);
  }

  constructor(obj: any, name: string, base: DataInstanceBaseInfo) {
    super(obj, name, base);
  }
}

function parseDataInstanceFromRepoInfo(
  dataInstanceObjs: any,
  name: string,
  instanceNames: Array<string>,
): DataInstanceInfo {
  verifyObject(dataInstanceObjs);
  let dataInstanceObj = dataInstanceObjs[name];
  const baseInfo = verifyObjectProperty(
    dataInstanceObj,
    "Base",
    (x) => new DataInstanceBaseInfo(x),
  );
  if (baseInfo.typeName === "annotation") {
    const syncedLabel = getSyncedLabel(dataInstanceObj);
    if (syncedLabel) {
      dataInstanceObj = dataInstanceObjs[syncedLabel];
    }
    return new AnnotationDataInstanceInfo(dataInstanceObj, name, baseInfo);
  }
  return parseDataInstance(dataInstanceObj, name, instanceNames);
}

export function parseDataInstance(
  obj: any,
  name: string,
  instanceNames: Array<string>,
): DataInstanceInfo {
  verifyObject(obj);
  const baseInfo = verifyObjectProperty(
    obj,
    "Base",
    (x) => new DataInstanceBaseInfo(x),
  );
  switch (baseInfo.typeName) {
    case "uint8blk":
    case "grayscale8": {
      const isjpegcompress = baseInfo.compressionName.indexOf("jpeg") !== -1;
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        isjpegcompress ? VolumeChunkEncoding.JPEG : VolumeChunkEncoding.RAW,
        instanceNames,
      );
    }
    case "labels64":
    case "labelblk":
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
        instanceNames,
      );
    case "labelarray":
    case "labelmap":
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY,
        instanceNames,
      );
    default:
      throw new Error(
        `DVID data type ${JSON.stringify(baseInfo.typeName)} is not supported.`,
      );
  }
}

export class RepositoryInfo {
  alias: string;
  description: string;
  errors: string[] = [];
  dataInstances = new Map<string, DataInstanceInfo>();
  uuid: string;
  vnodes = new Set<string>();
  constructor(obj: any) {
    if (obj instanceof RepositoryInfo) {
      this.alias = obj.alias;
      this.description = obj.description;
      // just copy references
      this.errors = obj.errors;
      this.dataInstances = obj.dataInstances;
      return;
    }
    verifyObject(obj);
    this.alias = verifyObjectProperty(obj, "Alias", verifyString);
    this.description = verifyObjectProperty(obj, "Description", verifyString);
    const dataInstanceObjs = verifyObjectProperty(
      obj,
      "DataInstances",
      verifyObject,
    );
    const instanceKeys = Object.keys(dataInstanceObjs);
    for (const key of instanceKeys) {
      try {
        this.dataInstances.set(
          key,
          parseDataInstanceFromRepoInfo(dataInstanceObjs, key, instanceKeys),
        );
      } catch (parseError) {
        const message = `Failed to parse data instance ${JSON.stringify(
          key,
        )}: ${(parseError as Error).message}`;
        console.log(message);
        this.errors.push(message);
      }
    }

    const dagObj = verifyObjectProperty(obj, "DAG", verifyObject);
    const nodeObjs = verifyObjectProperty(dagObj, "Nodes", verifyObject);
    for (const key of Object.keys(nodeObjs)) {
      this.vnodes.add(key);
    }
  }
}

export function parseRepositoriesInfo(obj: any) {
  try {
    const result = verifyObjectAsMap(obj, (x) => new RepositoryInfo(x));

    // make all versions available for viewing
    const allVersions = new Map<string, RepositoryInfo>();
    for (const [key, info] of result) {
      allVersions.set(key, info);
      for (const key2 of info.vnodes) {
        if (key2 !== key) {
          // create new repo
          const rep = new RepositoryInfo(info);
          allVersions.set(key2, rep);
        }
      }
    }

    for (const [key, info] of allVersions) {
      info.uuid = key;
    }
    return allVersions;
  } catch (parseError) {
    throw new Error(
      `Failed to parse DVID repositories info: ${(parseError as Error).message}`,
    );
  }
}

export class ServerInfo {
  repositories: Map<string, RepositoryInfo>;
  constructor(obj: any) {
    this.repositories = parseRepositoriesInfo(obj);
  }

  getNode(nodeKey: string): RepositoryInfo {
    // FIXME: Support non-root nodes.
    const matches: string[] = [];
    for (const key of this.repositories.keys()) {
      if (key.startsWith(nodeKey)) {
        matches.push(key);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `Node key ${JSON.stringify(nodeKey)} matches ${JSON.stringify(
          matches,
        )} nodes.`,
      );
    }
    return this.repositories.get(matches[0])!;
  }
}

export function getServerInfo(
  chunkManager: ChunkManager,
  baseUrl: string,
  credentialsProvider: CredentialsProvider<DVIDToken>,
  options: Partial<ProgressOptions>,
) {
  return chunkManager.memoize.getAsync(
    { type: "dvid:getServerInfo", baseUrl },
    options,
    async (progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Retrieving repository info for DVID server ${baseUrl}`,
      });
      const response = await fetchWithDVIDCredentials(
        credentialsProvider,
        `${baseUrl}/api/repos/info`,
        progressOptions,
      );
      return new ServerInfo(await response.json());
    },
  );
}

function getAnnotationChunkDataSize(
  parameters: AnnotationSourceParameters,
  lowerVoxelBound: vec3,
  upperVoxelBound: vec3,
) {
  if (parameters.usertag) {
    return vec3.sub(vec3.create(), upperVoxelBound, lowerVoxelBound);
  }
  return parameters.chunkDataSize;
}

function makeAnnotationGeometrySourceSpecifications(
  multiscaleInfo: MultiscaleVolumeInfo,
  parameters: AnnotationSourceParameters,
) {
  const rank = 3;

  const makeSpec = (volumeInfo: VolumeInfo) => {
    const { lowerVoxelBound, upperVoxelBound } = volumeInfo;
    const chunkDataSize = getAnnotationChunkDataSize(
      parameters,
      lowerVoxelBound,
      upperVoxelBound,
    );
    const spec = makeSliceViewChunkSpecification({
      rank,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      lowerVoxelBound,
      upperVoxelBound,
    });

    return { spec, chunkToMultiscaleTransform: mat4.create() };
  };

  if (parameters.usertag) {
    if (parameters.user) {
      return [[makeSpec(multiscaleInfo.scales[0])]];
    }
    throw new Error("Expecting a valid user");
  }
  return [multiscaleInfo.scales.map((scale) => makeSpec(scale))];
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<DVIDToken>()(MultiscaleAnnotationSource),
  AnnotationSourceParameters,
);

class DVIDAnnotationChunkSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(AnnotationGeometryChunkSource),
  AnnotationChunkSourceParameters,
) {}

export class DVIDAnnotationSource extends MultiscaleAnnotationSourceBase {
  declare key: any;
  readonly = false;
  private multiscaleVolumeInfo: MultiscaleVolumeInfo;
  private chunkSources: SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][];

  constructor(
    chunkManager: ChunkManager,
    options: {
      credentialsProvider: CredentialsProvider<DVIDToken>;
      parameters: AnnotationSourceParameters;
      multiscaleVolumeInfo: MultiscaleVolumeInfo;
    },
  ) {
    super(chunkManager, {
      rank: 3,
      relationships: ["segments"],
      properties: options.parameters.properties,
      ...options,
    });

    this.parameters = options.parameters;
    this.multiscaleVolumeInfo = options.multiscaleVolumeInfo;

    this.childAdded =
      this.childAdded || new Signal<(annotation: Annotation) => void>();
    this.childUpdated =
      this.childUpdated || new Signal<(annotation: Annotation) => void>();
    this.childDeleted =
      this.childDeleted || new Signal<(annotationId: string) => void>();

    if (this.parameters.readonly !== undefined) {
      this.readonly = this.parameters.readonly;
    }

    if (!this.parameters.user) {
      this.readonly = true;
    }
  }

  getSources(
    _options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    const sourceSpecifications = makeAnnotationGeometrySourceSpecifications(
      this.multiscaleVolumeInfo,
      this.parameters,
    );

    let limit = 0;
    if (sourceSpecifications[0].length > 1) {
      limit = 3;
    }

    this.chunkSources = sourceSpecifications.map((alternatives) =>
      alternatives.map(({ spec, chunkToMultiscaleTransform }) => ({
        chunkSource: this.chunkManager.getChunkSource(
          DVIDAnnotationChunkSource,
          {
            spec: { limit, chunkToMultiscaleTransform, ...spec },
            parent: this,
            credentialsProvider: this.credentialsProvider,
            parameters: this.parameters,
          },
        ),
        chunkToMultiscaleTransform,
      })),
    );

    return this.chunkSources;
  }

  invalidateCache() {
    this.metadataChunkSource.invalidateCache();
    for (const sources1 of this.chunkSources) {
      for (const source of sources1) {
        source.chunkSource.invalidateCache();
      }
    }

    for (const source of this.segmentFilteredSources) {
      source.invalidateCache();
    }
    this.childRefreshed.dispatch();
  }
}

class DvidMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.info.dataType;
  }
  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return 3;
  }

  get baseUrl() {
    return this.sourceParameters.baseUrl;
  }

  get nodeKey() {
    return this.sourceParameters.nodeKey;
  }

  get dataInstanceKey() {
    return this.sourceParameters.dataInstanceKey;
  }

  get supervoxels() {
    return this.sourceParameters.supervoxels || false;
  }

  constructor(
    chunkManager: ChunkManager,
    public sourceParameters: DVIDSourceParameters,
    public info: VolumeDataInstanceInfo,
    public credentialsProvider: CredentialsProvider<DVIDToken>,
  ) {
    super(chunkManager);
  }

  getSegmentPosition?(id: bigint): Promise<Float32Array> {
    const { dvidService } = this.sourceParameters;
    if (dvidService) {
      return fetch(
        `${dvidService}/locate-body?dvid=${this.baseUrl}&uuid=${this.nodeKey}&segmentation=${this.dataInstanceKey}&body=${id.toString()}${this.supervoxels ? "&supervoxels=true" : ""}`,
        { method: "GET" },
      )
        .then((response) => response.json())
        .then((location) => new Float32Array(location));
    }

    return Promise.reject("No locate service is available");
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
      this.chunkManager,
      this.sourceParameters,
      volumeSourceOptions,
      this.credentialsProvider,
    );
  }
}

const urlPattern =
  /^((?:http|https):\/\/[^/]+)\/([^/]+)\/([^/?#]+)(?:(?:\?|#)(.*))?$/;

function getDefaultAuthServer(baseUrl: string) {
  if (baseUrl.startsWith("https")) {
    // Use default token API for DVID https to make completeUrl work properly
    return baseUrl + "/api/server/token";
  }
  return undefined;
}

function parseSourceUrl(url: string): DVIDSourceParameters {
  const match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  const sourceParameters: DVIDSourceParameters = {
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };

  const queryString = match[4];
  if (queryString) {
    const parameters = parseQueryStringParameters(queryString);
    if (parameters.usertag === "true") {
      sourceParameters.usertag = true;
    }

    if (parameters.user) {
      sourceParameters.user = parameters.user;
    }

    const dvidService =
      parameters.dvidService ||
      parameters.dvidservice ||
      parameters["dvid-service"];
    if (dvidService) {
      sourceParameters.dvidService = dvidService;
    }

    const force =
      parameters.forceDvidService ||
      parameters.forcedvidservice ||
      parameters["force-dvid-service"];
    if (force) {
      sourceParameters.forceDvidService = true;
    }

    sourceParameters.supervoxels = parameters.supervoxels === "true";
  }
  sourceParameters.authServer = getDefaultAuthServer(sourceParameters.baseUrl);
  return sourceParameters;
}

async function getAnnotationChunkSource(
  options: GetDataSourceOptions,
  sourceParameters: AnnotationSourceParameters,
  dataInstanceInfo: AnnotationDataInstanceInfo,
  credentialsProvider: CredentialsProvider<DVIDToken>,
) {
  const multiscaleVolumeInfo = new MultiscaleVolumeInfo(
    dataInstanceInfo.volumeInfo,
  );

  return options.registry.chunkManager.getChunkSource(DVIDAnnotationSource, {
    parameters: sourceParameters,
    credentialsProvider,
    multiscaleVolumeInfo,
  } as any);
}

async function getAnnotationSource(
  options: GetDataSourceOptions,
  sourceParameters: AnnotationSourceParameters,
  dataInstanceInfo: AnnotationDataInstanceInfo,
  credentialsProvider: CredentialsProvider<DVIDToken>,
) {
  const box: BoundingBox = {
    lowerBounds: new Float64Array(dataInstanceInfo.lowerVoxelBound),
    upperBounds: Float64Array.from(dataInstanceInfo.upperVoxelBound),
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.from(dataInstanceInfo.voxelSize, (x) => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const annotation = await getAnnotationChunkSource(
    options,
    sourceParameters,
    dataInstanceInfo,
    credentialsProvider,
  );

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [
      {
        id: "default",
        subsource: { annotation },
        default: true,
      },
    ],
  };

  return dataSource;
}

function getVolumeSource(
  options: GetDataSourceOptions,
  sourceParameters: DVIDSourceParameters,
  dataInstanceInfo: DataInstanceInfo,
  credentialsProvider: CredentialsProvider<DVIDToken>,
) {
  const info = <VolumeDataInstanceInfo>dataInstanceInfo;

  const box: BoundingBox = {
    lowerBounds: new Float64Array(info.lowerVoxelBound),
    upperBounds: Float64Array.from(info.upperVoxelBound),
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.from(info.voxelSize, (x) => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const volume = new DvidMultiscaleVolumeChunkSource(
    options.registry.chunkManager,
    sourceParameters,
    info,
    credentialsProvider,
  );

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [
      {
        id: "default",
        subsource: { volume },
        default: true,
      },
    ],
  };
  if (info.meshSrc) {
    const subsourceToModelSubspaceTransform = mat4.create();
    for (let i = 0; i < 3; ++i) {
      subsourceToModelSubspaceTransform[5 * i] = 1 / info.voxelSize[i];
    }
    dataSource.subsources.push({
      id: "meshes",
      default: true,
      subsource: {
        mesh: options.registry.chunkManager.getChunkSource(DVIDMeshSource, {
          parameters: {
            ...sourceParameters,
            segmentationName: info.name,
            dataInstanceKey: info.meshSrc,
          },
          credentialsProvider: credentialsProvider,
        }),
      },
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletonSrc) {
    dataSource.subsources.push({
      id: "skeletons",
      default: true,
      subsource: {
        mesh: options.registry.chunkManager.getChunkSource(DVIDSkeletonSource, {
          parameters: {
            ...sourceParameters,
            dataInstanceKey: info.skeletonSrc,
          },
          credentialsProvider: credentialsProvider,
        }),
      },
    });
  }
  dataSource.subsources.push({
    id: "bounds",
    subsource: {
      staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box),
    },
    default: true,
  });

  return dataSource;
}

export function getDataSource(
  options: GetDataSourceOptions,
): Promise<DataSource> {
  const sourceParameters = parseSourceUrl(options.providerUrl);
  const { baseUrl, nodeKey, dataInstanceKey } = sourceParameters;

  return options.registry.chunkManager.memoize.getAsync(
    {
      type: "dvid:MultiscaleVolumeChunkSource",
      sourceUrl: options.providerUrl,
    },
    options,
    async (progressOptions) => {
      // To support special nodes like "<UUID>:master" (which  means "the most distant unlocked
      // descendant of <UUID>"), use only "<UUID>" for the validity lookup, below.  If it is
      // valid, then DVID itself will resolve the part after the ":".
      const i = nodeKey.indexOf(":");
      const nodeKeyForLookup = i !== -1 ? nodeKey.slice(0, i) : nodeKey;

      const credentialsProvider =
        options.registry.credentialsManager.getCredentialsProvider<DVIDToken>(
          credentialsKey,
          {
            dvidServer: sourceParameters.baseUrl,
            authServer: sourceParameters.authServer,
          },
        );
      const serverInfo = await getServerInfo(
        options.registry.chunkManager,
        baseUrl,
        credentialsProvider,
        progressOptions,
      );
      const repositoryInfo = serverInfo.getNode(nodeKeyForLookup);
      if (repositoryInfo === undefined) {
        throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
      }
      const dataInstanceInfo =
        repositoryInfo.dataInstances.get(dataInstanceKey);

      if (!dataInstanceInfo) {
        throw new Error(`Invalid data instance ${dataInstanceKey}.`);
      }

      if (dataInstanceInfo.base.typeName === "annotation") {
        if (!(dataInstanceInfo instanceof AnnotationDataInstanceInfo)) {
          throw new Error(`Invalid data instance ${dataInstanceKey}.`);
        }

        const annotationSourceParameters: AnnotationSourceParameters = {
          ...new AnnotationSourceParameters(),
          ...sourceParameters,
        };

        if (dataInstanceInfo.blockSize) {
          annotationSourceParameters.chunkDataSize = dataInstanceInfo.blockSize;
        }
        annotationSourceParameters.syncedLabel = getSyncedLabel({
          Base: dataInstanceInfo.base.obj,
        });
        annotationSourceParameters.properties = [
          {
            identifier: "rendering_attribute",
            description: "rendering attribute",
            type: "int32",
            default: 0,
            min: 0,
            max: 5,
            step: 1,
          },
          {
            identifier: "confidence",
            description: "confidence",
            type: "float32",
            default: 0.0,
            min: 0.0,
            max: 1.0,
            step: 0.01,
          },
        ];

        return getAnnotationSource(
          options,
          annotationSourceParameters,
          dataInstanceInfo,
          credentialsProvider,
        );
      }

      if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
        throw new Error(`Invalid data instance ${dataInstanceKey}.`);
      }
      return getVolumeSource(
        options,
        sourceParameters,
        dataInstanceInfo,
        credentialsProvider,
      );
    },
  );
}

export function completeInstanceName(
  repositoryInfo: RepositoryInfo,
  prefix: string,
): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
      prefix,
      repositoryInfo.dataInstances.values(),
      (instance) => instance.name,
      (instance) => {
        return `${instance.base.typeName}`;
      },
    ),
  };
}

export function completeNodeAndInstance(
  serverInfo: ServerInfo,
  prefix: string,
): CompletionResult {
  const match = prefix.match(/^(?:([^/]+)(?:\/([^/]*))?)?$/);
  if (match === null) {
    throw new Error("Invalid DVID URL syntax.");
  }
  if (match[2] === undefined) {
    // Try to complete the node name.
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions<RepositoryInfo>(
        prefix,
        serverInfo.repositories.values(),
        (repository) => repository.uuid + "/",
        (repository) => `${repository.alias}: ${repository.description}`,
      ),
    };
  }
  const nodeKey = match[1];
  const repositoryInfo = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(
    nodeKey.length + 1,
    completeInstanceName(repositoryInfo, match[2]),
  );
}

export async function completeUrl(
  options: CompleteUrlOptions,
): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^/]+)\/([^?]*).*$/;
  const url = options.providerUrl;

  const match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    throw null;
  }
  const baseUrl = match[1];
  const path = match[2];
  const authServer = getDefaultAuthServer(baseUrl);

  const serverInfo = await getServerInfo(
    options.registry.chunkManager,
    baseUrl,
    options.registry.credentialsManager.getCredentialsProvider<DVIDToken>(
      credentialsKey,
      { dvidServer: baseUrl, authServer },
    ),
    options,
  );
  return applyCompletionOffset(
    baseUrl.length + 1,
    completeNodeAndInstance(serverInfo, path),
  );
}

export class DVIDDataSource implements DataSourceProvider {
  get scheme() {
    return "dvid";
  }
  get description() {
    return "DVID";
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options);
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeUrl(options);
  }
}
