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

import {MultiscaleAnnotationSource, AnnotationGeometryChunkSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import { AnnotationType, Annotation, AnnotationReference } from 'neuroglancer/annotation';
import {Signal} from 'neuroglancer/util/signal';
import {CredentialsManager, CredentialsProvider} from 'neuroglancer/credentials_provider';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import { makeSliceViewChunkSpecification } from 'neuroglancer/sliceview/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {mat4} from 'neuroglancer/util/geom';
import {BoundingBox, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
// import {parseArray, parseFixedLengthArray, parseQueryStringParameters, verifyEnumString, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {parseQueryStringParameters, verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {getUserFromToken} from 'neuroglancer/datasource/flyem/annotation';
import {ClioAnnotationFacade, parseDescription} from 'neuroglancer/datasource/clio/utils';
import {Borrowed} from 'neuroglancer/util/disposable';
import {makeRequest} from 'neuroglancer/datasource/dvid/api';
import {parseUrl} from 'neuroglancer/util/http_request';
import {StatusMessage} from 'neuroglancer/status';
import {FlyEMAnnotation} from 'neuroglancer/datasource/flyem/annotation';
import {VolumeInfo} from 'neuroglancer/datasource/flyem/datainfo';
import {makeAnnotationEditWidget} from 'neuroglancer/datasource/flyem/widgets';
import {defaultAnnotationSchema, defaultAtlasSchema} from 'neuroglancer/datasource/clio/utils';
import {ClioToken, credentialsKey, makeRequestWithCredentials, getGrayscaleInfoUrl, ClioInstance} from 'neuroglancer/datasource/clio/api';
import {AnnotationSourceParameters, AnnotationChunkSourceParameters, ClioSourceParameters} from 'neuroglancer/datasource/clio/base';

class ClioAnnotationChunkSource extends
(WithParameters(WithCredentialsProvider<ClioToken>()(AnnotationGeometryChunkSource), AnnotationChunkSourceParameters)) {}
/*
class ScaleInfo {
  key: string;
  resolution: Float64Array;
  voxelOffset: Float32Array;
  size: Float32Array;
  chunkSizes: Uint32Array[];
  compressedSegmentationBlockSize: vec3|undefined;
  constructor(obj: any, numChannels: number) {
    verifyObject(obj);
    const rank = (numChannels === 1) ? 3 : 4;
    const resolution = this.resolution = new Float64Array(rank);
    const voxelOffset = this.voxelOffset = new Float32Array(rank);
    const size = this.size = new Float32Array(rank);
    if (rank === 4) {
      resolution[3] = 1;
      size[3] = numChannels;
    }
    verifyObjectProperty(
        obj, 'resolution',
        x => parseFixedLengthArray(resolution.subarray(0, 3), x, verifyFinitePositiveFloat));
    verifyOptionalObjectProperty(
        obj, 'voxel_offset', x => parseFixedLengthArray(voxelOffset.subarray(0, 3), x, verifyInt));
    verifyObjectProperty(
        obj, 'size', x => parseFixedLengthArray(size.subarray(0, 3), x, verifyPositiveInt));
    this.chunkSizes = verifyObjectProperty(
        obj, 'chunk_sizes', x => parseArray(x, y => {
                              const chunkSize = new Uint32Array(rank);
                              if (rank === 4) chunkSize[3] = numChannels;
                              parseFixedLengthArray(chunkSize.subarray(0, 3), y, verifyPositiveInt);
                              return chunkSize;
                            }));
    if (this.chunkSizes.length === 0) {
      throw new Error('No chunk sizes specified.');
    }

    this.key = verifyObjectProperty(obj, 'key', verifyString);
  }
}

interface MultiscaleVolumeInfo {
  dataType: DataType;
  volumeType: VolumeType;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
}

function parseMultiscaleVolumeInfo(obj: unknown): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  const volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const scaleInfos =
      verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y, numChannels)));
  if (scaleInfos.length === 0) throw new Error('Expected at least one scale');
  const baseScale = scaleInfos[0];
  const rank = (numChannels === 1) ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ['x', 'y', 'z'];
  const units = ['m', 'm', 'm'];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = 'c^';
    units[3] = '';
  }
  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {dataType, volumeType, scales: scaleInfos, modelSpace};
}

class AnnotationDataInfo {
  voxelSize: vec3;
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;

  constructor(obj: any, protocol: string) {
    if (protocol === 'gs') {
      const info = parseMultiscaleVolumeInfo(obj);
      const scale = info.scales[0];
      this.voxelSize = vec3.fromValues(scale.resolution[0], scale.resolution[1], scale.resolution[2]);
      this.lowerVoxelBound = vec3.fromValues(scale.voxelOffset[0], scale.voxelOffset[1], scale.voxelOffset[2]);
      this.upperVoxelBound = vec3.add(vec3.create(), this.lowerVoxelBound, vec3.fromValues(scale.size[0], scale.size[1], scale.size[2]));
    } else { //DVID info
      const info = new DVIDVolumeInfo(obj);
      this.voxelSize = info.voxelSize;
      this.lowerVoxelBound = info.boundingBoxes[0].corner;
      this.upperVoxelBound = info.upperVoxelBound;
    }
  }
}
*/

async function getAnnotationDataInfo(parameters: AnnotationSourceParameters): Promise<VolumeInfo> {
  const { grayscale } = parameters;
  if (grayscale) {
    const u = parseUrl(grayscale);
    return makeRequest({
      'method': 'GET',
      'url': getGrayscaleInfoUrl(u),
      responseType: 'json'
    }).then(response => {
      return new VolumeInfo(response, u.protocol);
    });
  } else {
    throw Error('No volume information provided.');
  }
}

function makeAnnotationGeometrySourceSpecifications(dataInfo: VolumeInfo) {
  const rank = 3;

  let makeSpec = (info: VolumeInfo) => {
    const chunkDataSize = info.upperVoxelBound;
    let spec = makeSliceViewChunkSpecification({
      rank,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      lowerVoxelBound: info.lowerVoxelBound,
      upperVoxelBound: info.upperVoxelBound
    });

    return { spec, chunkToMultiscaleTransform: mat4.create()};
  };

  return [[makeSpec(dataInfo)]];
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<ClioToken>()(MultiscaleAnnotationSource), AnnotationSourceParameters);

export class ClioAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  readonly = false;
  private dataInfo: VolumeInfo;

  constructor(chunkManager: ChunkManager, options: {
    credentialsProvider: CredentialsProvider<ClioToken>,
    parameters: AnnotationSourceParameters,
    dataInfo: VolumeInfo
  }) {
    super(chunkManager, {
      rank: 3,
      relationships: [],
      properties: options.parameters.properties,
      ...options
    });

    this.parameters = options.parameters;
    this.dataInfo = options.dataInfo;

    this.childAdded = this.childAdded || new Signal<(annotation: Annotation) => void>();
    this.childUpdated = this.childUpdated || new Signal<(annotation: Annotation) => void>();
    this.childDeleted = this.childDeleted || new Signal<(annotationId: string) => void>();

    this.makeEditWidget = (reference: AnnotationReference) => {
      const getFacade = (annotation: FlyEMAnnotation) => {
        return new ClioAnnotationFacade(annotation);
      }

      const getProp = (annotation: FlyEMAnnotation) => {
        return {...annotation.prop, ...annotation.ext};
      };
      const setProp = (annotation: FlyEMAnnotation, prop: {[key:string]: any}) => {
        const annotationRef = new ClioAnnotationFacade(annotation);
        if (prop.title) {
          annotationRef.title = prop.title;
        }
        if (prop.description) {
          annotationRef.description = prop.description;
        }
      };

      return makeAnnotationEditWidget(reference, this.parameters.schema, this, getFacade, getProp, setProp);
    };

    /*
    this.childRefreshed = this.childRefreshed || new NullarySignal();

    this.makeFilterWidget = () => {
      let element = createBasicElement(
        {title: 'Filter', type: 'string'}, 'annotationFilter', '');
      element.addEventListener('change', (e: Event) => {
        console.log(e);
      });

      return element;
    };
    */

    this.getUser = () => this.parameters.user;
  }

  getSources(_options: VolumeSourceOptions):
    SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {

    let sourceSpecifications = makeAnnotationGeometrySourceSpecifications(this.dataInfo);

    let limit = 0;
    if (sourceSpecifications[0].length > 1) {
      limit = 10;
    }

    return sourceSpecifications.map(
      alternatives =>
        alternatives.map(({ spec, chunkToMultiscaleTransform }) => ({
          chunkSource: this.chunkManager.getChunkSource(ClioAnnotationChunkSource, {
            spec: { limit, chunkToMultiscaleTransform, ...spec },
            parent: this,
            credentialsProvider: this.credentialsProvider,
            parameters: this.parameters
          }),
          chunkToMultiscaleTransform
        })));
  }

  * [Symbol.iterator](): Iterator<Annotation> {
    for (let reference of this.references) {
      if (reference[1].value) {
        yield reference[1].value;
      }
    }
  }

  commit(reference: Borrowed<AnnotationReference>) {
    if (reference.value && reference.value.type === AnnotationType.LINE) {
      reference.value.pointA = reference.value.pointA.map(x => Math.round(x));
      reference.value.pointB = reference.value.pointB.map(x => Math.round(x));
    }
    super.commit(reference);
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    if (this.readonly) {
      let errorMessage = 'Permission denied for changing annotations.';
      StatusMessage.showTemporaryMessage(errorMessage);
      throw Error(errorMessage);
    }

    const clioAnnotation = new ClioAnnotationFacade(annotation);
    clioAnnotation.addTimeStamp();
    if (this.parameters.user) {
      clioAnnotation.user = this.parameters.user;
    }

    if (annotation.type === AnnotationType.POINT) {
      clioAnnotation.kind = this.parameters.kind || 'Note';
      if (annotation.description) {
        let defaultProp = parseDescription(annotation.description);
        if (defaultProp) {
          clioAnnotation.setProp(defaultProp);
        }
      }
    }

    clioAnnotation.roundPos();
    clioAnnotation.update();

    return super.add(annotation, commit);
  }

  update(reference: AnnotationReference, newAnnotation: Annotation) {
    const annotationRef = new ClioAnnotationFacade(newAnnotation);
    annotationRef.roundPos();
    annotationRef.update();

    super.update(reference, newAnnotation);
  }

  invalidateCache() {
    this.references.clear();
    this.childRefreshed.dispatch();
    this.metadataChunkSource.invalidateCache();
    for (let sources1 of this.getSources({
      multiscaleToViewTransform: new Float32Array(),
      displayRank: 1,
      modelChannelDimensionIndices: [],
    })) {
      for (let source of sources1) {
        source.chunkSource.invalidateCache();
      }
    }
    for (let source of this.segmentFilteredSources) {
      source.invalidateCache();
    }
    // this.childRefreshed.dispatch();
  }
}

async function getAnnotationChunkSource(options: GetDataSourceOptions, sourceParameters: AnnotationSourceParameters, dataInfo: VolumeInfo, credentialsProvider: CredentialsProvider<ClioToken>) {
  let getChunkSource = (dataInfo: any, parameters: any) => options.chunkManager.getChunkSource(
    ClioAnnotationSource, <any>{
    parameters,
    credentialsProvider,
    dataInfo
  });

  return getChunkSource(dataInfo, sourceParameters);
}

async function getAnnotationSource(options: GetDataSourceOptions, sourceParameters: AnnotationSourceParameters, credentialsProvider: CredentialsProvider<ClioToken>) {

  const dataInfo = await getAnnotationDataInfo(sourceParameters);

  const box: BoundingBox = {
    lowerBounds: new Float64Array(dataInfo.lowerVoxelBound),
    upperBounds: Float64Array.from(dataInfo.upperVoxelBound)
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ['x', 'y', 'z'],
    units: ['m', 'm', 'm'],
    scales: Float64Array.from(dataInfo.voxelSize, x => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const annotation = await getAnnotationChunkSource(options, sourceParameters, dataInfo, credentialsProvider);

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [{
      id: 'default',
      subsource: { annotation },
      default: true,
    }],
  };

  return dataSource;
}

//https://us-east4-flyem-private.cloudfunctions.net/mb20?query=value
const urlPattern = /^([^\/]+:\/\/[^\/]+)\/([^\/\?]+\/)?([^\/\?]+)(\?.*)?$/;

function parseSourceUrl(url: string): ClioSourceParameters {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid Clio URL: ${JSON.stringify(url)}.`);
  }

  let sourceParameters: ClioSourceParameters = {
    baseUrl: match[1],
    api: match[2] ? match[2].slice(0, -1) : undefined,
    dataset: match[3]
  };

  let queryString = match[4];
  if (queryString && queryString.length > 1) {
    let parameters = parseQueryStringParameters(queryString.substring(1));
    if (parameters.token) {
      sourceParameters.authToken = parameters.token;
      sourceParameters.authServer = 'token:' + parameters.token;
    } else if (parameters.auth) {
      sourceParameters.authServer = parameters.auth;
    }

    if (parameters.user) {
      sourceParameters.user = parameters.user;
    } else if (sourceParameters.authToken) {
      sourceParameters.user = getUserFromToken(sourceParameters.authToken);
    }

    if (parameters.kind) {
      if (parameters.kind === 'atlas') {
        sourceParameters.kind = 'Atlas';
      } else {
        sourceParameters.kind = parameters.kind;
      }
    } else {
      sourceParameters.kind = 'Normal';
    }

    if (parameters.groups) {
      sourceParameters.groups = parameters.groups;
    }
  }

  return sourceParameters;
}

async function completeSourceParameters(sourceParameters: ClioSourceParameters, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<ClioToken>): Promise<ClioSourceParameters> {
  const clioInstance = new ClioInstance(sourceParameters);
  return makeRequestWithCredentials(
    getCredentialsProvider(sourceParameters.authServer),
    {
      url: clioInstance.getDatasetsUrl(),
      method: 'GET',
      responseType: 'json'
    }).then(response => {
    const grayscaleInfo = verifyObjectProperty(response, sourceParameters.dataset, verifyObject);
    sourceParameters.grayscale = verifyObjectProperty(grayscaleInfo, "location", verifyString);
    return sourceParameters;
  });
}

type AuthType = string|undefined|null;

async function getDataSource(options: GetDataSourceOptions, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<ClioToken>): Promise<DataSource> {
  let sourceParameters = parseSourceUrl(options.providerUrl);

  if (!sourceParameters.user && sourceParameters.authServer) {
    let credentials = getCredentialsProvider(sourceParameters.authServer).get();
    sourceParameters.authToken = (await credentials).credentials;
    sourceParameters.user = getUserFromToken(sourceParameters.authToken);
  }

  return options.chunkManager.memoize.getUncounted(
      {
        type: 'clio:MultiscaleVolumeChunkSource',
        ...sourceParameters
      },
      async () => {
        sourceParameters = await completeSourceParameters(sourceParameters, getCredentialsProvider);

        let annotationSourceParameters: AnnotationSourceParameters = {
          ...new AnnotationSourceParameters(),
          ...sourceParameters
        };

        // annotationSourceParameters.schema = getSchema(annotationSourceParameters);

        if (sourceParameters.kind === 'Atlas') {
          annotationSourceParameters.schema = defaultAtlasSchema;
        } else {
          annotationSourceParameters.schema = defaultAnnotationSchema;
        }

        annotationSourceParameters.properties = [{
          identifier: 'rendering_attribute',
          description: 'rendering attribute',
          type: 'int32',
          default: 0,
          min: 0,
          max: 5,
          step: 1
        }];

        // let credentials = sourceParameters.authToken;
        const credentialsProvider = getCredentialsProvider(sourceParameters.authServer);
        return getAnnotationSource(options, annotationSourceParameters, credentialsProvider);
      });
}

async function completeHttpPath(_1: string) {
  return Promise.resolve({
    offset: 0,
    completions: [{value: ''}]
  });
}

//Clio data source provider
export class ClioDataSource extends DataSourceProvider {
  description = 'Clio';
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  getCredentialsProvider(authServer: AuthType) {
    let parameters = '';
    if (authServer) {
      parameters = authServer;
    }

    return this.credentialsManager.getCredentialsProvider<ClioToken>(credentialsKey, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options, this.getCredentialsProvider.bind(this));
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(options.providerUrl);
  }
}