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

import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
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
import type { ClioToken } from "#src/datasource/clio/api.js";
import {
  credentialsKey,
  fetchWithClioCredentials,
  getGrayscaleInfoUrl,
  ClioInstance,
  parseGrayscaleUrl,
} from "#src/datasource/clio/api.js";
import {
  AnnotationSourceParameters,
  AnnotationChunkSourceParameters,
  ClioSourceParameters,
  isAuthRefreshable,
} from "#src/datasource/clio/base.js";
import {
  ClioAnnotationFacade,
  parseDescription,
  defaultAnnotationSchema,
  defaultAtlasSchema,
} from "#src/datasource/clio/utils.js";
import { getUserFromToken } from "#src/datasource/flyem/annotation.js";
import type { FlyEMAnnotation } from "#src/datasource/flyem/annotation.js";
import { VolumeInfo } from "#src/datasource/flyem/datainfo.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import { fetchOk } from "#src/util/http_request.js";
import { mat4, vec3 } from "#src/util/geom.js";
import {
  parseQueryStringParameters,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import { StatusMessage } from "#src/status.js";

class ClioAnnotationChunkSource extends WithParameters(
  WithCredentialsProvider<ClioToken>()(AnnotationGeometryChunkSource),
  AnnotationChunkSourceParameters,
) {}

async function getAnnotationDataInfo(
  parameters: AnnotationSourceParameters,
): Promise<VolumeInfo> {
  const { grayscale } = parameters;
  if (grayscale) {
    const u = parseGrayscaleUrl(grayscale);
    const response = await fetchOk(getGrayscaleInfoUrl(u), { method: "GET" });
    const responseJson = await response.json();
    return new VolumeInfo(
      responseJson,
      u.protocol === "https" ? "gs" : u.protocol,
    );
  } else {
    return {
      numChannels: 1,
      voxelSize: vec3.fromValues(8, 8, 8),
      lowerVoxelBound: vec3.fromValues(0, 0, 0),
      upperVoxelBound: vec3.fromValues(50000, 50000, 50000),
      blockSize: vec3.fromValues(64, 64, 64),
      numLevels: 1,
    } as VolumeInfo;
  }
}

function makeAnnotationGeometrySourceSpecifications(dataInfo: VolumeInfo) {
  const rank = 3;

  const makeSpec = (info: VolumeInfo) => {
    const chunkDataSize = info.upperVoxelBound;
    const spec = makeSliceViewChunkSpecification({
      rank,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      lowerVoxelBound: info.lowerVoxelBound,
      upperVoxelBound: info.upperVoxelBound,
    });

    return { spec, chunkToMultiscaleTransform: mat4.create() };
  };

  return [[makeSpec(dataInfo)]];
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<ClioToken>()(MultiscaleAnnotationSource),
  AnnotationSourceParameters,
);

export class ClioAnnotationSource extends MultiscaleAnnotationSourceBase {
  declare key: any;
  readonly = false;
  childRefreshed = new NullarySignal();
  private dataInfo: VolumeInfo;
  private chunkSources: SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][];

  constructor(
    chunkManager: ChunkManager,
    options: {
      credentialsProvider: CredentialsProvider<ClioToken>;
      parameters: AnnotationSourceParameters;
      dataInfo: VolumeInfo;
    },
  ) {
    super(chunkManager, {
      rank: 3,
      relationships: ["segments"],
      properties: options.parameters.properties,
      ...options,
    });

    this.parameters = options.parameters;
    this.dataInfo = options.dataInfo;

    this.childAdded =
      this.childAdded ||
      new Signal<(annotation: Annotation) => void>();
    this.childUpdated =
      this.childUpdated ||
      new Signal<(annotation: Annotation) => void>();
    this.childDeleted =
      this.childDeleted ||
      new Signal<(annotationId: string) => void>();
  }

  getSources(
    _options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    const sourceSpecifications =
      makeAnnotationGeometrySourceSpecifications(this.dataInfo);

    let limit = 0;
    if (sourceSpecifications[0].length > 1) {
      limit = 10;
    }

    this.chunkSources = sourceSpecifications.map((alternatives) =>
      alternatives.map(({ spec, chunkToMultiscaleTransform }) => ({
        chunkSource: this.chunkManager.getChunkSource(
          ClioAnnotationChunkSource,
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

  *[Symbol.iterator](): Iterator<Annotation> {
    for (const reference of this.references) {
      if (reference[1].value) {
        yield reference[1].value;
      }
    }
  }

  add(annotation: Annotation, commit: boolean = true) {
    if (this.readonly) {
      const errorMessage = "Permission denied for changing annotations.";
      StatusMessage.showTemporaryMessage(errorMessage);
      throw Error(errorMessage);
    }

    const clioAnnotation = new ClioAnnotationFacade(annotation as FlyEMAnnotation);
    clioAnnotation.addTimeStamp();
    if (this.parameters.user) {
      clioAnnotation.user = this.parameters.user;
    }

    if (annotation.type === AnnotationType.POINT) {
      clioAnnotation.kind = this.parameters.kind || "Note";
      if (annotation.description) {
        const defaultProp = parseDescription(annotation.description);
        if (defaultProp) {
          clioAnnotation.setProp(defaultProp);
        }
      }
    }

    clioAnnotation.roundPos();
    clioAnnotation.update();

    return super.add(annotation, commit);
  }

  invalidateCache() {
    this.references.forEach((ref) => {
      ref.dispose();
    });
    this.references.clear();
    this.childRefreshed.dispatch();
    this.metadataChunkSource.invalidateCache();
    if (this.chunkSources) {
      for (const sources1 of this.chunkSources) {
        for (const source of sources1) {
          source.chunkSource.invalidateCache();
        }
      }
    }
    for (const source of this.segmentFilteredSources) {
      source.invalidateCache();
    }
  }
}

async function getAnnotationChunkSource(
  options: GetDataSourceOptions,
  sourceParameters: AnnotationSourceParameters,
  dataInfo: VolumeInfo,
  credentialsProvider: CredentialsProvider<ClioToken>,
) {
  return options.registry.chunkManager.getChunkSource(
    ClioAnnotationSource,
    {
      parameters: sourceParameters,
      credentialsProvider,
      dataInfo,
    } as any,
  );
}

async function getAnnotationSource(
  options: GetDataSourceOptions,
  sourceParameters: AnnotationSourceParameters,
  credentialsProvider: CredentialsProvider<ClioToken>,
) {
  const dataInfo = await getAnnotationDataInfo(sourceParameters);

  const box: BoundingBox = {
    lowerBounds: new Float64Array(dataInfo.lowerVoxelBound),
    upperBounds: Float64Array.from(dataInfo.upperVoxelBound),
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.from(dataInfo.voxelSize, (x) => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const annotation = await getAnnotationChunkSource(
    options,
    sourceParameters,
    dataInfo,
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

const clioUrlPattern =
  /^([^/]+:\/\/[^/]+)\/(?:([^/?#]+)\/)?([^/?#]+)(?:(?:\?|#)(.*))?$/;

function parseSourceUrl(url: string): ClioSourceParameters {
  const match = url.match(clioUrlPattern);
  if (match === null) {
    throw new Error(`Invalid Clio URL: ${JSON.stringify(url)}.`);
  }

  const sourceParameters: ClioSourceParameters = {
    ...new ClioSourceParameters(),
    baseUrl: match[1],
    api: match[2],
    dataset: match[3],
  };

  const queryString = match[4];
  if (queryString) {
    const parameters = parseQueryStringParameters(queryString);
    if (parameters.token) {
      sourceParameters.authToken = parameters.token;
      sourceParameters.authServer = "token:" + parameters.token;
    } else if (parameters.auth) {
      sourceParameters.authServer = parameters.auth;
    }

    if (parameters.user) {
      sourceParameters.user = parameters.user;
    } else if (sourceParameters.authToken) {
      sourceParameters.user = getUserFromToken(sourceParameters.authToken);
    }

    if (parameters.kind) {
      if (parameters.kind === "atlas") {
        sourceParameters.kind = "Atlas";
      } else {
        sourceParameters.kind = parameters.kind;
      }
    } else {
      sourceParameters.kind = "Normal";
    }

    if (parameters.groups) {
      sourceParameters.groups = parameters.groups;
    }
  }

  return sourceParameters;
}

async function completeSourceParameters(
  sourceParameters: ClioSourceParameters,
  credentialsProvider: CredentialsProvider<ClioToken>,
): Promise<ClioSourceParameters> {
  const clioInstance = new ClioInstance(sourceParameters);
  const response = await fetchWithClioCredentials(
    credentialsProvider,
    clioInstance.getDatasetsUrl(),
    { method: "GET" },
  );
  const responseJson = await response.json();
  const grayscaleInfo = verifyObjectProperty(
    responseJson,
    sourceParameters.dataset,
    verifyObject,
  );

  if ("location" in grayscaleInfo) {
    sourceParameters.grayscale = verifyObjectProperty(
      grayscaleInfo,
      "location",
      verifyString,
    );
  } else if ("mainLayer" in grayscaleInfo) {
    const mainLayer = verifyObjectProperty(
      grayscaleInfo,
      "mainLayer",
      verifyString,
    );
    const neuroglancer = verifyObjectProperty(
      grayscaleInfo,
      "neuroglancer",
      verifyObject,
    );
    const layers = neuroglancer.layers;
    const layer = layers.find(
      (layer: { name: string }) => layer.name === mainLayer,
    );
    if (layer.source && layer.source.url) {
      sourceParameters.grayscale = verifyObjectProperty(
        layer.source,
        "url",
        verifyString,
      );
    } else {
      sourceParameters.grayscale = verifyObjectProperty(
        layer,
        "source",
        verifyString,
      );
    }
  }

  return sourceParameters;
}

async function getDataSource(
  options: GetDataSourceOptions,
): Promise<DataSource> {
  let sourceParameters = parseSourceUrl(options.providerUrl);

  const credentialsProvider =
    options.registry.credentialsManager.getCredentialsProvider<ClioToken>(
      credentialsKey,
      sourceParameters.authServer,
    );

  if (!sourceParameters.user && sourceParameters.authServer) {
    if (isAuthRefreshable(sourceParameters)) {
      const credentialsWithGen = await credentialsProvider.get();
      const token = credentialsWithGen.credentials.token;
      if (token) {
        sourceParameters.authToken = token;
        sourceParameters.user = getUserFromToken(token);
      }
    }
  }

  return options.registry.chunkManager.memoize.getAsync(
    {
      type: "clio:MultiscaleVolumeChunkSource",
      ...sourceParameters,
    },
    options,
    async () => {
      sourceParameters = await completeSourceParameters(
        sourceParameters,
        credentialsProvider,
      );

      const annotationSourceParameters: AnnotationSourceParameters = {
        ...new AnnotationSourceParameters(),
        ...sourceParameters,
      };

      if (sourceParameters.kind === "Atlas") {
        annotationSourceParameters.schema = defaultAtlasSchema;
      } else {
        annotationSourceParameters.schema = defaultAnnotationSchema;
      }

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
      ];

      return getAnnotationSource(
        options,
        annotationSourceParameters,
        credentialsProvider,
      );
    },
  );
}

export class ClioDataSource implements DataSourceProvider {
  get scheme() {
    return "clio";
  }
  get description() {
    return "Clio";
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options);
  }

  completeUrl(_options: CompleteUrlOptions): Promise<CompletionResult> {
    return Promise.resolve({
      offset: 0,
      completions: [{ value: "" }],
    });
  }
}
