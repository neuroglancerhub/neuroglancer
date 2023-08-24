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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, AnnotationSourceParameters, AnnotationChunkSourceParameters} from 'neuroglancer/datasource/dvid/base';
import {assignMeshFragmentData, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSwcSkeletonChunk} from 'neuroglancer/skeleton/decode_swc_skeleton';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {registerSharedObject, SharedObject, RPC} from 'neuroglancer/worker_rpc';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {DVIDInstance, DVIDToken, makeRequestWithCredentials, appendQueryStringForDvid, fetchMeshDataFromService, appendQueryString} from 'neuroglancer/datasource/dvid/api';
import {DVIDPointAnnotation, DVIDAnnotation, DVIDAnnotationFacade} from 'neuroglancer/datasource/dvid/utils';
import {verifyObject, verifyObjectProperty, verifyString, parseIntVec} from 'neuroglancer/util/json';
import {vec3} from 'neuroglancer/util/geom';
import {AnnotationId, AnnotationSerializer, makeAnnotationPropertySerializers, AnnotationType, AnnotationPropertySpec} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk, AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {Uint64} from 'neuroglancer/util/uint64';

function DVIDSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
  Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<DVIDToken>()(Base), parametersConstructor);
}

@registerSharedObject() export class DVIDSkeletonSource extends
(DVIDSource(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    if (parameters.supervoxels) {
      return Promise.reject();
    }

    let bodyid = `${chunk.objectId}`;
    const url = `${parameters.baseUrl}/api/node/${parameters['nodeKey']}` +
        `/${parameters['dataInstanceKey']}/key/` + bodyid + '_swc';
    return makeRequestWithCredentials(this.credentialsProvider, {
          method: 'GET',
          url: appendQueryStringForDvid(url, parameters.user),
          responseType: 'arraybuffer'
        }, cancellationToken)
        .then(response => {
          let enc = new TextDecoder('utf-8');
          decodeSwcSkeletonChunk(chunk, enc.decode(response));
        });
  }
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

@registerSharedObject() export class DVIDMeshSource extends
(DVIDSource(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk) {
    // Note: The conditional supervoxels parameter check was removed to allow
    // the small-mesh service to load meshes. Code in the downloadFragment
    // method was altered to force the use of the small mesh service if the
    // supervoxels parameter is true.

    // DVID does not currently store meshes chunked, the main
    // use-case is for low-resolution 3D views.
    // for now, fragmentId is the body id
    chunk.fragmentIds = [`${chunk.objectId}`];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const { fragmentId } = chunk;
    if (fragmentId) {
      const {parameters} = this;
      const dvidInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      const meshUrl = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, `${fragmentId}.ngmesh`);

      const { forceDvidService, supervoxels } = parameters;
      // DVID should never load meshes for supervoxels, so if that parameter is
      // true, then we should always use the small mesh service.
      if (forceDvidService || supervoxels ) {
        return fetchMeshDataFromService(parameters, fragmentId, cancellationToken
        ).then(
          response => decodeFragmentChunk(chunk, response)
        ).catch(error => {
          console.log(error);
        });
      }

      return makeRequestWithCredentials(this.credentialsProvider, {
        method: 'GET',
        url: appendQueryStringForDvid(meshUrl, parameters.user),
        responseType: 'arraybuffer'
      }, cancellationToken).catch(
        () => fetchMeshDataFromService(parameters, fragmentId, cancellationToken)
      ).then(
        response => decodeFragmentChunk(chunk, response)
      ).catch(error => {
        console.log(error);
      });
    }

    throw new Error('Invalid mesh fragment ID.');

  }
}

function parseUint64ToArray(out: Uint64[], v: string): Uint64[] {
  if (v) {
    out.push(Uint64.parseString(v));
  }

  return out;
}

function parsePointAnnotation(entry: any, kind: string): DVIDPointAnnotation
{
  let prop: { [key: string]: string } = {};

  const propertiesObj = verifyObjectProperty(entry, 'Prop', verifyObject);
  const corner = verifyObjectProperty(entry, 'Pos', x => parseIntVec(vec3.create(), x));
  // let segments: Array<Uint64> = new Array<Uint64>();
  let relatedSegments: Uint64[][] = [[]];

  prop = propertiesObj;
  if (kind === 'Note') {
    relatedSegments[0] = verifyObjectProperty(propertiesObj, 'body ID', x => parseUint64ToArray(Array<Uint64>(), x));
  }

  let annotation: DVIDPointAnnotation = {
    point: corner,
    type: AnnotationType.POINT,
    properties: [],
    kind,
    id: `${corner[0]}_${corner[1]}_${corner[2]}`,
    relatedSegments,
    prop: {}
  };

  let annotationRef = new DVIDAnnotationFacade(annotation);
  annotationRef.prop = prop;
  annotationRef.update();

  let description = annotationRef.description;
  if (description) {
    annotation.description = description;
  }
  return annotation;
}

export function parseAnnotation(entry: any): DVIDAnnotation|null {
  if (entry) {
    const kind = verifyObjectProperty(entry, 'Kind', verifyString);
    if (kind !== 'Unknown') {
      return parsePointAnnotation(entry, kind);
    }
  }

  return null;
}

@registerSharedObject() //
export class DVIDAnnotationGeometryChunkSource extends (DVIDSource(AnnotationGeometryChunkSourceBackend, AnnotationChunkSourceParameters)) {
  // private getElementsPath() {
  //   return `/${this.parameters.dataInstanceKey}/elements`;
  // }

  // Use block API for better performance
  private getBlocksPath() {
    return `/${this.parameters.dataInstanceKey}/blocks`;
  }

  private getPath(position: ArrayLike<number>, size: ArrayLike<number>) {
    return `${this.getBlocksPath()}/${size[0]}_${size[1]}_${size[2]}/${position[0]}_${position[1]}_${position[2]}`;
  }

  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    if (chunk.source.spec.upperChunkBound[0] <= chunk.source.spec.lowerChunkBound[0]) {
      return Promise.resolve(parseAnnotations(this, chunk, [], parameters.properties, true));
    }
    const chunkDataSize = this.parameters.chunkDataSize;
    const chunkPosition = chunk.chunkGridPosition.map((x, index) => x * chunkDataSize[index]);
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(this.getPath(chunkPosition, chunkDataSize)), parameters.user),
        payload: undefined,
        responseType: 'json',
      },
      cancellationToken)
      .then(values => {
        parseAnnotations(this, chunk, values, parameters.properties, false);
      });
  }
}

@registerSharedObject() export class DVIDAnnotationSource extends (DVIDSource(AnnotationSource, AnnotationSourceParameters)) {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // updateAnnotationTypeHandler();
  }

  private getElementsPath() {
    return `/${this.parameters.dataInstanceKey}/elements`;
  }

  private getPathByBodyId(segmentation: string, bodyId: Uint64) {
    return `/${segmentation}/label/${bodyId}`;
  }

  private getPathByAnnotationId(annotationId: string) {
    return `${this.getElementsPath()}/1_1_1/${annotationId}`;
  }

  downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk, _relationshipIndex: number, cancellationToken: CancellationToken) {
    const { parameters } = this;
    if (parameters.syncedLabel) {
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(this.getPathByBodyId(parameters.dataInstanceKey, chunk.objectId)), parameters.user),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken)
        .then(values => {
          parseAnnotations(this, chunk, values, parameters.properties, false);
        });
    } else {
      throw Error('Synced label missing');
    }
  }

  private requestPointMetaData(id: AnnotationId, cancellationToken: CancellationToken) {
    const { parameters } = this;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(this.getPathByAnnotationId(id)), parameters.user),
        responseType: 'json',
      },
      cancellationToken).then(
        response => {
          if (response && response.length > 0) {
            return response[0];
          } else {
            return response;
          }
        }
      );
  }

  private requestMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const id = chunk.key!;
    return this.requestPointMetaData(id, cancellationToken);
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    return this.requestMetadata(chunk, cancellationToken).then(
      (response: any) => {
        if (response) {
          chunk.annotation = parseAnnotation(response);
        } else {
          chunk.annotation = null;
        }
      }
    )
  }
}


function parseAnnotations(
  source: DVIDAnnotationSource|DVIDAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any[] | {[key: string]: any[]},
  propSpec: AnnotationPropertySpec[], emittingAddSignal: boolean) {

  const annotationPropertySerializers = makeAnnotationPropertySerializers(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializers);
  if (responses) {
    let itemList = [];
    if (!Array.isArray(responses)) {
      itemList = Object.keys(responses).reduce((acc, key) => [...acc, ...responses[key]], []);
    } else {
      itemList = responses;
    }

    itemList.forEach((response) => {
      if (response) {
        try {
          let annotation = parseAnnotation(response);
          if (annotation) {
            serializer.add(annotation);
            if (emittingAddSignal) {
              console.log('To be implemented: ', source, emittingAddSignal)
            }
          }
        } catch (e) {
          throw new Error(`Error parsing annotation: ${e.message}`);
        }
      }
    });
  }
  chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
}


@registerSharedObject() export class DVIDVolumeChunkSource extends
(DVIDSource(VolumeChunkSource, VolumeChunkSourceParameters)) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let params = this.parameters;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;

      // if the volume is an image, get a jpeg
      path = this.getPath(chunkPosition, chunkDataSize);
      if (params.supervoxels) {
        path = appendQueryString(path, 'supervoxels', 'true');
      }
    }
    const decoder = this.getDecoder(params);
    const response = await makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: appendQueryStringForDvid(`${params.baseUrl}${path}`, params.user),
          responseType: 'arraybuffer'
        }, cancellationToken);
    await decoder(
        chunk, cancellationToken,
        (params.encoding === VolumeChunkEncoding.JPEG) ? response.slice(16) : response);
  }
  getPath(chunkPosition: Float32Array, chunkDataSize: Uint32Array) {
    let params = this.parameters;
    if (params.encoding === VolumeChunkEncoding.JPEG) {
      return `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/subvolblocks/` +
          `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
          `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}`;
    } else if (params.encoding === VolumeChunkEncoding.RAW) {
      return `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/raw/0_1_2/` +
          `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
          `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}/jpeg`;
    } else if (params.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      return `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/raw/0_1_2/` +
          `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
          `${chunkPosition[0]}_${chunkPosition[1]}_${
                 chunkPosition[2]}?compression=googlegzip&scale=${params['dataScale']}`;
    } else {
      // encoding is COMPRESSED_SEGMENTATION
      return `/api/node/${params['nodeKey']}/${params['dataInstanceKey']}/raw/0_1_2/` +
          `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
          `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip`;
    }
  }
  getDecoder(params: any) {
    if ((params.encoding === VolumeChunkEncoding.JPEG) ||
        (params.encoding === VolumeChunkEncoding.RAW)) {
      return decodeJpegChunk;
    } else {
      // encoding is COMPRESSED_SEGMENTATION
      return decodeCompressedSegmentationChunk;
    }
  }
}
