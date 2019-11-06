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
import {CompletionResult, DataSource} from 'neuroglancer/datasource';
import {AnnotationSourceParameters, DVIDSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, annotationChunkDataSize} from 'neuroglancer/datasource/dvid/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {fetchOk} from 'neuroglancer/util/http_request';
import {parseQueryStringParameters, parseArray, parseFixedLengthArray, parseIntVec, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {DVIDInstance, makeRequest} from 'neuroglancer/datasource/dvid/api';
import {AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend';
import { AnnotationType, Annotation, AnnotationReference } from 'neuroglancer/annotation';
import {Signal} from 'neuroglancer/util/signal';
import {Env, getUserFromToken, isNonEmptyString, DVIDPointAnnotation, updateAnnotationTypeHandler, updateRenderHelper} from 'neuroglancer/datasource/dvid/utils';

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
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

class DVIDSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {}

class DVIDMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {}

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
      volumeSourceOptions: VolumeSourceOptions) {
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
                    DVIDVolumeChunkSource, {spec, parameters: volParameters});
              });
      sources.push(alternatives);
    }
    return sources;
  }

  getMeshSource(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    if (this.meshSrc !== '') {
      return chunkManager.getChunkSource(DVIDMeshSource, {
        parameters: {
          'baseUrl': parameters.baseUrl,
          'nodeKey': parameters.nodeKey,
          'dataInstanceKey': this.meshSrc,
        }
      });
    } else {
      return null;
    }
  }

  getSkeletonSource(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    if (this.skeletonSrc !== '') {
      return chunkManager.getChunkSource(DVIDSkeletonSource, {
        parameters: {
          'baseUrl': parameters.baseUrl,
          'nodeKey': parameters.nodeKey,
          'dataInstanceKey': this.skeletonSrc,
        }
      });
    } else {
      return null;
    }
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

export function getServerInfo(chunkManager: ChunkManager, baseUrl: string) {
  return chunkManager.memoize.getUncounted({type: 'dvid:getServerInfo', baseUrl}, () => {
    const result = fetchOk(`${baseUrl}/api/repos/info`)
                       .then(response => response.json())
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

/**
 * Get extra dataInstance info that isn't available on the server level.
 * this requires an extra api call
 */
export function getDataInstanceDetails(
    chunkManager: ChunkManager, baseUrl: string, nodeKey: string, info: VolumeDataInstanceInfo) {
  return chunkManager.memoize.getUncounted(
      {type: 'dvid:getInstanceDetails', baseUrl, nodeKey, name: info.name}, () => {
        let result = fetchOk(`${baseUrl}/api/node/${nodeKey}/${info.name}/info`)
                         .then(response => response.json());
        const description = `datainstance info for node ${nodeKey} and instance ${info.name} ` +
            `on DVID server ${baseUrl}`;

        StatusMessage.forPromise(result, {
          initialMessage: `Retrieving ${description}.`,
          delay: true,
          errorPrefix: `Error retrieving ${description}: `,
        });

        return result.then(instanceDetails => {
          let extended = verifyObjectProperty(instanceDetails, 'Extended', verifyObject);
          info.lowerVoxelBound =
              verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
          info.upperVoxelBound =
              verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
          return info;
        });
      });
}


export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
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
      public chunkManager: ChunkManager, public baseUrl: string, public nodeKey: string,
      public dataInstanceKey: string, public info: VolumeDataInstanceInfo) {}

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
        this.chunkManager, {
          'baseUrl': this.baseUrl,
          'nodeKey': this.nodeKey,
          'dataInstanceKey': this.dataInstanceKey,
        },
        volumeSourceOptions);
  }

  getMeshSource() {
    let meshSource = this.info.getMeshSource(this.chunkManager, {
      'baseUrl': this.baseUrl,
      'nodeKey': this.nodeKey,
      'dataInstanceKey': this.dataInstanceKey,
    });
    if (meshSource === null) {
      return this.info.getSkeletonSource(this.chunkManager, {
        'baseUrl': this.baseUrl,
        'nodeKey': this.nodeKey,
        'dataInstanceKey': this.dataInstanceKey,
      });
    }
    return meshSource;
  }
}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getVolume(chunkManager: ChunkManager, url: string) {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }
  const baseUrl = match[1];
  const nodeKey = match[2];
  const dataInstanceKey = match[3];
  return getServerInfo(chunkManager, baseUrl)
      .then(serverInfo => {
        let repositoryInfo = serverInfo.getNode(nodeKey);
        if (repositoryInfo === undefined) {
          throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
        }
        const dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);
        if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
          throw new Error(`Invalid data instance ${dataInstanceKey}.`);
        }
        return getDataInstanceDetails(chunkManager, baseUrl, nodeKey, dataInstanceInfo);
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
                chunkManager, baseUrl, nodeKey, dataInstanceKey, info));
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
    url: string, chunkManager: ChunkManager): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let baseUrl = match[1];
  let path = match[2];
  return getServerInfo(chunkManager, baseUrl)
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
    return annotationChunkDataSize;
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
    if (isNonEmptyString(parameters.user)) {
      return [makeSpec(multiscaleInfo.scales[0])];
    } else {
      throw("Expecting a valid user");
    }
  } else {
    return multiscaleInfo.scales.map(scale => makeSpec(scale));
  }
}

const MultiscaleAnnotationSourceBase = (WithParameters(MultiscaleAnnotationSource, AnnotationSourceParameters));

export class DVIDAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  private updateAnnotationHandlers() {
    updateRenderHelper();
    updateAnnotationTypeHandler();
  }

  constructor(chunkManager: ChunkManager, options: {
    parameters: AnnotationSourceParameters,
    multiscaleVolumeInfo: MultiscaleVolumeInfo
  }) {
    super(chunkManager, <any>{
      sourceSpecifications:
          makeAnnotationGeometrySourceSpecifications(options.multiscaleVolumeInfo, options.parameters),
      ...options
    });

    mat4.fromScaling(this.objectToLocal, options.multiscaleVolumeInfo.scales[0].voxelSize);
    this.updateAnnotationHandlers();
    this.childAdded = this.childAdded || new Signal<(annotation: Annotation) => void>();
    this.childUpdated = this.childUpdated || new Signal<(annotation: Annotation) => void>();
    this.childDeleted = this.childDeleted || new Signal<(annotationId: string) => void>();

    if (this.parameters.readonly !== undefined) {
      this.readonly = this.parameters.readonly;
    }
  
    if (!isNonEmptyString(this.parameters.user) || !this.parameters.usertag) {
      this.readonly = true;
    }
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    if (annotation.type === AnnotationType.POINT) {
      if (this.readonly) {
        let errorMessage = 'Permission denied for changing annotations.';
        StatusMessage.showTemporaryMessage(errorMessage);
        throw Error(errorMessage);
      }

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

function parseAnnotationKey(key: string): Promise<AnnotationSourceParameters> {
  const match = key.match(/^([^\/]+:\/\/[^\/]+)\/([^\/]+)\/([^\/\?]+)(\?.*)?$/);

  if (match === null) {
    throw new Error(`Invalid DVID volume key: ${JSON.stringify(key)}.`);
  }

  let queryString = match[4];
  let sourceParameters: AnnotationSourceParameters = {
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
    usertag: false
  };

  if (queryString && queryString.length > 1) {
    const parameters = parseQueryStringParameters(queryString.substring(1));
    if (parameters) {
      if (parameters.usertag) {
        sourceParameters.usertag = (parameters.usertag === 'true');
      }
      
      if (parameters.token) {
        sourceParameters.token = parameters.token;
        const tokenUser = getUserFromToken(parameters.token);
        if (parameters.user && parameters.user !== tokenUser) {
          parameters.user = undefined;
        } else {
          parameters.user = tokenUser;
        }
      }
      sourceParameters.user = isNonEmptyString(parameters.user) ? parameters.user : (sourceParameters.usertag ? Env.getUser() : '');
    }
  }

  return Promise.resolve(sourceParameters);
}

async function getSyncedLabel(parameters: AnnotationSourceParameters): Promise<string> {
  let dataUrl = `${parameters.baseUrl}/api/node/${parameters.nodeKey}/${parameters.dataInstanceKey}`;
  return fetchOk(`${dataUrl}/info`)
    .then(response => response.json())
    .then(response => response['Base'])
    .then(response => {
      if (response['TypeName'] !== 'annotation') {
        throw new Error(`Invalid DVID annotation url: ${dataUrl}`);
      }

      let syncs: Array<string> = response['Syncs'];
      if (syncs === undefined || syncs === null || syncs.length !== 1) {
        throw new Error(`Unexpected label syncs: ${syncs}`);
      }

      return syncs[0];
    });
}

export class DVIDDataSource extends DataSource {
  dvidAnnotationSourceKey: Promise<any>;
  constructor() {
    super();
  }

  get description() {
    return 'DVID';
  }

  getVolume(chunkManager: ChunkManager, url: string) {
    return getVolume(chunkManager, url);
  }

  volumeCompleter(url: string, chunkManager: ChunkManager) {
    return volumeCompleter(url, chunkManager);
  }

  getMultiscaleInfo(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    let volumeId: string = parameters.dataInstanceKey;
    let instance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return chunkManager.memoize.getUncounted(
        {
          type: 'dvid:getMultiscaleInfo',
          volumeId,
          instance
        },
        () => makeRequest(instance, {
                method: 'GET',
                path: `/${volumeId}/info`,
                responseType: 'json'
              }).then(response => new MultiscaleVolumeInfo(response)));
  }

  getAnnotationSourceFromSourceKey(chunkManager: ChunkManager, sourceKey: any) {
    return chunkManager.memoize.getUncounted(
      sourceKey,
      () => Promise.resolve(sourceKey['parameters']).then(parameters => {
        return getSyncedLabel(parameters)
          .then(label => this.getMultiscaleInfo(chunkManager, { 'baseUrl': parameters.baseUrl, 'nodeKey': parameters.nodeKey, 'dataInstanceKey': label }))
          .then(multiscaleVolumeInfo => chunkManager.getChunkSource(DVIDAnnotationSource, {
            parameters,
            multiscaleVolumeInfo
          }));
      }));
  }

  getAnnotationSource(chunkManager: ChunkManager, key: string) {
    this.dvidAnnotationSourceKey = parseAnnotationKey(key).then(
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
