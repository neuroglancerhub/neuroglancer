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

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, CompletionResult, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {AnnotationSourceParameters, DVIDSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, AnnotationChunkSourceParameters, AnnotationSourceParametersBase} from 'neuroglancer/datasource/dvid/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
// import {fetchOk} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString, verifyStringArray, verifyFiniteNonNegativeFloat, parseQueryStringParameters} from 'neuroglancer/util/json';
import {MultiscaleAnnotationSource, AnnotationGeometryChunkSource} from 'neuroglancer/annotation/frontend_source';
import { AnnotationType, Annotation, AnnotationReference } from 'neuroglancer/annotation';
import {Signal, NullarySignal} from 'neuroglancer/util/signal';
import {CredentialsManager, CredentialsProvider} from 'neuroglancer/credentials_provider'
import { makeSliceViewChunkSpecification } from 'neuroglancer/sliceview/base';
import {createProofreadWidget, createBasicElement} from 'neuroglancer/datasource/dvid/widgets';
// import {Uint64} from 'neuroglancer/util/uint64';
// import { DVIDAnnotationGeometryChunkSource } from './backend';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyInt} from 'neuroglancer/util/json';
import {Borrowed} from 'neuroglancer/util/disposable';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend'
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {Env, getUserFromToken, DVIDPointAnnotation, DVIDLineAnnotation, DVIDSphereAnnotation, getAnnotationDescription, DVIDPointAnnotationFacade, DVIDSphereAnnotationFacade, DVIDLineAnnotationFacade, parseDescription} from 'neuroglancer/datasource/dvid/utils';
import { dvidCredentailsKey, registerDVIDCredentialsProvider, isDVIDCredentialsProviderRegistered } from 'neuroglancer/datasource/dvid/register_credentials_provider';
import {DVIDInstance, DVIDToken, appendQueryStringForDvid, credentialsKey, makeRequestWithCredentials, defaultLocateService, defaultMeshService} from 'neuroglancer/datasource/dvid/api';
import {makeAnnotationEditWidget} from 'neuroglancer/datasource/dvid/widgets';
// import {getObjectFromWidget, createAnnotationWidget} from 'neuroglancer/datasource/dvid/widgets';
// import {defaultJsonSchema} from 'neuroglancer/datasource/dvid/utils';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string {
    return verifyObjectProperty(this.obj, 'TypeName', verifyString);
  }

  get compressionName(): string {
    return verifyObjectProperty(this.obj, 'Compression', verifyString);
  }

  constructor(public obj: any) {
    verifyObject(obj);
  }
}

export class DataInstanceInfo {
  lowerVoxelBound: vec3;
  upperVoxelBoundInclusive: vec3;
  voxelSize: vec3;
  blockSize: vec3;
  numLevels: number;
  defaultUser?: string;

  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
}

class DVIDVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

class DVIDSkeletonSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(SkeletonSource), SkeletonSourceParameters)) {}

class DVIDMeshSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(MeshSource), MeshSourceParameters)) {
  async updateMesh(id: string) {
    if (defaultMeshService) {
      let { parameters } = this;
      let dvidInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      
      try {
        try {
          let mergedUrl = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, id + '.merge');
          await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'HEAD',
              url: mergedUrl,
              responseType: ''
            });
  
          await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: mergedUrl,
              responseType: ''
            }
          );
        } finally {
          let meshUrl = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, id + '.ngmesh');
          await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'HEAD',
              url: meshUrl,
              responseType: ''
            });
  
          await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: meshUrl,
              responseType: ''
            }
          );
        }
      } finally {
        this.invalidateCache();
      }
    } else {
      throw new Error('No mesh generation service is available.');
    }
  }
}

class DVIDAnnotationChunkSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(AnnotationGeometryChunkSource), AnnotationChunkSourceParameters)) {}

export class AnnotationDataInstanceInfo extends DataInstanceInfo {
  

  get extended() {
    return verifyObjectProperty(this.obj, 'Extended', verifyObject);
  }

  get tags() {
    return verifyObjectProperty(this.base.obj, 'Tags', verifyObject);
  }

  constructor(
    obj: any, name: string, base: DataInstanceBaseInfo) {
    super(obj, name, base);

    this.numLevels = 1;

    let extended = this.extended;

    if ('MaxDownresLevel' in extended) {
      // retrieve maximum downres level
      let maxdownreslevel = verifyObjectProperty(extended, 'MaxDownresLevel', verifyPositiveInt);
      this.numLevels = maxdownreslevel + 1;
    }

    this.voxelSize = verifyObjectProperty(
      extended, 'VoxelSize',
      x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.lowerVoxelBound = verifyObjectProperty(
      extended, 'MinPoint',
      x => parseFixedLengthArray(vec3.create(), x, verifyFiniteNonNegativeFloat));
    this.upperVoxelBoundInclusive = verifyObjectProperty(
      extended, 'MaxPoint',
      x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    if ('BlockSize' in extended) {
      this.blockSize = verifyObjectProperty(
        extended, 'BlockSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    }
  }
}

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  meshSrc: string;
  skeletonSrc: string;
  mergeSrc: string;

  constructor(
      obj: any, name: string, base: DataInstanceBaseInfo, public encoding: VolumeChunkEncoding,
      instanceNames: Array<string>) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    let extendedValues = verifyObjectProperty(extended, 'Values', x => parseArray(x, verifyObject));
    if (extendedValues.length < 1) {
      throw new Error(
          'Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.');
    }
    this.numLevels = 1;

    let instSet = new Set<string>(instanceNames);
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      // retrieve maximum downres level
      let maxdownreslevel = verifyObjectProperty(extended, 'MaxDownresLevel', verifyPositiveInt);
      this.numLevels = maxdownreslevel + 1;
    } else {
      // labelblk does not have explicit datatype support for multiscale but
      // by convention different levels are specified with unique
      // instances where levels are distinguished by the suffix '_LEVELNUM'
      while (instSet.has(name + '_' + this.numLevels.toString())) {
        this.numLevels += 1;
      }
    }

    if (instSet.has(name + '_meshes')) {
      this.meshSrc = name + '_meshes';
      this.mergeSrc = 'neutu_merge_opr';
    } else {
      this.meshSrc = '';
    }

    if (instSet.has(name + '_skeletons')) {
      this.skeletonSrc = name + '_skeletons';
    } else {
      this.skeletonSrc = '';
    }

    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.blockSize = verifyObjectProperty(
      extended, 'BlockSize',
      x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));    
    this.lowerVoxelBound =
        verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
    this.upperVoxelBoundInclusive =
        verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
  }

  get volumeType() {
    return (
        (this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
         this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) ?
            VolumeType.SEGMENTATION :
            VolumeType.IMAGE);
  }

  getSources(
      chunkManager: ChunkManager, parameters: DVIDSourceParameters,
      volumeSourceOptions: VolumeSourceOptions, credentialsProvider: CredentialsProvider<DVIDToken>) {
    let {encoding} = this;
    let sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    // must be 64 block size to work with neuroglancer properly
    let blocksize = 64;
    for (let level = 0; level < this.numLevels; ++level) {
      const downsampleFactor = Math.pow(2, level);
      const invDownsampleFactor = Math.pow(2, -level);
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        let lowerVoxelNotAligned = Math.floor(this.lowerVoxelBound[i] * invDownsampleFactor);
        // adjust min to be a multiple of blocksize
        lowerVoxelBound[i] = lowerVoxelNotAligned - (lowerVoxelNotAligned % blocksize);
        let upperVoxelNotAligned = Math.ceil((this.upperVoxelBoundInclusive[i] + 1) * invDownsampleFactor);
        upperVoxelBound[i] = upperVoxelNotAligned;
        // adjust max to be a multiple of blocksize
        if ((upperVoxelNotAligned % blocksize) !== 0) {
          upperVoxelBound[i] += (blocksize - (upperVoxelNotAligned % blocksize));
        }
      }
      let dataInstanceKey = parameters.dataInstanceKey;

      if (encoding !== VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
        if (level > 0) {
          dataInstanceKey += '_' + level.toString();
        }
      }

      let volParameters: VolumeChunkSourceParameters = {
        'baseUrl': parameters.baseUrl,
        'nodeKey': parameters.nodeKey,
        'dataInstanceKey': dataInstanceKey,
        'authServer': parameters.authServer,
        'dataScale': level.toString(),
        'encoding': encoding,
      };
      const chunkToMultiscaleTransform = mat4.create();
      for (let i = 0; i < 3; ++i) {
        chunkToMultiscaleTransform[5 * i] = downsampleFactor;
        chunkToMultiscaleTransform[12 + i] = lowerVoxelBound[i] * downsampleFactor;
      }
      let alternatives =
          makeDefaultVolumeChunkSpecifications({
            rank: 3,
            chunkToMultiscaleTransform,
            dataType: this.dataType,

            baseVoxelOffset: lowerVoxelBound,
            upperVoxelBound: vec3.subtract(vec3.create(), upperVoxelBound, lowerVoxelBound),
            volumeType: this.volumeType,
            volumeSourceOptions,
            compressedSegmentationBlockSize:
                ((encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
                  encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) ?
                     vec3.fromValues(8, 8, 8) :
                     undefined)
          }).map(spec => ({
                   chunkSource: chunkManager.getChunkSource(
                       DVIDVolumeChunkSource, {spec, parameters: volParameters, credentialsProvider}),
                   chunkToMultiscaleTransform,
                 }));
      sources.push(alternatives);
    }
    return transposeNestedArrays(sources);
  }
}

export function parseDataInstanceFromRepoInfo(
  dataInstanceObjs: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(dataInstanceObjs);
  let dataInstance = dataInstanceObjs[name];
  let baseInfo = verifyObjectProperty(dataInstance, 'Base', x => new DataInstanceBaseInfo(x));
  if (baseInfo.typeName === 'annotation') {
    let syncedLabel = getSyncedLabel(dataInstance);
    if (syncedLabel) {
      dataInstance = dataInstanceObjs[syncedLabel];
    } else {
      dataInstance = getVolumeInfoResponseFromTags(getInstanceTags(dataInstance));
    }

    return new AnnotationDataInstanceInfo(dataInstance, name, baseInfo);
  } {
    return parseDataInstance(dataInstance, name, instanceNames);
  }
}

export function parseDataInstance(
    obj: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  switch (baseInfo.typeName) {
    case 'uint8blk':
    case 'grayscale8':
      let isjpegcompress = baseInfo.compressionName.indexOf('jpeg') !== -1;
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo,
          (isjpegcompress ? VolumeChunkEncoding.JPEG : VolumeChunkEncoding.RAW), instanceNames);
    case 'labels64':
    case 'labelblk':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeChunkEncoding.COMPRESSED_SEGMENTATION, instanceNames);
    case 'labelarray':
    case 'labelmap':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY, instanceNames);
    default:
      throw new Error(`DVID data type ${JSON.stringify(baseInfo.typeName)} is not supported.`);
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
    this.alias = verifyObjectProperty(obj, 'Alias', verifyString);
    this.description = verifyObjectProperty(obj, 'Description', verifyString);
    let dataInstanceObjs = verifyObjectProperty(obj, 'DataInstances', verifyObject);
    let instanceKeys = Object.keys(dataInstanceObjs);
    for (let key of instanceKeys) {
      try {
        this.dataInstances.set(key, parseDataInstanceFromRepoInfo(dataInstanceObjs, key, instanceKeys));
      } catch (parseError) {
        let message = `Failed to parse data instance ${JSON.stringify(key)}: ${parseError.message}`;
        console.log(message);
        this.errors.push(message);
      }
    }

    let dagObj = verifyObjectProperty(obj, 'DAG', verifyObject);
    let nodeObjs = verifyObjectProperty(dagObj, 'Nodes', verifyObject);
    for (let key of Object.keys(nodeObjs)) {
      this.vnodes.add(key);
    }
  }
}

export function parseRepositoriesInfo(obj: any) {
  try {
    let result = verifyObjectAsMap(obj, x => new RepositoryInfo(x));

    // make all versions available for viewing
    let allVersions = new Map<string, RepositoryInfo>();
    for (let [key, info] of result) {
      allVersions.set(key, info);
      for (let key2 of info.vnodes) {
        if (key2 !== key) {
          // create new repo
          let rep = new RepositoryInfo(info);
          allVersions.set(key2, rep);
        }
      }
    }

    for (let [key, info] of allVersions) {
      info.uuid = key;
    }
    return allVersions;
  } catch (parseError) {
    throw new Error(`Failed to parse DVID repositories info: ${parseError.message}`);
  }
}

export class ServerInfo {
  repositories: Map<string, RepositoryInfo>;
  constructor(obj: any) {
    this.repositories = parseRepositoriesInfo(obj);
  }

  getNode(nodeKey: string): RepositoryInfo {
    // FIXME: Support non-root nodes.
    let matches: string[] = [];
    for (let key of this.repositories.keys()) {
      if (key.startsWith(nodeKey)) {
        matches.push(key);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
          `Node key ${JSON.stringify(nodeKey)} matches ${JSON.stringify(matches)} nodes.`);
    }
    return this.repositories.get(matches[0])!;
  }
}

type AuthType = string|undefined|null;

export function getServerInfo(chunkManager: ChunkManager, baseUrl: string, credentialsProvider: CredentialsProvider<DVIDToken>) {
  return chunkManager.memoize.getUncounted({type: 'dvid:getServerInfo', baseUrl}, () => {
    const result = makeRequestWithCredentials(credentialsProvider, {url: `${baseUrl}/api/repos/info`, method: 'GET', responseType: 'json'})
    .then(response => new ServerInfo(response));
    const description = `repository info for DVID server ${baseUrl}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    return result;
  });
}

function getInstanceTags(dataInfo: any) {
  let baseInfo = verifyObjectProperty(dataInfo, 'Base', verifyObject);

  return verifyObjectProperty(baseInfo, 'Tags', verifyObject);
}

function getVolumeInfoResponseFromTags(tags: any) {
  let MaxDownresLevel = parseInt(verifyObjectProperty(tags, 'MaxDownresLevel', verifyString));
  let MaxPoint = JSON.parse(verifyObjectProperty(tags, "MaxPoint", verifyString));
  let MinPoint = JSON.parse(verifyObjectProperty(tags, "MinPoint", verifyString));
  let VoxelSize = JSON.parse(verifyObjectProperty(tags, "VoxelSize", verifyString));

  let response: any = {
    Base: {
    },
    Extended: {
      VoxelSize,
      MinPoint,
      MaxPoint,
      MaxDownresLevel
    }
  };

  if ('BlockSize' in tags) {
    response.BlockSize = JSON.parse(verifyObjectProperty(tags, "BlockSize", verifyString));
  }

  return response;
}

function getSyncedLabel(dataInfo: any): string {
  let baseInfo = verifyObjectProperty(dataInfo, 'Base', verifyObject);
  let syncs = verifyObjectProperty(baseInfo, 'Syncs', verifyStringArray);


  if (syncs.length === 1) {
    return syncs[0];
  } else {
    return '';
  }
}

function userTagged(parameters: DVIDSourceParameters) {
  if (parameters.usertag) {
    return true;
  } else {
    if (parameters instanceof AnnotationSourceParametersBase) {
      if(parameters.tags && parameters.usertag === undefined) {
        return parameters.tags['annotation'] === 'user-supplied';
      }
    }
  }

  return false;
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

  constructor(
      chunkManager: ChunkManager, public baseUrl: string, public nodeKey: string,
      public dataInstanceKey: string, public info: VolumeDataInstanceInfo, public credentialsProvider: CredentialsProvider<DVIDToken>) {
    super(chunkManager);

    this.makeProofreadWidget = (mergingJsonProvider: () => Array<string>, postUpload: () => void) => {
      return createProofreadWidget((mergingJson: Array<string>) => {
        let dvidInstance = new DVIDInstance(this.baseUrl, this.nodeKey);
        return mergeBodies(dvidInstance, this.dataInstanceKey, mergingJson, this.credentialsProvider, this.info.defaultUser);
      },
      mergingJsonProvider,
      postUpload)
    };

    this.getSegmentGeometryInfo = async (id: string) => {
      let dvidInstance = new DVIDInstance(this.baseUrl, this.nodeKey);
      let bodySizeInfo = await getBodySizeInfo(dvidInstance.getNodeApiUrl(`/${dataInstanceKey}`), id, this.credentialsProvider, this.info.defaultUser);

      try {
        let bodyLocation = await (getBodyLocation(dvidInstance, id, this.credentialsProvider, this.info.defaultUser));
        if (bodyLocation) {
          bodySizeInfo['location'] = bodyLocation;
        }
      } catch {
        (e:Error) => console.log(e);
      }

      return bodySizeInfo;
    }

    this.getSegmentAnnotation = (id: string) => {
      let dvidInstance = new DVIDInstance(this.baseUrl, this.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'HEAD',
          url: dvidInstance.getSparsevolUrl(this.dataInstanceKey, id),
          responseType: ''
        }).then(
          () => {
            return makeRequestWithCredentials(
              this.credentialsProvider,
              {
                method: 'GET',
                url: dvidInstance.getBodyAnnotationUrl(this.dataInstanceKey, id),
                responseType: 'json'
              }).then(response => {
                let annot = ('instance' in response) ? response['instance'] : '';
                let type = ('class' in response) ? response['class'] : '';
                if (annot || type) {
                  annot += ':' + type;
                }
                let status = ('status' in response) ? response['status'] : '';
      
                if (status) {
                  annot += ', ' + status;
                }
                return annot;
              }).catch(
                e => {
                  console.log(e);
                  return '';
                }
              );
          }
        ).catch(e => {
          console.log(e);
          return null;
        });
      }
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
        this.chunkManager, {
          'baseUrl': this.baseUrl,
          'nodeKey': this.nodeKey,
          'dataInstanceKey': this.dataInstanceKey
        },
        volumeSourceOptions,
        this.credentialsProvider);
  }
}

// const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)(\?.*)?$/;
const urlPattern = /^([^\/]+:\/\/[^\/]+)\/([^\/]+)\/([^\/\?]+)(\?.*)?$/;

function getDefaultAuthServer(baseUrl: string) {
  if (baseUrl.startsWith('https')) {
    return baseUrl + '/api/server/token';
  } else {
    return undefined;
  }
}

function parseSourceUrl(url: string): DVIDSourceParameters {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  let queryString = match[4];
  let sourceParameters: DVIDSourceParameters = {
    // ...new AnnotationSourceParameters(),
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };

  let parameters:any = {};
  if (queryString && queryString.length > 1) {
    parameters = parseQueryStringParameters(queryString.substring(1));
    if (parameters.usertag) {
      sourceParameters.usertag =  (parameters.usertag === 'true');
    }
    if (parameters.user) {
      sourceParameters.user = parameters.user;
    } /*else {
      sourceParameters.authServer = getDefaultAuthServer(sourceParameters.baseUrl);
    }*/
  }



  let auth = parameters.auth;
  /*
  if (!auth) {
    if (sourceParameters.baseUrl.startsWith('https')) {
      auth = `${sourceParameters.baseUrl}/api/server/token`;
    }
  }
  */

  if (auth) {
    sourceParameters.authServer = auth;
  } else {
    sourceParameters.authServer = getDefaultAuthServer(sourceParameters.baseUrl);
  }

  return sourceParameters;
}

async function getAnnotationChunkSource(options: GetDataSourceOptions, sourceParameters: AnnotationSourceParameters, dataInstanceInfo: AnnotationDataInstanceInfo, credentialsProvider: CredentialsProvider<DVIDToken>) {
  let getChunkSource = (multiscaleVolumeInfo: any, parameters: any) => options.chunkManager.getChunkSource(
    DVIDAnnotationSource, <any>{
    parameters,
    credentialsProvider,
    multiscaleVolumeInfo
  });

  let multiscaleVolumeInfo = new MultiscaleVolumeInfo(dataInstanceInfo.obj);

  return getChunkSource(multiscaleVolumeInfo, sourceParameters);
}

async function getAnnotationSource(options: GetDataSourceOptions, sourceParameters: AnnotationSourceParameters, dataInstanceInfo: AnnotationDataInstanceInfo, credentialsProvider: CredentialsProvider<DVIDToken>) {

  const box: BoundingBox = {
    lowerBounds: new Float64Array(dataInstanceInfo.lowerVoxelBound),
    upperBounds: Float64Array.from(dataInstanceInfo.upperVoxelBoundInclusive, x => x + 1)
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ['x', 'y', 'z'],
    units: ['m', 'm', 'm'],
    scales: Float64Array.from(dataInstanceInfo.voxelSize, x => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const annotation = await getAnnotationChunkSource(options, sourceParameters, dataInstanceInfo, credentialsProvider);

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

async function updateMergeStat(mergeDataName: string, sourceParameters: DVIDSourceParameters, credentialsProvider: CredentialsProvider<DVIDToken>) {
  let credentials = await credentialsProvider.get();
  const user = getUser(sourceParameters, credentials.credentials);
  if (user) {
    let dataInstance = new DVIDInstance(sourceParameters.baseUrl, sourceParameters.nodeKey);
    makeRequestWithCredentials(credentialsProvider, {
      method: 'GET',
      url: dataInstance.getMergeStatUrl(mergeDataName, user),
      responseType: 'json'
    }).then(
      response => {
        verifyObject(response);
        proofreadingStats.numBodyMerged.value = verifyObjectProperty(response,'numBodyMerged', verifyInt);
      }
    ).catch ( e => {
      console.log(e);
    }
    );
  }
}

async function getVolumeSource(options: GetDataSourceOptions, sourceParameters: DVIDSourceParameters, dataInstanceInfo: DataInstanceInfo, credentialsProvider: CredentialsProvider<DVIDToken>) {
  const baseUrl = sourceParameters.baseUrl;
  const nodeKey = sourceParameters.nodeKey;
  const dataInstanceKey = sourceParameters.dataInstanceKey;

  const info = <VolumeDataInstanceInfo>dataInstanceInfo;

  const box: BoundingBox = {
    lowerBounds: new Float64Array(info.lowerVoxelBound),
    upperBounds: Float64Array.from(info.upperVoxelBoundInclusive, x => x + 1)
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ['x', 'y', 'z'],
    units: ['m', 'm', 'm'],
    scales: Float64Array.from(info.voxelSize, x => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const volume = new DvidMultiscaleVolumeChunkSource(
    options.chunkManager, baseUrl, nodeKey, dataInstanceKey, info, credentialsProvider);

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [{
      id: 'default',
      subsource: { volume },
      default: true,
    }],
  };
  if (info.meshSrc) {
    const subsourceToModelSubspaceTransform = mat4.create();
    for (let i = 0; i < 3; ++i) {
      subsourceToModelSubspaceTransform[5 * i] = 1 / info.voxelSize[i];
    }
    dataSource.subsources.push({
      id: 'meshes',
      default: true,
      subsource: {
        mesh: options.chunkManager.getChunkSource(DVIDMeshSource, {
          parameters: {
            ...sourceParameters,
            'dataInstanceKey': info.meshSrc
          },
          'credentialsProvider': credentialsProvider
        })
      },
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletonSrc) {
    dataSource.subsources.push({
      id: 'skeletons',
      default: true,
      subsource: {
        mesh: options.chunkManager.getChunkSource(DVIDSkeletonSource, {
          parameters: {
            ...sourceParameters,
            'dataInstanceKey': info.skeletonSrc
          },
          'credentialsProvider': credentialsProvider
        })
      },
    });
  }
  dataSource.subsources.push({
    id: 'bounds',
    subsource: { staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box) },
    default: true,
  });

  if (info.mergeSrc) {
    updateMergeStat(info.mergeSrc, sourceParameters, credentialsProvider);
  }

  return dataSource;
}

function getSchema(parameters: AnnotationSourceParameters) {
  if (parameters.tags) {
    let schemaJson = parameters.tags['schema'];
    if (schemaJson) {
      return JSON.parse(schemaJson);
    }
  }
}

function bodyArrayToJson(bodyArray: Array<string>)
{
  return `[${bodyArray.join()}]`; 
}

function getCredentialsProvider(authServer: AuthType) {
  if (authServer) {
    return defaultCredentialsManager.getCredentialsProvider<DVIDToken>(dvidCredentailsKey(authServer), authServer);
  } else {
    return defaultCredentialsManager.getCredentialsProvider<DVIDToken>(dvidCredentailsKey(credentialsKey), authServer);
  }
}

async function uploadMergedMesh(
  meshUrl: string, bodyArray: Array<string>, user: string | null | undefined, credentialsProvider: CredentialsProvider<DVIDToken>) 
{
  try {
    let response = await makeRequestWithCredentials(
      credentialsProvider,
      {
        url: appendQueryStringForDvid(meshUrl, user),
        method: 'POST',
        responseType: '',
        payload: bodyArrayToJson(bodyArray)
      }
    );

    return response;
  } catch (e) {
    throw new Error(e);
  }
}

async function getBodySizeInfo(dataInstanceUrl: string, body: string, credentialsProvider: CredentialsProvider<DVIDToken>, user: string|undefined|null) {
  return makeRequestWithCredentials(
    credentialsProvider,
    {
      url: appendQueryStringForDvid(dataInstanceUrl + `/sparsevol-size/${body}`, user),
      method: 'GET',
      responseType: 'json'
    }
  ).catch(() => null);
}

async function getBodyLocation(dvidInstance: DVIDInstance, body: string, credentialsProvider: CredentialsProvider<DVIDToken>, user: string|undefined|null) {
  if (defaultLocateService) {
    const serviceUrl = defaultLocateService + `?dvid=${dvidInstance.baseUrl}&uuid=${dvidInstance.nodeKey}&body=${body}` + (user ? `&u=${user}` : '');

    return makeRequestWithCredentials(credentialsProvider, {
      method: 'GET',
      url: serviceUrl,
      responseType: 'json',
    });
  } else {
    throw new Error('No mesh service available');
  }
}

async function getBodySizes(dataInstanceUrl: string, bodyArray: Array<string>, credentialsProvider: CredentialsProvider<DVIDToken>, user: string|undefined|null)
{
  let promiseArray = new Array<Promise<number>>();
  for (let body of bodyArray) {
    promiseArray.push(
      makeRequestWithCredentials(
        credentialsProvider,
        {
          url: appendQueryStringForDvid(dataInstanceUrl + `/size/${body}`, user),
          method: 'GET',
          responseType: 'json'
        }
      ).then(response => verifyObjectProperty(response, 'voxels', verifyPositiveInt)).catch(e => {
        throw new Error(`Failed to read body size for ${body}: ` + e);
      })
    );
  }
  return Promise.all(promiseArray);
}

export let proofreadingStats = {
  numBodyMerged: new TrackableValue<number>(0, verifyInt),
  numBookmarkAdded: new TrackableValue<number>(0, verifyInt)
};

export async function mergeBodies(dvidInstance: DVIDInstance, dataInstanceKey: string, bodyArray: Array<string>, credentialsProvider: CredentialsProvider<DVIDToken>, defaultUser?: string)
{
  let credentials = await credentialsProvider.get();
  const tokenProvider = getCredentialsProvider('token:' + credentials.credentials);
  const user = getUserFromToken(credentials.credentials, defaultUser);

  let dataInstanceUrl = dvidInstance.getNodeApiUrl(`/${dataInstanceKey}`);

  let bodySizes = await getBodySizes(dataInstanceUrl, bodyArray, credentialsProvider, defaultUser);
  let newBodyArray = [...bodyArray];
  newBodyArray.sort((a: string, b: string) => {
    let cmp = bodySizes[bodyArray.indexOf(a)] < bodySizes[bodyArray.indexOf(b)] ? 1 : -1;
    return cmp;
  })

  let data = bodyArrayToJson(newBodyArray);
  let mergeUrl = `${dataInstanceUrl}/merge`;
  return makeRequestWithCredentials(
    tokenProvider,
    {
      // url: dvidInstance.getNodeApiUrl(`/${dataInstanceKey}/info`),
      // method: 'GET',
      url: mergeUrl + `?app=Neuroglancer` + (user ? `&u=${user}` : ''),
      method: 'POST',
      responseType: 'json',
      payload: data
    }).then(async () => {
      proofreadingStats.numBodyMerged.value = proofreadingStats.numBodyMerged.value + bodyArray.length;
      try {
        if (user) {
          makeRequestWithCredentials(
            credentialsProvider,
            {
              url: dvidInstance.getMergeStatUrl('neutu_merge_opr', user) + `?app=Neuroglancer` + (user ? `&u=${user}` : ''),
              method: 'POST',
              responseType: '',
              payload: JSON.stringify({'numBodyMerged': proofreadingStats.numBodyMerged.value})
            }
          );
        }
      } catch(e) {
        throw new Error(e);
      }

      let meshUrl = dvidInstance.getNodeApiUrl(`/${dataInstanceKey}_meshes/key/${newBodyArray[0]}.merge`);
      try {
        await makeRequestWithCredentials(
          tokenProvider, {
          method: 'GET', url: meshUrl, responseType: 'json'
        }).then(
          response => {
            newBodyArray = newBodyArray.concat(response.slice(1).map((e: any) => String(e)));
            uploadMergedMesh(meshUrl, newBodyArray, user, tokenProvider);
          }
        )
      } catch (e) {
        uploadMergedMesh(meshUrl, newBodyArray, user, tokenProvider);
      }
      
      return newBodyArray;
    });
}

/*
export async function mergeBodies(sourceUrl: string, bodyArray: Array<string>)
{
  let sourceParameters = parseSourceUrl(sourceUrl);
  let { baseUrl, nodeKey, dataInstanceKey } = sourceParameters;

  let dvidInstance = new DVIDInstance(baseUrl, nodeKey);
  mergeBodiesT(dvidInstance, dataInstanceKey, bodyArray, getCredentialsProvider(sourceParameters.authServer), sourceParameters.user);
}
*/

function getDataSource(options: GetDataSourceOptions, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>): Promise<DataSource> {
  // let match = options.providerUrl.match(urlPattern);
  // if (match === null) {
  //   throw new Error(`Invalid DVID URL: ${JSON.stringify(options.providerUrl)}.`);
  // }

  let sourceParameters = parseSourceUrl(options.providerUrl);

  const {baseUrl, nodeKey, dataInstanceKey} = sourceParameters;
  
  return options.chunkManager.memoize.getUncounted(
      {
        type: 'dvid:MultiscaleVolumeChunkSource',
        baseUrl,
        nodeKey: nodeKey,
        dataInstanceKey,
      },
      async () => {
        let credentials = await getCredentialsProvider(sourceParameters.authServer).get();
        const credentialsProvider = getCredentialsProvider('token:' + credentials.credentials);
        const serverInfo = await getServerInfo(options.chunkManager, baseUrl, credentialsProvider);
        let repositoryInfo = serverInfo.getNode(nodeKey);
        if (repositoryInfo === undefined) {
          throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
        }
        const dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);

        if (!dataInstanceInfo) {
          throw new Error(`Invalid data instance ${dataInstanceKey}.`);
        }

        sourceParameters.user = getUser(sourceParameters, credentials.credentials);

        if (sourceParameters.user) {
          dataInstanceInfo.defaultUser = sourceParameters.user;
        }

        if (dataInstanceInfo.base.typeName === 'annotation') {
          if (!(dataInstanceInfo instanceof AnnotationDataInstanceInfo)) {
            throw new Error(`Invalid data instance ${dataInstanceKey}.`);
          }

          let annotationSourceParameters: AnnotationSourceParameters = {
            ...new AnnotationSourceParameters(),
            ...sourceParameters
          };

          annotationSourceParameters.tags = dataInstanceInfo.tags;
          annotationSourceParameters.schema = getSchema(annotationSourceParameters);
          annotationSourceParameters.syncedLabel = getSyncedLabel({ Base: dataInstanceInfo.base.obj });
          annotationSourceParameters.properties = [{
            identifier: 'rendering_attribute',
            description: 'rendering attribute',
            type: 'int32',
            default: 0,
            min: 0,
            max: 5,
            step: 1
          }];

          annotationSourceParameters.usertag = userTagged(sourceParameters);

          // let annotationDataInstanceInfo = await getAnnotationDataInstanceDetails(options.chunkManager, sourceParameters, dataInstanceInfo, credentialsProvider);
          
          return getAnnotationSource(options, annotationSourceParameters, dataInstanceInfo, credentialsProvider);
        } else {
          if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
            throw new Error(`Invalid data instance ${dataInstanceKey}.`);
          }
          return getVolumeSource(options, sourceParameters, dataInstanceInfo, credentialsProvider);
        }
      });
}

export function completeInstanceName(
    repositoryInfo: RepositoryInfo, prefix: string): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
        prefix, repositoryInfo.dataInstances.values(), instance => instance.name,
        instance => {
          return `${instance.base.typeName}`;
        })
  };
}

export function completeNodeAndInstance(serverInfo: ServerInfo, prefix: string): CompletionResult {
  let match = prefix.match(/^(?:([^\/]+)(?:\/([^\/]*))?)?$/);
  if (match === null) {
    throw new Error(`Invalid DVID URL syntax.`);
  }
  if (match[2] === undefined) {
    // Try to complete the node name.
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions<RepositoryInfo>(
          prefix, serverInfo.repositories.values(), repository => repository.uuid + '/',
          repository => `${repository.alias}: ${repository.description}`)
    };
  }
  let nodeKey = match[1];
  let repositoryInfo = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(nodeKey.length + 1, completeInstanceName(repositoryInfo, match[2]));
}

export async function completeUrl(options: CompleteUrlOptions, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\?]*).*$/;
  let url = options.providerUrl;
  let auth:string|undefined = undefined;

  const firstMatch = options.providerUrl.match(/^([^\?]*)\?[^\?]*auth=([^&]*)/);

  if (firstMatch) {
    url = firstMatch[1];
    auth = firstMatch[2];
  }

  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    throw null;
  }
  let baseUrl = match[1];
  let path = match[2];
  if (!auth && baseUrl.startsWith('https')) {
    auth = `${baseUrl}/api/server/token`;
  }

  const serverInfo = await getServerInfo(options.chunkManager, baseUrl, getCredentialsProvider(auth));
  return applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path));
}

export class VolumeInfo {
  numChannels: number;
  voxelSize: vec3;
  upperVoxelBound: vec3;
  boundingBoxes: {corner: vec3, size: vec3, metadata?: string}[];
  numLevels = 1;
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = 1;

      let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
      let maxdownreslevel = verifyObjectProperty(extended, 'MaxDownresLevel', verifyPositiveInt);
      this.numLevels = maxdownreslevel + 1;

      this.voxelSize = verifyObjectProperty(extended, 'VoxelSize', x => parseIntVec(vec3.create(), x));
      this.upperVoxelBound = verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x.map((a:number) => {return ++a;})));

      let lowerVoxelBound = verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));

      this.boundingBoxes = [{
        corner: lowerVoxelBound,
        size: this.upperVoxelBound
      }];
    } catch (parseError) {
      throw new Error(`Failed to parse DVID volume geometry: ${parseError.message}`);
    }
  }
}

export class MultiscaleVolumeInfo {
  scales: VolumeInfo[];
  numChannels: number;
  constructor(volumeInfoResponse: any) {
    try {
      verifyObject(volumeInfoResponse);
      this.scales = [];
      let baseVolumeInfo = new VolumeInfo(volumeInfoResponse);
      this.scales.push(baseVolumeInfo);
      let lastVoxelSize = baseVolumeInfo.voxelSize;
      for (let level = 1; level < baseVolumeInfo.numLevels; ++level) {
        let volumeInfo:VolumeInfo = {...baseVolumeInfo};
        volumeInfo.voxelSize = vec3.multiply(vec3.create(), lastVoxelSize, vec3.fromValues(2, 2, 2 ));
        lastVoxelSize = volumeInfo.voxelSize;
        volumeInfo.upperVoxelBound = vec3.fromValues(0, 0, 0);
        this.scales.push(volumeInfo);
      }
      let baseScale = this.scales[0];
      this.numChannels = this.numChannels = baseScale.numChannels;
    } catch (parseError) {
      throw new Error(
          `Failed to parse DVID multiscale volume specification: ${parseError.message}`);
    }
  }
}

function getAnnotationChunkDataSize(parameters: AnnotationSourceParameters, upperVoxelBound: vec3) {
  if (parameters.usertag) {
    return upperVoxelBound;
  } else {
    return parameters.chunkDataSize;
  }
}

function makeAnnotationGeometrySourceSpecifications(multiscaleInfo: MultiscaleVolumeInfo, parameters: AnnotationSourceParameters) {
  const rank = 3;

  let makeSpec = (scale: VolumeInfo) => {
    const upperVoxelBound = scale.upperVoxelBound;
    const chunkDataSize = getAnnotationChunkDataSize(parameters, upperVoxelBound);
    let spec = makeSliceViewChunkSpecification({
      rank,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      upperVoxelBound: scale.upperVoxelBound
    });

    return { spec, chunkToMultiscaleTransform: mat4.create()};
  };

  if (parameters.usertag) {
    if (parameters.user) {
      return [[makeSpec(multiscaleInfo.scales[0])]];
    } else {
      throw("Expecting a valid user");
    }
  } else {
    // return [[makeSpec(multiscaleInfo.scales[0])]];
    return [multiscaleInfo.scales.map(scale => makeSpec(scale))];
  }
}

export class DVIDDataSource extends DataSourceProvider {
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  get description() {
    return 'DVID';
  }

  getCredentialsProvider(authServer: AuthType) {
    if (authServer) {
      const key = dvidCredentailsKey(authServer);
      if (!isDVIDCredentialsProviderRegistered(key)) {
        registerDVIDCredentialsProvider(key);
      }

      return this.credentialsManager.getCredentialsProvider<DVIDToken>(key, authServer);
    } else {
      return this.credentialsManager.getCredentialsProvider<DVIDToken>(dvidCredentailsKey(''));
    }
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options, this.getCredentialsProvider.bind(this));
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeUrl(options, this.getCredentialsProvider.bind(this));
  }
}

function getUser(parameters: DVIDSourceParameters, token:string) {
  const tokenUser = getUserFromToken(token);
  if (tokenUser) {
    if (parameters.user) {
      if (parameters.user !== tokenUser) {
        return undefined;
      }
    } else {
      return tokenUser;
    }
  }

  if (parameters.usertag && !parameters.user) {
    if (parameters instanceof AnnotationSourceParametersBase) {
      if (parameters.tags) {
        parameters.user = parameters.tags['guest'];
      }
    }
    if (!parameters.user) {
      return Env.getUser();
    }
  }

  return parameters.user;
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<DVIDToken>()(MultiscaleAnnotationSource), AnnotationSourceParameters);

export class DVIDAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  readonly = false;
  private multiscaleVolumeInfo: MultiscaleVolumeInfo;
  // sources: SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][];
  private updateAnnotationHandlers() {
    // updateRenderHelper();
    // updateAnnotationTypeHandler();
  }

  constructor(chunkManager: ChunkManager, options: {
    credentialsProvider: CredentialsProvider<DVIDToken>,
    parameters: AnnotationSourceParameters,
    multiscaleVolumeInfo: MultiscaleVolumeInfo
  }) {

    super(chunkManager, {
      rank: 3,
      relationships: options.parameters.syncedLabel ? [options.parameters.syncedLabel] : [],
      properties: options.parameters.properties,
      ...options
    });

    this.parameters = options.parameters;
    this.multiscaleVolumeInfo = options.multiscaleVolumeInfo;
    /*
      <any>{
      rank: 3,
      // sourceSpecifications:
          makeAnnotationGeometrySourceSpecifications(options.multiscaleVolumeInfo, options.parameters),
      ...options
    });
    */

    /*

    let sourceSpecifications = makeAnnotationGeometrySourceSpecifications(this.multiscaleVolumeInfo, options.parameters);
    
    this.sources = sourceSpecifications.map(
      alternatives =>
          alternatives.map(({spec, chunkToMultiscaleTransform}) => ({
            chunkSource: this.chunkManager.getChunkSource(DVIDAnnotationChunkSource, {
              spec: {limit: 1e9, ...spec}, 
              parent: this, 
              credentialsProvider: this.credentialsProvider,
              parameters: this.parameters
            }), chunkToMultiscaleTransform})));

            */

    /*
    this.sources = sourceSpecifications.map(
      alternatives =>
          alternatives.map(({spec, chunkToMultiscaleTransform}) => ({
                             chunkSource: this.registerDisposer(new AnnotationGeometryChunkSource(
                                 chunkManager, {spec: {limit: 1e9, ...spec}, parent: this})),
                             chunkToMultiscaleTransform
                           })));
                           */

    // mat4.fromScaling(this.objectToLocal, options.multiscaleVolumeInfo.scales[0].voxelSize);
    this.updateAnnotationHandlers();
    this.childAdded = this.childAdded || new Signal<(annotation: Annotation) => void>();
    this.childUpdated = this.childUpdated || new Signal<(annotation: Annotation) => void>();
    this.childDeleted = this.childDeleted || new Signal<(annotationId: string) => void>();
    this.childRefreshed = this.childRefreshed || new NullarySignal();

    if (this.parameters.readonly !== undefined) {
      this.readonly = this.parameters.readonly;
    }
  
    if (!this.parameters.user || !this.parameters.usertag) {
      this.readonly = true;
    }

    this.makeEditWidget = (reference: AnnotationReference) => {
      return makeAnnotationEditWidget(reference, this.parameters.schema, this);
    };
    
    /*
    this.makeEditWidget = (reference: AnnotationReference) => {
      const annotation = reference.value!;
      
      if (annotation.type !== AnnotationType.POINT && annotation.type !== AnnotationType.SPHERE &&
      annotation.type !== AnnotationType.LINE) {
        return null;
      }

      let schema = defaultJsonSchema;
      if (annotation.type === AnnotationType.POINT) {
        if (this.parameters.schema) {
          schema = this.parameters.schema;
        }
      }
      // let schema = this.parameters.schema || defaultJsonSchema;

      const prop = (<DVIDPointAnnotation>(annotation)).prop;

      let widget = createAnnotationWidget(schema, { 'Prop': prop }, this.readonly);
      // console.log(annotation);
      // setWidgetFromObject(widget, annotation.property, 'annotation\\Prop');
      let button = document.createElement('button');
      button.textContent = 'update';
      button.onclick = () => {
        let result: any = {};
        getObjectFromWidget(schema, '', result, 'annotation');
        // alert(JSON.stringify(result));
        const x = result['Prop'];
        if (annotation.type === AnnotationType.POINT) {
          let newAnnotation = <DVIDPointAnnotation>annotation;
          let annotFac = new DVIDPointAnnotationFacade(newAnnotation);
          if (x.checked) {
            x.checked = annotFac.getBooleanProperty(x.checked);
          }
          annotFac.prop = {...newAnnotation.prop, ...x};
        } else {
          let newAnnotation = <DVIDSphereAnnotation>annotation;
          let annotFac = new DVIDSphereAnnotationFacade(newAnnotation);
          if (x) {
            annotFac.prop = newAnnotation.prop ? {...newAnnotation.prop, ...x} : x;
          }
        }
        // let newAnnotation: DVIDPointAnnotation = <DVIDPointAnnotation>(annotation);

        
        annotation.description = getAnnotationDescription(<DVIDAnnotation>annotation);
        this.update(reference, annotation);
        this.commit(reference);
      };
      widget.appendChild(button);

      return widget;
    }
*/
    this.makeFilterWidget = () => {
      let element = createBasicElement(
        {title: 'Filter', type: 'string'}, 'annotationFilter', '');
      element.addEventListener('change', (e: Event) => {
        console.log(e);
      });
      
      return element;
    };
  }

  getSources(_options: VolumeSourceOptions):
    SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {

    let sourceSpecifications = makeAnnotationGeometrySourceSpecifications(this.multiscaleVolumeInfo, this.parameters);

    let limit = 0; //estimated annotation count in a chunk
    if (sourceSpecifications[0].length > 1) {
      limit = 3;
    }

    return sourceSpecifications.map(
      alternatives =>
        alternatives.map(({ spec, chunkToMultiscaleTransform }) => ({
          chunkSource: this.chunkManager.getChunkSource(DVIDAnnotationChunkSource, {
            spec: { limit, chunkToMultiscaleTransform, ...spec },
            parent: this,
            credentialsProvider: this.credentialsProvider,
            parameters: this.parameters
          }), 
          chunkToMultiscaleTransform
        })));

    // const { sources } = this;
    // sources.forEach(alternatives => alternatives.forEach(source => source.chunkSource.addRef()));
    // return sources;
  }

  invalidateCache() {
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
    this.childRefreshed.dispatch();
  }

  commit(reference: Borrowed<AnnotationReference>) {
    if (reference.value && (reference.value.type === AnnotationType.SPHERE || reference.value.type === AnnotationType.LINE)) {
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

    if (annotation.type === AnnotationType.POINT) {
      let annotationRef = new DVIDPointAnnotationFacade(<DVIDPointAnnotation>annotation);
      annotationRef.kind = 'Note';
      
      // (<DVIDPointAnnotation>annotation).kind = 'Note';
      annotation.point = annotation.point.map(x => Math.round(x));
      annotationRef.setCustom(true);
      annotationRef.addTimeStamp();

      if (annotation.description) {
        let defaultProp = parseDescription(annotation.description);
        if (defaultProp) {
          annotationRef.addProp(defaultProp);
          annotation.description = getAnnotationDescription(<DVIDPointAnnotation>annotation);
        }
      }
    } else if (annotation.type == AnnotationType.SPHERE) {
      annotation.pointA = annotation.pointA.map(x => Math.round(x));
      annotation.pointB = annotation.pointB.map(x => Math.round(x));
      let annotationRef = new DVIDSphereAnnotationFacade(<DVIDSphereAnnotation>annotation);
      annotationRef.addTimeStamp();
    } else if (annotation.type == AnnotationType.LINE) {
      annotation.pointA = annotation.pointA.map(x => Math.round(x));
      annotation.pointB = annotation.pointB.map(x => Math.round(x));
      let annotationRef = new DVIDLineAnnotationFacade(<DVIDLineAnnotation>annotation);
      annotationRef.addTimeStamp();
    }

    return super.add(annotation, commit);
  }
}
/*
invalidateAnnotationSourceCache(chunkManager: ChunkManager, urlKey: string ) {
  let sourcKeyPromise = this.dvidAnnotationSourceKey.get(urlKey);
  if (sourcKeyPromise) {
    sourcKeyPromise
      .then(sourceKey => this.getAnnotationSourceFromSourceKey(chunkManager, sourceKey))
      .then(source => source.invalidateCache());
  }
}
*/