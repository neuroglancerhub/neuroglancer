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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DVIDSourceParameters, SkeletonSourceParameters, TileChunkSourceParameters, TileEncoding, VolumeChunkSourceParameters, StackParameters} from 'neuroglancer/datasource/dvid/base';
import {CompletionResult, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {parameterizedSkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeChunkSpecification, VolumeType} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource, defineParameterizedVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {Vec3, vec3, vec4, vec3Key} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, stableStringify, verifyFinitePositiveFloat, verifyInt, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {CancellablePromise} from 'neuroglancer/util/promise';
import {defineParameterizedStackChunkSource, StackChunkSource} from 'neuroglancer/stack/frontend';
import {chain, map, min, max, each, sortBy} from 'lodash';
var chroma: any = require('chroma-js');  // needs to be imported this way due to export style differences

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string { return this.obj['TypeName']; }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'TypeName', verifyString);
  }
};

export class DataInstanceInfo {
  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
};

const DVIDVolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeChunkSourceParameters);
const SkeletonSource = parameterizedSkeletonSource(SkeletonSourceParameters);

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;
  voxelSize: Vec3;
  numChannels: number;
  numLevels: number;
  constructor(
      obj: any, name: string, base: DataInstanceBaseInfo, public volumeType: VolumeType,
      instanceNames: Array<string>) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    let extendedValues = verifyObjectProperty(extended, 'Values', x => parseArray(x, verifyObject));
    if (extendedValues.length < 1) {
      throw new Error(
          'Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.');
    }
    this.numLevels = 1;

    // dvid does not have explicit datatype support for multiscale but
    // by convention different levels are specified with unique
    // instances where levels are distinguished by the suffix '_LEVELNUM'
    let instSet = new Set<string>(instanceNames);
    while (instSet.has(name + '_' + this.numLevels.toString())) {
      this.numLevels += 1;
    }

    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.lowerVoxelBound =
        verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
    this.upperVoxelBound =
        verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.numChannels = 1;
  }

  getSources(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    let sources: VolumeChunkSource[][] = [];
    for (let level = 0; level < this.numLevels; ++level) {
      let voxelSize = vec3.scale(vec3.create(), this.voxelSize, Math.pow(2, level));
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        lowerVoxelBound[i] =
            Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        upperVoxelBound[i] =
            Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
      }
      let dataInstanceKey = parameters.dataInstanceKey;
      if (level > 0) {
        dataInstanceKey += '_' + level.toString();
      }

      let volParameters: VolumeChunkSourceParameters = {
        'baseUrls': parameters.baseUrls,
        'nodeKey': parameters.nodeKey,
        'dataInstanceKey': dataInstanceKey,
        'volumeType': this.volumeType,
      };
      let alternatives =
          VolumeChunkSpecification
              .getDefaults({
                voxelSize: voxelSize,
                dataType: this.dataType,
                numChannels: this.numChannels,
                chunkLayoutOffset: vec3.multiply(vec3.create(), lowerVoxelBound, voxelSize),
                baseVoxelOffset: lowerVoxelBound,
                upperVoxelBound: vec3.subtract(vec3.create(), upperVoxelBound, lowerVoxelBound),
                volumeType: this.volumeType,
              })
              .map(
                  spec => { return DVIDVolumeChunkSource.get(chunkManager, spec, volParameters); });
      sources.push(alternatives);
    }
    return sources;
  }
};

export class TileLevelInfo {
  /**
   * Resolution of the two downsampled dimensions in the tile plane.  The tile depth is equal to the
   * base voxel size in that dimension.
   */
  resolution: Vec3;
  tileSize: Vec3;

  constructor(obj: any) {
    verifyObject(obj);
    this.resolution = verifyObjectProperty(
        obj, 'Resolution', x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.tileSize = verifyObjectProperty(
        obj, 'TileSize', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
  }
};

/**
 * Dimensions for which tiles are computed.
 *
 * DVID does not indicate which dimensions are available but it
 * provides blank tiles if the dimension asked for is not there.
 */
const TILE_DIMS = [
  [0, 1],
  [0, 2],
  [1, 2],
];

const TileChunkSource = defineParameterizedVolumeChunkSource(TileChunkSourceParameters);

export class TileDataInstanceInfo extends DataInstanceInfo {
  get dataType() { return DataType.UINT8; }
  get volumeType() { return VolumeType.IMAGE; }
  get numChannels() { return 1; }

  encoding: TileEncoding;

  /**
   * Base voxel size (nm).
   */
  voxelSize: Vec3;

  levels: Map<string, TileLevelInfo>;

  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;

  constructor(obj: any, name: string, base: DataInstanceBaseInfo) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    this.levels = verifyObjectProperty(
        extended, 'Levels', x => verifyObjectAsMap(x, y => new TileLevelInfo(y)));
    let baseLevel = this.levels.get('0');
    if (baseLevel === undefined) {
      throw new Error(`Level 0 is not defined.`);
    }
    this.voxelSize = baseLevel.resolution;
    let minTileCoord = verifyObjectProperty(
        extended, 'MinTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    let maxTileCoord = verifyObjectProperty(
        extended, 'MaxTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    this.lowerVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, minTileCoord);
    this.upperVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, maxTileCoord);

    let encodingNumber = verifyObjectProperty(extended, 'Encoding', x => x);
    switch (encodingNumber) {
      case 2:
        this.encoding = TileEncoding.JPEG;
        break;
      default:
        throw new Error(`Unsupported tile encoding: ${JSON.stringify(encodingNumber)}.`);
    }
  }

  getSources(chunkManager: ChunkManager, parameters: DVIDSourceParameters) {
    let sources: VolumeChunkSource[][] = [];
    let {numChannels, dataType, encoding} = this;
    for (let [level, levelInfo] of this.levels) {
      let alternatives = TILE_DIMS.map(dims => {
        let voxelSize = vec3.clone(this.voxelSize);
        let chunkDataSize = vec3.fromValues(1, 1, 1);
        // tiles are always NxMx1
        for (let i = 0; i < 2; ++i) {
          voxelSize[dims[i]] = levelInfo.resolution[dims[i]];
          chunkDataSize[dims[i]] = levelInfo.tileSize[dims[i]];
        }
        let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();
        for (let i = 0; i < 3; ++i) {
          lowerVoxelBound[i] =
              Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
          upperVoxelBound[i] =
              Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        }
        let spec = new VolumeChunkSpecification({
          voxelSize,
          chunkDataSize,
          numChannels: numChannels,
          dataType: dataType, lowerVoxelBound, upperVoxelBound
        });
        return TileChunkSource.get(chunkManager, spec, {
          'baseUrls': parameters.baseUrls,
          'nodeKey': parameters.nodeKey,
          'dataInstanceKey': parameters.dataInstanceKey,
          'encoding': encoding,
          'level': level,
          'dims': `${dims[0]}_${dims[1]}`,
        });
      });
      sources.push(alternatives);
    }
    return sources;
  }
};

export function parseDataInstance(
    obj: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  switch (baseInfo.typeName) {
    case 'uint8blk':
    case 'grayscale8':
      return new VolumeDataInstanceInfo(obj, name, baseInfo, VolumeType.IMAGE, instanceNames);
    case 'imagetile':
      return new TileDataInstanceInfo(obj, name, baseInfo);
    case 'labels64':
    case 'labelblk':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeType.SEGMENTATION, instanceNames);
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
};

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
  constructor(obj: any) { this.repositories = parseRepositoriesInfo(obj); }

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
};

const cachedServerInfo = new Map<string, Promise<ServerInfo>>();
export function getServerInfo(baseUrls: string[]) {
  let cacheKey = stableStringify(baseUrls);
  let result = cachedServerInfo.get(cacheKey);
  if (result === undefined) {
    result = sendHttpRequest(openShardedHttpRequest(baseUrls, '/api/repos/info', 'GET'), 'json')
                 .then(response => new ServerInfo(response));
    const description = `repository info for DVID server ${baseUrls[0]}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    cachedServerInfo.set(cacheKey, result);
  }
  return result;
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType() { return this.info.dataType; }
  get numChannels() { return this.info.numChannels; }
  get volumeType() { return this.info.volumeType; }

  constructor(
      public baseUrls: string[], public nodeKey: string, public dataInstanceKey: string,
      public info: VolumeDataInstanceInfo|TileDataInstanceInfo) {}

  getSources(chunkManager: ChunkManager) {
    return this.info.getSources(chunkManager, {
      'baseUrls': this.baseUrls,
      'nodeKey': this.nodeKey,
      'dataInstanceKey': this.dataInstanceKey,
    });
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(chunkManager: ChunkManager): null { return null; }
};

let existingVolumes = new Map<string, MultiscaleVolumeChunkSource>();
export function getShardedVolume(baseUrls: string[], nodeKey: string, dataInstanceKey: string) {
  return getServerInfo(baseUrls).then(serverInfo => {
    let repositoryInfo = serverInfo.getNode(nodeKey);
    if (repositoryInfo === undefined) {
      throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
    }
    let dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);
    if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo) &&
        !(dataInstanceInfo instanceof TileDataInstanceInfo)) {
      throw new Error(`Invalid data instance ${dataInstanceKey}.`);
    }
    let cacheKey = stableStringify(
        {'baseUrls': baseUrls, 'nodeKey': repositoryInfo.uuid, 'dataInstanceKey': dataInstanceKey});
    let result = existingVolumes.get(cacheKey);
    if (result === undefined) {
      result = new MultiscaleVolumeChunkSource(
          baseUrls, repositoryInfo.uuid, dataInstanceKey, dataInstanceInfo);
      existingVolumes.set(cacheKey, result);
    }
    return result;
  });
}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getVolume(url: string) {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }
  return getShardedVolume([match[1]], match[2], match[3]);
}

export function completeInstanceName(
    repositoryInfo: RepositoryInfo, prefix: string): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
        prefix, repositoryInfo.dataInstances.values(), instance => instance.name,
        instance => { return `${instance.base.typeName}`; })
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
  let repository = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(nodeKey.length + 1, completeInstanceName(repository, match[2]));
}

export function volumeCompleter(url: string): CancellablePromise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let baseUrl = match[1];
  let baseUrls = [baseUrl];
  let path = match[2];
  return getServerInfo(baseUrls).then(
      serverInfo =>
          applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path)));
}

registerDataSourceFactory('dvid', {
  description: 'DVID',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
  getSkeletonSource: getSkeletonSourceByUrl,
  getStackSource: getStackSource
});

export function getSkeletonSource(
    chunkManager: ChunkManager, parameters: SkeletonSourceParameters) {
  return SkeletonSource.get(chunkManager, parameters);
}

// example: http://emdata1:7000/d5053e99753848e599a641925aa2d38f/bodies1104_skeletons/
const skeletonSourcePattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+_skeletons)$/;

function getSkeletonSourceParameters(url: string) {
  let match = url.match(skeletonSourcePattern);
  if (match === null) {
    throw new Error(`Invalid DVID skeleton URL: ${url}`);
  }
  let baseUrls = [match[1]];
  let nodeKey = match[2];
  let dataInstanceKey = match[3];
  return {baseUrls: baseUrls, nodeKey: nodeKey, dataInstanceKey: dataInstanceKey};
}

export function getSkeletonSourceByUrl(chunkManager: ChunkManager, url: string) {
  return getSkeletonSource(chunkManager, getSkeletonSourceParameters(url));
}

//Stacks
export function getStackSource(path: string, spec: any){
    return new Promise(function(resolve, reject){
        // set up source asynchronously
        window.setTimeout(
          function() {
            resolve(new MultiscaleStackChunkSource(spec));
          }, 0);
      });
}

const ParameterizedStackChunkSource = defineParameterizedStackChunkSource(StackParameters);

export class MultiscaleStackChunkSource implements GenericMultiscaleVolumeChunkSource {
  numChannels = 1;
  dataType = DataType.FLOAT32;
  volumeType = VolumeType.STACK;
  positions: Array<Float32Array>;
  colors: Map<string, Float32Array>;
  volumeSpec: VolumeChunkSpecification;
  chunkWidth: number;
  stackID: string;

  constructor(spec: any){
    //TODO: move some of these calculations to the backend thread
    let stacks = spec.stackData.substacks;
    let chunkSize = this.chunkWidth = parseInt(stacks[0].width);
    let dataScaler = spec.dataScaler;

    //only works for isovoxel chunks
    this.positions = map(stacks, function(stack){return [parseInt(stack.x), parseInt(stack.y), parseInt(stack.z)]});
    this.coatStack(this.positions);
    this.stackID = spec.source;
    //calculate colors--this could be done on the backend instead
    let minVal = chain(stacks).map('status').min().value();
    let maxVal = chain(stacks).map('status').max().value();
    let colorScale = chroma.scale(spec.stackData.colorInterpolate).domain([minVal, maxVal]);
    let colorMapContents = map(stacks, function(stack){
      let rgb = colorScale(stack.status).rgb();
      let color =  new Float32Array([rgb[0]/255.0, rgb[1]/255.0, rgb[2]/255.0, 1]);
      let posShift = chunkSize/2;
      return [vec3Key(vec3.fromValues(stack.x+posShift, stack.y+posShift, stack.z+posShift)), color]//shift point to LUB
    });
    this.colors = new Map(colorMapContents);
    //worth cutting down on loops by doing this all at once?
    let x = Math.floor((chain(stacks).map('x').min().value() - chunkSize)/chunkSize);
    let y = Math.floor((chain(stacks).map('y').min().value() - chunkSize)/chunkSize);
    let z = Math.floor((chain(stacks).map('z').min().value() - chunkSize)/chunkSize);
    let lowerVoxelBound = vec3.fromValues(x,y,z)

    let limit = map(spec.stackData.stackDimensions, function(coord){
      return Math.floor(coord/chunkSize);
    });
    let upperVoxelBound = vec3.fromValues(limit[0], limit[1], limit[2] - 1);

    let scaledWidth = chunkSize * dataScaler;
    let voxelSize = vec3.fromValues(scaledWidth, scaledWidth, scaledWidth);

    this.volumeSpec = new VolumeChunkSpecification({
      voxelSize,
      chunkDataSize: vec3.fromValues(1, 1, 1),//only represent one voxel per chunk
      numChannels: this.numChannels,
      dataType: this.dataType,
      lowerVoxelBound: lowerVoxelBound,
      upperVoxelBound: upperVoxelBound,
      dataScaler: dataScaler,
      stack: true,
    });

  }

  /**
   * Add a coating of subchunk positions with no corresponding colors
   * This gets around the neuroglancer limitation which allows chunks to bleed
   * outside of their lower, back, bottom bounderies if there is no abutting chunk
   */
  coatStack(positions: Array<any>){
    let {chunkWidth} = this;
    let zs = chain(positions).map(function(pos){return pos[2]}).uniq().value();
    let zMin = min(zs);
    
    let zMinMaxYmap = new Map(map(zs, function(z){
      return [z, [Infinity, -Infinity]];
    }))

    let zyMap = new Map();
    let coatPositions = [];

    each(positions, function(pos){
      //add 'end cap' coating on zMin
      if(pos[2] === zMin){
        coatPositions.push([pos[0], pos[1], pos[2] - chunkWidth]);//this seems right, chunks are just drawn over by later chunks
      }
      let key = pos[2] + ',' + pos[1]; //'z,y'
      let row = zyMap.get(key);
      if(!row){
        zyMap.set(key, [pos]);
      }
      else{
        row.push(pos)
      }
      //find min, max y for each z
      let currMinMaxY = zMinMaxYmap.get(pos[2]);
      zMinMaxYmap.set(pos[2], [ Math.min(currMinMaxY[0], pos[1] ), Math.max(currMinMaxY[1], pos[1] )]);
    });

    //add endcaps on each row in the x direction
    zyMap.forEach(function(posArray, key){
      let xMinPos = min(posArray, function(pos){return pos[0]});
      let xMaxPos = max(posArray, function(pos){return pos[0]});

      coatPositions.push([xMinPos[0] - chunkWidth, xMinPos[1], xMinPos[2]]);
      coatPositions.push([xMaxPos[0] + chunkWidth, xMaxPos[1], xMaxPos[2]]);
    });

    //add duplicate rows at ymin, ymax for each z slice
    let zyKey = '';
    zMinMaxYmap.forEach(function(minMaxY, z){
      //add min coat
      zyKey = z + ',' + minMaxY[0];
      let positionsToShadow = zyMap.get(zyKey);

      positionsToShadow.forEach(function(pos){
        coatPositions.push([pos[0], pos[1] - chunkWidth, pos[2]]);
      });

      //add max coat
      zyKey = z + ',' + minMaxY[1];
      positionsToShadow = zyMap.get(zyKey);

      positionsToShadow.forEach(function(pos){
        coatPositions.push([pos[0], pos[1] + chunkWidth, pos[2]]);
      });
    });

    //resort chunks so least x, y, z are drawn first
    this.positions = sortBy(coatPositions.concat(positions), [function(pos){return pos[2]}, function(pos){return pos[1]}, function(pos){return pos[0]}]);
  }

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources(chunkManager: ChunkManager){
    let sources: StackChunkSource[][] = [[ParameterizedStackChunkSource.get(chunkManager, this.volumeSpec, new StackParameters(this.positions, this.colors, this.stackID))]];
    return sources;
  }
  getMeshSource(chunkManager: ChunkManager){ return null };
}
