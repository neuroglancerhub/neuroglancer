
import {MultiscaleAnnotationSource, AnnotationGeometryChunkSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {ClioToken, credentialsKey, makeRequestWithCredentials} from 'neuroglancer/datasource/clio/api';
import {AnnotationSourceParameters, AnnotationChunkSourceParameters, ClioSourceParameters} from 'neuroglancer/datasource/clio/base';
import { AnnotationType, Annotation, AnnotationReference } from 'neuroglancer/annotation';
import {Signal, NullarySignal} from 'neuroglancer/util/signal';
import {CredentialsManager, CredentialsProvider} from 'neuroglancer/credentials_provider';
import {DataType, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import { makeSliceViewChunkSpecification } from 'neuroglancer/sliceview/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {BoundingBox, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, verifyEnumString, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {getUserFromToken, parseDescription} from 'neuroglancer/datasource/dvid/utils';
import {makeRequest} from 'neuroglancer/datasource/dvid/api';
import {parseSpecialUrl} from 'neuroglancer/util/http_request';
import {StatusMessage} from 'neuroglancer/status';
import {createBasicElement} from 'neuroglancer/datasource/dvid/widgets';
import {makeAnnotationEditWidget} from 'neuroglancer/datasource/dvid/widgets';
import {ClioPointAnnotation, ClioPointAnnotationFacade, defaultAnnotationSchema, defaultAtlasSchema as defaultAtlasSchema, getAnnotationDescription} from 'neuroglancer/datasource/clio/utils';

class ClioAnnotationChunkSource extends
(WithParameters(WithCredentialsProvider<ClioToken>()(AnnotationGeometryChunkSource), AnnotationChunkSourceParameters)) {}

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
  mesh: string|undefined;
  skeletons: string|undefined;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
}

function parseMultiscaleVolumeInfo(obj: unknown): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  const volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
  const skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
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
  return {dataType, volumeType, mesh, skeletons, scales: scaleInfos, modelSpace};
}

class AnnotationDataInfo {
  voxelSize: vec3;
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;

  constructor(obj: any) {
    const info = parseMultiscaleVolumeInfo(obj);
    const scale = info.scales[0];
    this.voxelSize = vec3.fromValues(scale.resolution[0], scale.resolution[1], scale.resolution[2]);
    this.lowerVoxelBound = vec3.fromValues(scale.voxelOffset[0], scale.voxelOffset[1], scale.voxelOffset[2]);
    this.upperVoxelBound = vec3.add(vec3.create(), this.lowerVoxelBound, vec3.fromValues(scale.size[0], scale.size[1], scale.size[2]));
  }
}

async function getAnnotationDataInfo(parameters: AnnotationSourceParameters): Promise<AnnotationDataInfo> {
  if (parameters.grayscale) {
    let {grayscale} = parameters;
    return makeRequest({
      'method': 'GET',
      'url': parseSpecialUrl(grayscale) + '/info',
      responseType: 'json'
    }).then(response => {
      return new AnnotationDataInfo(response);
    });
  } else {
    throw Error('No volume information provided.');
  }
}

function makeAnnotationGeometrySourceSpecifications(dataInfo: AnnotationDataInfo) {
  const rank = 3;

  let makeSpec = (info: AnnotationDataInfo) => {
    const chunkDataSize = info.upperVoxelBound;
    let spec = makeSliceViewChunkSpecification({
      rank,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      upperVoxelBound: info.upperVoxelBound,
      lowerVoxelBound: info.lowerVoxelBound
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
  private dataInfo: AnnotationDataInfo;

  constructor(chunkManager: ChunkManager, options: {
    credentialsProvider: CredentialsProvider<ClioToken>,
    parameters: AnnotationSourceParameters,
    dataInfo: AnnotationDataInfo
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
    this.childRefreshed = this.childRefreshed || new NullarySignal();

    this.makeEditWidget = (reference: AnnotationReference) => {
      return makeAnnotationEditWidget(reference, this.parameters.schema, this);
    };

    this.makeFilterWidget = () => {
      let element = createBasicElement(
        {title: 'Filter', type: 'string'}, 'annotationFilter', '');
      element.addEventListener('change', (e: Event) => {
        console.log(e);
      });
      
      return element;
    };

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

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    if (this.readonly) {
      let errorMessage = 'Permission denied for changing annotations.';
      StatusMessage.showTemporaryMessage(errorMessage);
      throw Error(errorMessage);
    }

    if (annotation.type === AnnotationType.POINT) {
      let annotationRef = new ClioPointAnnotationFacade(<ClioPointAnnotation>annotation);
      annotationRef.kind = this.parameters.kind || 'Note';
      
      // (<DVIDPointAnnotation>annotation).kind = 'Note';
      annotation.point = annotation.point.map(x => Math.round(x));

      annotationRef.addTimeStamp();
      if (this.parameters.user) {
        annotationRef.user = this.parameters.user;
      }

      if (annotation.description) {
        let defaultProp = parseDescription(annotation.description);
        if (defaultProp) {
          annotationRef.addProp(defaultProp);
          annotation.description = getAnnotationDescription(<ClioPointAnnotation>annotation);
        }
      }
    }

    return super.add(annotation, commit);
  }

  update(reference: AnnotationReference, newAnnotation: Annotation) {
    if (newAnnotation.type === AnnotationType.POINT) {
      newAnnotation.point = newAnnotation.point.map(x => Math.round(x));
    }
    let description = getAnnotationDescription(<ClioPointAnnotation>newAnnotation);
    if (description) {
      newAnnotation.description = description;
    }
    super.update(reference, newAnnotation);
  }
}

async function getAnnotationChunkSource(options: GetDataSourceOptions, sourceParameters: AnnotationSourceParameters, dataInfo: AnnotationDataInfo, credentialsProvider: CredentialsProvider<ClioToken>) {
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
const urlPattern = /^([^\/]+:\/\/[^\/]+)\/([^\/\?]+)(\?.*)?$/;



function parseSourceUrl(url: string): ClioSourceParameters {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid Clio URL: ${JSON.stringify(url)}.`);
  }

  let sourceParameters: ClioSourceParameters = {
    baseUrl: match[1],
    dataset: match[2],

  };

  let queryString = match[3];
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
  }

  return sourceParameters;
}

async function completeSourceParameters(sourceParameters: ClioSourceParameters, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<ClioToken>): Promise<ClioSourceParameters> {
  // let credentials = await getCredentialsProvider(sourceParameters.authToken).get();
  return makeRequestWithCredentials(getCredentialsProvider(sourceParameters.authServer), {url: `${sourceParameters.baseUrl}/clio_toplevel/datasets`, method: 'GET', responseType: 'json'}).then(response => {
    const grayscaleInfo = verifyObjectProperty(response, sourceParameters.dataset, verifyObject);
    sourceParameters.grayscale = verifyObjectProperty(grayscaleInfo, "location", verifyString);
    return sourceParameters;
  });
}

type AuthType = string|undefined|null;

async function getDataSource(options: GetDataSourceOptions, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<ClioToken>): Promise<DataSource> {
  // let match = options.providerUrl.match(urlPattern);
  // if (match === null) {
  //   throw new Error(`Invalid DVID URL: ${JSON.stringify(options.providerUrl)}.`);
  // }

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
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  get description() {
    return 'Clio';
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