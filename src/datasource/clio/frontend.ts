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
  CompleteUrlOptions,
  DataSource,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import {
  parseQueryStringParameters,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { getUserFromToken } from "#src/datasource/flyem/annotation.js";
import type { ClioSourceParameters } from "#src/datasource/clio/base.js";
import {
  AnnotationSourceParameters,
  isAuthRefreshable,
} from "#src/datasource/clio/base.js";
import type { ClioToken } from "#src/datasource/clio/api.js";
import {
  credentialsKey,
  makeRequestWithCredentials,
  ClioInstance,
} from "#src/datasource/clio/api.js";
import {
  defaultAnnotationSchema,
  defaultAtlasSchema,
} from "#src/datasource/clio/utils.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
  type BoundingBox,
} from "#src/coordinate_transform.js";
import { makeRequest } from "#src/datasource/flyem/api.js";
import { VolumeInfo } from "#src/datasource/flyem/datainfo.js";
import { parseGrayscaleUrl, getGrayscaleInfoUrl } from "#src/datasource/clio/api.js";
import { vec3 } from "#src/util/geom.js";

type AuthType = string | undefined | null;

// Parse source URL for clio datasource
// Format: clio://host/api/dataset?params
const urlPattern =
  /^([^\/]+:\/\/[^\/]+)\/(?:([^\/\?#]+)\/)?([^\/\?#]+)(?:(?:\?|#)(.*))?$/;

function parseSourceUrl(url: string): ClioSourceParameters {
  const match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid Clio URL: ${JSON.stringify(url)}.`);
  }

  const sourceParameters: ClioSourceParameters = {
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

async function getAnnotationDataInfo(
  parameters: AnnotationSourceParameters,
): Promise<VolumeInfo> {
  const { grayscale } = parameters;
  if (grayscale) {
    const u = parseGrayscaleUrl(grayscale);
    return makeRequest({
      method: "GET",
      url: getGrayscaleInfoUrl(u),
      responseType: "json",
    }).then((response) => {
      return new VolumeInfo(
        response,
        u.protocol === "https" ? "gs" : u.protocol,
      );
    });
  } else {
    return Promise.resolve({
      numChannels: 1,
      voxelSize: vec3.fromValues(8, 8, 8),
      lowerVoxelBound: vec3.fromValues(0, 0, 0),
      upperVoxelBound: vec3.fromValues(50000, 50000, 50000),
      blockSize: vec3.fromValues(64, 64, 64),
      numLevels: 1,
    });
  }
}

async function completeSourceParameters(
  sourceParameters: ClioSourceParameters,
  getCredentialsProvider: (auth: AuthType) => CredentialsProvider<ClioToken>,
): Promise<ClioSourceParameters> {
  const clioInstance = new ClioInstance(sourceParameters);
  return makeRequestWithCredentials(
    getCredentialsProvider(sourceParameters.authServer),
    isAuthRefreshable(sourceParameters),
    {
      url: clioInstance.getDatasetsUrl(),
      method: "GET",
      responseType: "json",
    },
  ).then((response) => {
    const grayscaleInfo = verifyObjectProperty(
      response,
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
  });
}

async function getAnnotationSource(
  options: GetDataSourceOptions,
  sourceParameters: AnnotationSourceParameters,
  _credentialsProvider: CredentialsProvider<ClioToken>,
): Promise<DataSource> {
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

  // Note: Full annotation source implementation would require porting the
  // ClioAnnotationSource class which depends on MultiscaleAnnotationSource.
  // For now, we return a basic data source structure.

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [
      {
        id: "default",
        subsource: {},
        default: true,
      },
    ],
  };

  return dataSource;
}

async function getDataSource(
  options: GetDataSourceOptions,
  getCredentialsProvider: (auth: AuthType) => CredentialsProvider<ClioToken>,
): Promise<DataSource> {
  let sourceParameters = parseSourceUrl(options.providerUrl);

  if (!sourceParameters.user && sourceParameters.authServer) {
    const credentials = getCredentialsProvider(sourceParameters.authServer).get();
    sourceParameters.authToken = (await credentials).credentials;
    sourceParameters.user = getUserFromToken(sourceParameters.authToken);
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
        getCredentialsProvider,
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

      const credentialsProvider = getCredentialsProvider(
        sourceParameters.authServer,
      );
      return getAnnotationSource(
        options,
        annotationSourceParameters,
        credentialsProvider,
      );
    },
  );
}

async function completeHttpPath(_1: string) {
  return Promise.resolve({
    offset: 0,
    completions: [{ value: "" }],
  });
}

// Clio data source provider
export class ClioDataSource implements DataSourceProvider {
  get scheme() {
    return "clio";
  }
  get description() {
    return "Clio";
  }

  constructor(public credentialsManager: CredentialsManager) {}

  getCredentialsProvider(authServer: AuthType) {
    let parameters = "";
    if (authServer) {
      parameters = authServer;
    }

    return this.credentialsManager.getCredentialsProvider<ClioToken>(
      credentialsKey,
      parameters,
    );
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options, this.getCredentialsProvider.bind(this));
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(options.providerUrl);
  }
}
