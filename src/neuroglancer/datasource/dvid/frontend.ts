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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CredentialsManager, CredentialsProvider} from 'neuroglancer/credentials_provider';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompletionResult, DataSource} from 'neuroglancer/datasource';
import {AnnotationSourceParameters, DVIDSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/dvid/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
// import {fetchOk} from 'neuroglancer/util/http_request';
import {parseQueryStringParameters, parseArray, parseFixedLengthArray, parseIntVec, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {DVIDInstance, DVIDToken, credentialsKey, makeRequestWithCredentials, makeRequestWithReadyCredentials} from 'neuroglancer/datasource/dvid/api';
import {AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend';
import { AnnotationType, Annotation, AnnotationReference } from 'neuroglancer/annotation';
import {Signal} from 'neuroglancer/util/signal';
import {Env, getUserFromToken, DVIDPointAnnotation, getAnnotationDescription, updateAnnotationTypeHandler, updateRenderHelper} from 'neuroglancer/datasource/dvid/utils';
import { getObjectId } from 'neuroglancer/util/object_id';
import { registerDVIDCredentialsProvider, isDVIDCredentialsProviderRegistered } from 'neuroglancer/datasource/dvid/register_credentials_provider';
import {createAnnotationWidget, getObjectFromWidget} from 'neuroglancer/datasource/dvid/widgets';
import { JsonObject } from 'neuroglancer/datasource/dvid/jsonschema';
import {defaultJsonSchema} from 'neuroglancer/datasource/dvid/utils';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string {
    return this.obj['TypeName'];
  }

  get compressionName(): string {
    return this.obj['Compression'];
  }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'TypeName', verifyString);
  }
}

export class DataInstanceInfo {
  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
}

class DVIDVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

class DVIDSkeletonSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(SkeletonSource), SkeletonSourceParameters)) {}

class DVIDMeshSource extends
(WithParameters(WithCredentialsProvider<DVIDToken>()(MeshSource), MeshSourceParameters)) {}

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  voxelSize: vec3;
  numChannels: number;
  numLevels: number;
  meshSrc: string;
  skeletonSrc: string;

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

    // only allow mesh or skeletons as sources but not both
    this.meshSrc = '';
    if (instSet.has(name + '_meshes')) {
      this.meshSrc = name + '_meshes';
    }

    this.skeletonSrc = '';
    if (this.meshSrc !== '') {
      if (instSet.has(name + '_skeletons')) {
        this.skeletonSrc = name + '_skeletons';
      }
    }


    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.numChannels = 1;
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
    let sources: VolumeChunkSource[][] = [];

    // must be 64 block size to work with neuroglancer properly
    let blocksize = 64;
    for (let level = 0; level < this.numLevels; ++level) {
      let voxelSize = vec3.scale(vec3.create(), this.voxelSize, Math.pow(2, level));
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        let lowerVoxelNotAligned =
            Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        // adjust min to be a multiple of blocksize
        lowerVoxelBound[i] = lowerVoxelNotAligned - (lowerVoxelNotAligned % blocksize);
        let upperVoxelNotAligned =
            Math.ceil((this.upperVoxelBound[i] + 1) * (this.voxelSize[i] / voxelSize[i]));
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
      let alternatives =
          VolumeChunkSpecification
              .getDefaults({
                voxelSize: voxelSize,
                dataType: this.dataType,
                numChannels: this.numChannels,
                transform: mat4.fromTranslation(
                    mat4.create(), vec3.multiply(vec3.create(), lowerVoxelBound, voxelSize)),
                baseVoxelOffset: lowerVoxelBound,
                upperVoxelBound: vec3.subtract(vec3.create(), upperVoxelBound, lowerVoxelBound),
                volumeType: this.volumeType,
                volumeSourceOptions,
                compressedSegmentationBlockSize:
                    ((encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
                      encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) ?
                         vec3.fromValues(8, 8, 8) :
                         undefined)
              })
              .map(spec => {
                return chunkManager.getChunkSource(
                    DVIDVolumeChunkSource, 
                    {
                      spec,
                      credentialsProvider: credentialsProvider,
                      parameters: volParameters
                    });
              });
      sources.push(alternatives);
    }
    return sources;
  }

  getMeshSource(chunkManager: ChunkManager, parameters: DVIDSourceParameters, credentialsProvider: CredentialsProvider<DVIDToken>) {
    if (this.meshSrc !== '') {
      return chunkManager.getChunkSource(DVIDMeshSource, {
        parameters: {
          'baseUrl': parameters.baseUrl,
          'nodeKey': parameters.nodeKey,
          'authServer': parameters.authServer,
          'dataInstanceKey': this.meshSrc
        },
        credentialsProvider: credentialsProvider
      });
    } else {
      return null;
    }
  }

  getSkeletonSource(chunkManager: ChunkManager, parameters: DVIDSourceParameters, credentialsProvider: CredentialsProvider<DVIDToken>) {
    if (this.skeletonSrc !== '') {
      return chunkManager.getChunkSource(DVIDSkeletonSource, {
        parameters: {
          'baseUrl': parameters.baseUrl,
          'nodeKey': parameters.nodeKey,
          'authServer': parameters.authServer,
          'dataInstanceKey': this.skeletonSrc
        },
        credentialsProvider: credentialsProvider
      });
    } else {
      return null;
    }
  }
}

/*
function parseDataInstances(obj: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let dataObj = verifyObjectProperty(obj, name, verifyObject);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  if (baseInfo.typeName === 'annotation') {
    let syncedLabel = getSyncedLabel(baseInfo);
    if (syncedLabel) {
      dataObj = verifyObjectProperty(obj, syncedLabel, verifyObject);
      baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
    }
  }

}
*/

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
        this.dataInstances.set(key, parseDataInstance(dataInstanceObjs[key], key, instanceKeys));
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

export function getServerInfo(chunkManager: ChunkManager, parameters: DVIDSourceParameters, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>) {
  return chunkManager.memoize.getUncounted({type: 'dvid:getServerInfo', parameters}, () => {
    const result = makeRequestWithCredentials(getCredentialsProvider(parameters.authServer), {url: `${parameters.baseUrl}/api/repos/info`, method: 'GET', responseType: "json"})
    .then(response => new ServerInfo(response));
    /*
    const result = fetchOk(`${parameters.baseUrl}/api/repos/info`)
                       .then(response => response.json())
                       .then(response => new ServerInfo(response));
                       */
    const description = `repository info for DVID server ${parameters.baseUrl}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    return result;
  });
}

/**
 * Get extra dataInstance info that isn't available on the server level.
 * this requires an extra api call
 */
export function getDataInstanceDetails(
    chunkManager: ChunkManager, parameters: DVIDSourceParameters, info: VolumeDataInstanceInfo, 
    getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>) {
  let {baseUrl, nodeKey} = parameters;
  return chunkManager.memoize.getUncounted(
      {type: 'dvid:getInstanceDetails', baseUrl, nodeKey, name: info.name}, async () => {
        /*
        let result = fetchOk(`${baseUrl}/api/node/${nodeKey}/${info.name}/info`)
                         .then(response => response.json());
                         */
        let instance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
        let result = makeRequestWithCredentials(getCredentialsProvider(parameters.authServer), {
          method: 'GET',
          url: instance.getNodeApiUrl(`/${info.name}/info`),
          responseType: 'json'
        });
        const description = `datainstance info for node ${nodeKey} and instance ${info.name} ` +
            `on DVID server ${baseUrl}`;

        StatusMessage.forPromise(result, {
          initialMessage: `Retrieving ${description}.`,
          delay: true,
          errorPrefix: `Error retrieving ${description}: `,
        });

        let instanceDetails = await result;
        let baseInfo = verifyObjectProperty(instanceDetails, 'Base', verifyObject);
        let typeName = verifyObjectProperty(baseInfo, 'TypeName', verifyString);
        if (typeName == 'annotation') {
          let syncedLabel = getSyncedLabel(instanceDetails);
          if (syncedLabel) {
            instanceDetails = await makeRequestWithCredentials(getCredentialsProvider(parameters.authServer), {
              method: 'GET',
              url: instance.getNodeApiUrl(`/${syncedLabel}/info`),
              responseType: 'json'
            });
          } else {
            let tags = getInstanceTags(instanceDetails);
            info.lowerVoxelBound = parseIntVec(vec3.create(), JSON.parse(verifyObjectProperty(tags, "MinPoint", verifyString)));
            info.upperVoxelBound = parseIntVec(vec3.create(), JSON.parse(verifyObjectProperty(tags, "MaxPoint", verifyString)));
            return info;
          }
        } 
        
        let extended = verifyObjectProperty(instanceDetails, 'Extended', verifyObject);
        info.lowerVoxelBound =
          verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
        info.upperVoxelBound =
          verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));

        return info;

        /*
        return result.then(instanceDetails => {
          let extended = verifyObjectProperty(instanceDetails, 'Extended', verifyObject);
          info.lowerVoxelBound =
              verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
          info.upperVoxelBound =
              verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
          return info;
        });
        */
      });
}

export class MultiscaleVolumeChunkSource implements  GenericMultiscaleVolumeChunkSource {
  get dataType() {
    return this.info.dataType;
  }
  get numChannels() {
    return this.info.numChannels;
  }
  get volumeType() {
    return this.info.volumeType;
  }

  constructor(
      public chunkManager: ChunkManager,
      public credentialsProvider: CredentialsProvider<DVIDToken>,
      public parameters: DVIDSourceParameters, public info: VolumeDataInstanceInfo) {}

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
        this.chunkManager, this.parameters,
        volumeSourceOptions, this.credentialsProvider);
  }

  getMeshSource() {
    let meshSource = this.info.getMeshSource(this.chunkManager, this.parameters, this.credentialsProvider);
    if (meshSource === null) {
      return this.info.getSkeletonSource(this.chunkManager, this.parameters, this.credentialsProvider);
    }
    return meshSource;
  }
}

// const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)(\?.*)?$/;
const urlPattern = /^([^\/]+:\/\/[^\/]+)\/([^\/]+)\/([^\/\?]+)(\?.*)?$/;

function parseVolumeKey(url: string): DVIDSourceParameters {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  let queryString = match[4];
  let sourceParameters: AnnotationSourceParameters = {
    ...new AnnotationSourceParameters(),
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };

  let parameters:any = {};
  if (queryString && queryString.length > 1) {
    parameters = parseQueryStringParameters(queryString.substring(1));
  }

  let auth = parameters.auth;
  if (!auth) {
    if (sourceParameters.baseUrl.startsWith('https')) {
      auth = `${sourceParameters.baseUrl}/api/server/token`;
    }
  }

  if (auth) {
    sourceParameters.authServer = auth;
  }

  return sourceParameters;
}

export function getVolume(chunkManager: ChunkManager, url: string, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>) {
  /*
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }
  const baseUrl = match[1];
  const nodeKey = match[2];
  const dataInstanceKey = match[3];
  */

  let parameters = parseVolumeKey(url);
  let {baseUrl, nodeKey, dataInstanceKey} = parameters;

  return getServerInfo(chunkManager, parameters, getCredentialsProvider)
      .then(serverInfo => {
        let repositoryInfo = serverInfo.getNode(parameters.nodeKey);
        if (repositoryInfo === undefined) {
          throw new Error(`Invalid node: ${JSON.stringify(parameters.nodeKey)}.`);
        }
        const dataInstanceInfo = repositoryInfo.dataInstances.get(parameters.dataInstanceKey);
        if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
          throw new Error(`Invalid data instance ${parameters.dataInstanceKey}.`);
        }
        return getDataInstanceDetails(chunkManager, parameters, dataInstanceInfo, getCredentialsProvider);
      })
      .then((info: VolumeDataInstanceInfo) => {
        return chunkManager.memoize.getUncounted(
            {
              type: 'dvid:MultiscaleVolumeChunkSource',
              baseUrl,
              nodeKey: nodeKey,
              dataInstanceKey,
            },
            () => new MultiscaleVolumeChunkSource(
                chunkManager, getCredentialsProvider(parameters.authServer), parameters, info));
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

export function volumeCompleter(
    url: string, chunkManager: ChunkManager, getCredentialsProvider: (auth:AuthType) => CredentialsProvider<DVIDToken>): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let baseUrl = match[1];
  let path = match[2];
  let parameters = new DVIDSourceParameters;
  parameters.baseUrl = baseUrl;
  if (baseUrl.startsWith('https')) {
    parameters.authServer = `${baseUrl}/api/server/token`;
  }
  return getServerInfo(chunkManager, parameters, getCredentialsProvider)
      .then(
          serverInfo =>
              applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path)));
}

const SERVER_DATA_TYPES = new Map<string, DataType>();
SERVER_DATA_TYPES.set('UINT8', DataType.UINT8);
SERVER_DATA_TYPES.set('UINT64', DataType.UINT64);

export class VolumeInfo {
  numChannels: number;
  dataType: DataType;
  voxelSize: vec3;
  upperVoxelBound: vec3;
  boundingBoxes: {corner: vec3, size: vec3, metadata?: string}[];
  numLevels = 1;
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = 1;
      let baseObj = verifyObjectProperty(obj, 'Base', verifyObject);
      this.dataType = verifyObjectProperty(baseObj, 'TypeName', x => x === undefined ? 'UINT8' : x.TypeName);

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
  dataType: DataType;
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
      this.dataType = this.dataType = baseScale.dataType;
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
  let makeSpec = (scale: VolumeInfo) => {
    const upperVoxelBound = scale.upperVoxelBound;
    const chunkDataSize = getAnnotationChunkDataSize(parameters, upperVoxelBound);
    let spec = new AnnotationGeometryChunkSpecification({
      voxelSize: scale.voxelSize,
      chunkSize: vec3.multiply(vec3.create(), chunkDataSize, scale.voxelSize),
      upperChunkBound: vec3.ceil(vec3.create(), vec3.divide(vec3.create(), upperVoxelBound, chunkDataSize))
    });

    return [{ parameters: undefined, spec }];
  };

  if (parameters.usertag) {
    if (parameters.user) {
      return [makeSpec(multiscaleInfo.scales[0])];
    } else {
      throw("Expecting a valid user");
    }
  } else {
    return multiscaleInfo.scales.map(scale => makeSpec(scale));
  }
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<DVIDToken>()(MultiscaleAnnotationSource), AnnotationSourceParameters);

export class DVIDAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  private updateAnnotationHandlers() {
    updateRenderHelper();
    updateAnnotationTypeHandler();
  }

  constructor(chunkManager: ChunkManager, options: {
    credentialsProvider: CredentialsProvider<DVIDToken>,
    parameters: AnnotationSourceParameters,
    multiscaleVolumeInfo: MultiscaleVolumeInfo
  }) {
    super(chunkManager, <any>{
      sourceSpecifications:
          makeAnnotationGeometrySourceSpecifications(options.multiscaleVolumeInfo, options.parameters),
      ...options
    });

    // this.annotationSchema = this.parameters.schema;
    mat4.fromScaling(this.objectToLocal, options.multiscaleVolumeInfo.scales[0].voxelSize);
    this.updateAnnotationHandlers();
    this.childAdded = this.childAdded || new Signal<(annotation: Annotation) => void>();
    this.childUpdated = this.childUpdated || new Signal<(annotation: Annotation) => void>();
    this.childDeleted = this.childDeleted || new Signal<(annotationId: string) => void>();

    if (this.parameters.readonly !== undefined) {
      this.readonly = this.parameters.readonly;
    }
  
    if (!this.parameters.user || !this.parameters.usertag) {
      this.readonly = true;
    }

    this.makeEditWidget = (reference: AnnotationReference) => {
      let schema = this.parameters.schema || defaultJsonSchema;
      const annotation = reference.value!;
      const properties: JsonObject = (<DVIDPointAnnotation>(annotation)).properties || {};

      let widget = createAnnotationWidget(schema, { 'Prop': properties }, this.readonly);
      // console.log(annotation);
      // setWidgetFromObject(widget, annotation.property, 'annotation\\Prop');
      let button = document.createElement('button');
      button.textContent = 'update';
      button.onclick = () => {
        let result: any = {};
        getObjectFromWidget(schema, '', result, 'annotation');
        // alert(JSON.stringify(result));
        const x = result['Prop'];
        let newAnnotation: DVIDPointAnnotation = <DVIDPointAnnotation>(annotation);
        if (newAnnotation.properties) {
          newAnnotation.properties = { ...newAnnotation.properties, ...x };
        } else {
          newAnnotation.properties = x;
        }
        newAnnotation.description = getAnnotationDescription(newAnnotation);
        this.update(reference, newAnnotation);
        this.commit(reference);
      };
      widget.appendChild(button);

      return widget;
    }
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    if (annotation.type === AnnotationType.POINT) {
      if (this.readonly) {
        let errorMessage = 'Permission denied for changing annotations.';
        StatusMessage.showTemporaryMessage(errorMessage);
        throw Error(errorMessage);
      }

      (<DVIDPointAnnotation>annotation).kind = 'Note';
      annotation.point = vec3.round(vec3.create(), annotation.point);
      let {properties} = <DVIDPointAnnotation>annotation;
      if (properties) { // Always assume user-defined bookmark
        if (!('custom'in properties)) {
          properties['custom'] = '1';
        }
      } else {
        (<DVIDPointAnnotation>annotation).properties = {'custom': '1'};
      }
    }
    return super.add(annotation, commit);
  }
}

function getUser(parameters: AnnotationSourceParameters, token:string) {
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
    if (parameters.tags) {
      parameters.user = parameters.tags['guest'];
    }
    if (!parameters.user) {
      return Env.getUser();
    }
  }

  return parameters.user;
}

function getDataInfo(
  parameters: AnnotationSourceParameters, credentials: DVIDToken): Promise<any> {
  // let instance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
  return makeRequestWithReadyCredentials(
    credentials,
    {
      method: 'GET',
      url: getDataInfoUrl(parameters),
      responseType: 'json'
    }
  )
}

async function parseAnnotationKey(key: string, getCredentialsProvider: (auth:string) => CredentialsProvider<DVIDToken>): Promise<AnnotationSourceParameters> {
  const match = key.match(/^([^\/]+:\/\/[^\/]+)\/([^\/]+)\/([^\/\?]+)(\?.*)?$/);

  if (match === null) {
    throw new Error(`Invalid DVID volume key: ${JSON.stringify(key)}.`);
  }

  let queryString = match[4];
  let sourceParameters: AnnotationSourceParameters = {
    ...new AnnotationSourceParameters(),
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
    usertag: undefined
  };

  let parameters:any = {};

  if (queryString && queryString.length > 1) {
    parameters = parseQueryStringParameters(queryString.substring(1));
    if (parameters.usertag) {
      sourceParameters.usertag =  (parameters.usertag === 'true');
    }
    if (parameters.user) {
      sourceParameters.user = parameters.user;
    }
  }

  let auth = parameters.auth;
  if (!auth) {
    if (sourceParameters.baseUrl.startsWith('https')) {
      auth = `${sourceParameters.baseUrl}/api/server/token`;
    }
  }

  let credentials = await getCredentialsProvider(auth).get();
  let dataInfo = await getDataInfo(sourceParameters, credentials.credentials);

  sourceParameters.tags = getInstanceTags(dataInfo);
  if ('BlockSize' in sourceParameters.tags) {
    sourceParameters.chunkDataSize = JSON.parse(verifyObjectProperty(sourceParameters.tags, "BlockSize", verifyString));
  }
  sourceParameters.authServer = 'token:' + credentials.credentials;
  sourceParameters.usertag = userTagged(sourceParameters);
  sourceParameters.user = getUser(sourceParameters, credentials.credentials);
  sourceParameters.syncedLabel = getSyncedLabel(dataInfo);
  sourceParameters.schema = getSchema(sourceParameters);

  return sourceParameters;

  /*
  return getCredentialsProvider(auth).get().then(
    credentials => getDataInfo(sourceParameters, credentials.credentials).then(
      response => {
        sourceParameters.tags = getInstanceTags(response);
        if ('BlockSize' in sourceParameters.tags) {
          sourceParameters.chunkDataSize = JSON.parse(verifyObjectProperty(sourceParameters.tags, "BlockSize", verifyString));
        }
        sourceParameters.authServer = 'token:' + credentials.credentials;
        sourceParameters.usertag = userTagged(sourceParameters);
        sourceParameters.user = getUser(sourceParameters, credentials.credentials);
        sourceParameters.syncedLabel = getSyncedLabel(response);
        return sourceParameters;
      }
    )
  );
  */
}

/*
function getDataInfoPath(parameters: AnnotationSourceParameters): string {
  return `/${parameters.dataInstanceKey}/info`;
}
*/

function getDataInfoUrl(parameters: AnnotationSourceParameters): string {
  return `${parameters.baseUrl}/api/node/${parameters.nodeKey}/${parameters.dataInstanceKey}/info`;
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

  return {
    Base: {
    },
    Extended: {
      VoxelSize,
      MinPoint,
      MaxPoint,
      MaxDownresLevel
    }
  };
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

function getSchema(parameters: AnnotationSourceParameters) {
  if (parameters.tags) {
    let schemaJson = parameters.tags['schema'];
    if (schemaJson) {
      return JSON.parse(schemaJson);
    }
  }
}

function userTagged(parameters: AnnotationSourceParameters) {
  if (parameters.usertag) {
    return true;
  } else if (parameters.tags && parameters.usertag === undefined) {
    return parameters.tags['annotation'] === 'user-supplied';
  }

  return false;
}

type AuthType = string|undefined|null;

export class DVIDDataSource extends DataSource {
  dvidAnnotationSourceKey: Promise<any>;
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  get description() {
    return 'DVID';
  }

  getCredentialsProvider(authServer: AuthType) {
    if (authServer) {
      if (!isDVIDCredentialsProviderRegistered(authServer)) {
        registerDVIDCredentialsProvider(authServer);
      }

      return this.credentialsManager.getCredentialsProvider<DVIDToken>(authServer, authServer);
    } else {
      return this.credentialsManager.getCredentialsProvider<DVIDToken>(credentialsKey, authServer);
    }
  }

  getVolume(chunkManager: ChunkManager, url: string) {
    return getVolume(chunkManager, url, this.getCredentialsProvider.bind(this));
  }

  volumeCompleter(url: string, chunkManager: ChunkManager) {
    return volumeCompleter(url, chunkManager, this.getCredentialsProvider.bind(this));
  }

  getMultiscaleInfo(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    let volumeId: string = parameters.dataInstanceKey;
    let instance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return chunkManager.memoize.getUncounted(
        {
          type: 'dvid:getMultiscaleInfo',
          volumeId,
          instance,
          credentialsProvider: getObjectId(this.getCredentialsProvider(parameters.authServer))
        },
        () => makeRequestWithCredentials(
          this.getCredentialsProvider(parameters.authServer), 
          {
            method: 'GET',
            url: instance.getNodeApiUrl(`/${volumeId}/info`), 
            responseType: 'json'
          }).then(response => new MultiscaleVolumeInfo(response)));
  }

  getAnnotationSourceFromSourceKey(chunkManager: ChunkManager, sourceKey: any) {
    let getChunkSource = (multiscaleVolumeInfo: any, parameters: any) => chunkManager.getChunkSource(
      DVIDAnnotationSource, {
      parameters,
      credentialsProvider: this.getCredentialsProvider(parameters.authServer),
      multiscaleVolumeInfo
    });

    let getMultiscaleInfo = (parameters: any) => {
      if (parameters.syncedLabel) {
        return this.getMultiscaleInfo(
          chunkManager, 
          { 'baseUrl': parameters.baseUrl, 'nodeKey': parameters.nodeKey, 'dataInstanceKey': parameters.syncedLabel, 'authServer': parameters.authServer })
          .then(info => {return {multiscaleInfo: info, parameters}});
      } else {
        return Promise.resolve(
          new MultiscaleVolumeInfo(getVolumeInfoResponseFromTags(parameters.tags)))
          .then(info => {return {multiscaleInfo: info, parameters}});
      }
    }

    return chunkManager.memoize.getUncounted(
      sourceKey,
      () => Promise.resolve(sourceKey['parameters'])
        .then(parameters => getMultiscaleInfo(parameters))
        .then(result => getChunkSource(result.multiscaleInfo, result.parameters)));

    /*
    return chunkManager.memoize.getUncounted(
      sourceKey,
      () => Promise.resolve(sourceKey['parameters']).then(parameters => {
        if (parameters.syncedLabel) {
          return this.getMultiscaleInfo(
            chunkManager, 
            { 'baseUrl': parameters.baseUrl, 'nodeKey': parameters.nodeKey, 'dataInstanceKey': parameters.syncedLabel })
          .then(multiscaleVolumeInfo => chunkManager.getChunkSource(
            DVIDAnnotationSource, {
            parameters,
            credentialsProvider: this.getCredentialsProvider(parameters.authServer),
            multiscaleVolumeInfo
          }));
        }
        
      }));
      */
  }

  getAnnotationSource(chunkManager: ChunkManager, key: string) {
    this.dvidAnnotationSourceKey = parseAnnotationKey(key, this.getCredentialsProvider.bind(this)).then(
      parameters => {
        return {
          type: 'dvid:getAnnotationSource',
          parameters
        };
      });

    return this.dvidAnnotationSourceKey.then(
      sourceKey => this.getAnnotationSourceFromSourceKey(chunkManager, sourceKey));
  }
}
