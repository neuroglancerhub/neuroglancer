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
import {AnnotationSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, annotationChunkDataSize} from 'neuroglancer/datasource/dvid/base';
import {assignMeshFragmentData, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSwcSkeletonChunk} from 'neuroglancer/skeleton/decode_swc_skeleton';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {cancellableFetchOk, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject, SharedObject, RPC} from 'neuroglancer/worker_rpc';
import {vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {DVIDInstance, makeRequest} from 'neuroglancer/datasource/dvid/api';
import {DVIDPointAnnotation, updateAnnotationTypeHandler} from 'neuroglancer/datasource/dvid/utils';
import {Annotation, AnnotationId, AnnotationSerializer, AnnotationType, Point} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk} from 'neuroglancer/annotation/backend';
import {verifyObject, verifyObjectProperty, verifyOptionalString, parseIntVec, verifyString} from 'neuroglancer/util/json';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';

@registerSharedObject() export class DVIDSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let bodyid = `${chunk.objectId}`;
    const url = `${parameters.baseUrl}/api/node/${parameters['nodeKey']}` +
        `/${parameters['dataInstanceKey']}/key/` + bodyid + '_swc';
    return cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken)
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
(WithParameters(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk) {
    // DVID does not currently store meshes chunked, the main
    // use-case is for low-resolution 3D views.
    // for now, fragmentId is the body id
    chunk.fragmentIds = [`${chunk.objectId}`];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const url = `${parameters.baseUrl}/api/node/${parameters['nodeKey']}/${
        parameters['dataInstanceKey']}/key/${chunk.fragmentId}.ngmesh`;
    return cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}

@registerSharedObject() export class DVIDVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
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
    }
    const decoder = this.getDecoder(params);
    const response = await cancellableFetchOk(
        `${params.baseUrl}${path}`, {}, responseArrayBuffer, cancellationToken);
    await decoder(
        chunk, cancellationToken,
        (params.encoding === VolumeChunkEncoding.JPEG) ? response.slice(16) : response);
  }
  getPath(chunkPosition: Float32Array, chunkDataSize: Float32Array) {
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

function DVIDSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
  Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(Base, parametersConstructor);
}

export function parseUint64ToArray(out: Uint64[], v: string): Uint64[] {
  if (v) {
    out.push(Uint64.parseString(v));
  }

  return out;
}

function parseAnnotation(entry: any): DVIDPointAnnotation|null {
  if (entry) {
    const kind = verifyObjectProperty(entry, 'Kind', verifyString);
    if (kind !== 'Unknown') {
      const properties = verifyObjectProperty(entry, 'Prop', verifyObject);
      const corner = verifyObjectProperty(entry, 'Pos', x => parseIntVec(vec3.create(), x));
      let description: string | undefined;
      let segments: Array<Uint64> = new Array<Uint64>();

      if (kind === 'Note') {
        let isCustom = false;
        if (properties.custom) {
          isCustom = (properties.custom === '1');
        }
        if (isCustom) {
          description = verifyObjectProperty(properties, 'comment', verifyOptionalString);
          segments = verifyObjectProperty(properties, 'body ID', x => parseUint64ToArray(Array<Uint64>(), x));
        }
      } else if (kind === 'PreSyn' || kind === 'PostSyn') {
        description = verifyObjectProperty(properties, 'annotation', verifyOptionalString);
      }

      return {
        type: AnnotationType.POINT,
        id: `${corner[0]}_${corner[1]}_${corner[2]}`,
        point: corner,
        description,
        segments,
        kind,
        properties
      };
    }
  }

  return null;
}

function parseAnnotations(
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any[]) {
  const serializer = new AnnotationSerializer();
  if (responses) {
    responses.forEach((response) => {
      if (response) {
        try {
          let annotation = parseAnnotation(response);
          if (annotation) {
            serializer.add(annotation);
          }
        } catch (e) {
          throw new Error(`Error parsing annotation: ${e.message}`);
        }
      }
    });
  }
  chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
}

function annotationToDVID(annotation: DVIDPointAnnotation, user: string|undefined): any {
  const payload = annotation.description || '';
  const objectLabels =
      annotation.segments === undefined ? undefined : annotation.segments.map(x => x.toString());
  switch (annotation.type) {
    case AnnotationType.POINT: {
      let obj: {[key: string]: any} = {
        Kind: 'Note',
        Pos: [annotation.point[0], annotation.point[1], annotation.point[2]],
        Prop: {
          comment: payload
        }
      };
      if (annotation.properties) {
        if (annotation.properties.custom) {
          obj['Prop']['custom'] = annotation.properties.custom;
        }
        if (annotation.properties.type) {
          obj['Prop']['type'] = annotation.properties.type;
        }
      }
      if (objectLabels && objectLabels.length > 0) {
        obj['Prop']['body ID'] = objectLabels[0];
      }
      if (user) {
        obj['Tags'] = ['user:' + user];
        obj['Prop']['user'] = user;
      }
      return obj;
    }
  }
}

@registerSharedObject() export class DVIDAnnotationSource extends (DVIDSource(AnnotationSource, AnnotationSourceParameters)) {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    updateAnnotationTypeHandler();
  }

  private getElementsPath() {
    return `/${this.parameters.dataInstanceKey}/elements`;
  }

  private getPath(position: ArrayLike<number>, size: ArrayLike<number>) {
    return `${this.getElementsPath()}/${size[0]}_${size[1]}_${size[2]}/${position[0]}_${position[1]}_${position[2]}`;
  }

  private getPathByUserTag(user: string) {
    return `/${this.parameters.dataInstanceKey}/tag/user:${user}`;
  }

  private getPathByBodyId(bodyId: Uint64) {
    return `/${this.parameters.dataInstanceKey}/label/${bodyId}`;
  }

  private getPathByAnnotationId(annotationId: string) {
    return `${this.getElementsPath()}/1_1_1/${annotationId}`;
  }

  downloadGeometry(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;

    if (parameters.user) {
      return makeRequest(
        new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
          method: 'GET',
          path: this.getPathByUserTag(parameters.user),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken)
        .then(values => {
          parseAnnotations(chunk, values);
        });
    } else {
      // console.log('Annotaition chunk position', chunk.chunkGridPosition);
      if (chunk.source.spec.upperChunkBound[0] <= chunk.source.spec.lowerChunkBound[0]) {
        return Promise.resolve(parseAnnotations(chunk, []));
      }
      // console.log('downloadGeometry:', parameters);
      const chunkDataSize = annotationChunkDataSize;
      const chunkPosition = vec3.multiply(vec3.create(), chunk.chunkGridPosition, chunkDataSize);
      return makeRequest(
        new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
        method: 'GET',
        path: this.getPath(chunkPosition, chunkDataSize),
        payload: undefined,
        responseType: 'json',
      },
        cancellationToken)
        .then(values => {
          parseAnnotations(chunk, values);
        });
    }
  }

  downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;

    return makeRequest(
      new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
        method: 'GET',
        path: this.getPathByBodyId(chunk.objectId),
        payload: undefined,
        responseType: 'json',
      },
      cancellationToken)
      .then(values => {
        parseAnnotations(chunk, values);
      });
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    const id = chunk.key!;
    return makeRequest(
      new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
        method: 'GET',
        path: this.getPathByAnnotationId(id),
        payload: undefined,
        responseType: 'json',
      },
      cancellationToken)
      .then(response => {
        if (response.length > 0) {
          chunk.annotation = parseAnnotation(response[0]);
        } else {
          chunk.annotation = null;
        }
      },
        () => {
          chunk.annotation = null;
        });
  }

  private uploadable(annotation: Annotation): annotation is Point {
    const { parameters } = this;

    if (parameters.user && parameters.user !== '') {
      return annotation.type === AnnotationType.POINT;
    }

    return false;
  }

  add(annotation: Annotation) {
    const { parameters } = this;

    const dvidAnnotation = annotationToDVID(<DVIDPointAnnotation>annotation, parameters.user);

    if (this.uploadable(annotation)) {
      return makeRequest(
        new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
        method: 'POST',
        path: this.getElementsPath(),
        payload: JSON.stringify([dvidAnnotation]),
        responseType: '',
      })
        .then(() => {
          return `${annotation.point[0]}_${annotation.point[1]}_${annotation.point[2]}`;
        });
    } else {
      console.log(`${annotation.type}_${JSON.stringify(annotation)}`);
      return Promise.resolve(`${annotation.type}_${JSON.stringify(annotation)}`);
    }
  }

  update(_: AnnotationId, annotation: Annotation) {
    if (this.uploadable(annotation)) {
      const { parameters } = this;
      const dvidAnnotation = annotationToDVID(<DVIDPointAnnotation>annotation, parameters.user);
      return makeRequest(
        new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
        method: 'POST',
        path: this.getElementsPath(),
        payload: JSON.stringify([dvidAnnotation]),
        responseType: '',
      });
    } else {
      return Promise.resolve(`${annotation.type}_${JSON.stringify(annotation)}`);
    }
  }

  delete (id: AnnotationId) {
    const {parameters} = this;
    return makeRequest(
      new DVIDInstance(parameters.baseUrl, parameters.nodeKey), {
             method: 'DELETE',
             path: `/${parameters.dataInstanceKey}/element/${id}`,
             payload: undefined,
             responseType: '',
           });
  }
}
