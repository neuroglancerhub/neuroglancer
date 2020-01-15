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
import {AnnotationSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, AnnotationChunkSourceParameters} from 'neuroglancer/datasource/dvid/base';
import {assignMeshFragmentData, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSwcSkeletonChunk} from 'neuroglancer/skeleton/decode_swc_skeleton';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
// import {cancellableFetchOk, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject, SharedObject, RPC} from 'neuroglancer/worker_rpc';
import {vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {DVIDInstance, DVIDToken, makeRequestWithCredentials} from 'neuroglancer/datasource/dvid/api';
import {DVIDPointAnnotation, getAnnotationDescription, DvidPointAnnotationProperty} from 'neuroglancer/datasource/dvid/utils';
import {Annotation, AnnotationId, AnnotationSerializer, AnnotationPropertySerializer, AnnotationType, Point, AnnotationPropertySpec} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk, AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {verifyObject, verifyObjectProperty, parseIntVec, verifyString} from 'neuroglancer/util/json';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID} from 'neuroglancer/annotation/base';

@registerSharedObject() export class DVIDSkeletonSource extends
(DVIDSource(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let bodyid = `${chunk.objectId}`;
    const url = `${parameters.baseUrl}/api/node/${parameters['nodeKey']}` +
        `/${parameters['dataInstanceKey']}/key/` + bodyid + '_swc';
    return makeRequestWithCredentials(this.credentialsProvider, {
      method: 'GET', url: url, responseType: 'arraybuffer'
    }, cancellationToken).then(response => {
      let enc = new TextDecoder('utf-8');
      decodeSwcSkeletonChunk(chunk, enc.decode(response));
    });
        /*
    return cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken)
        .then(response => {
          let enc = new TextDecoder('utf-8');
          decodeSwcSkeletonChunk(chunk, enc.decode(response));
        });
        */
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
    return makeRequestWithCredentials(this.credentialsProvider, {
          method: 'GET', url: url, responseType: 'arraybuffer'
        }, cancellationToken).then(response => decodeFragmentChunk(chunk, response));
        /*
    return cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
        */
  }
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
    }
    const decoder = this.getDecoder(params);
    const response = await makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: `${params.baseUrl}${path}`,
        responseType: 'arraybuffer'
      }, cancellationToken
    )
    /*
    const response = await cancellableFetchOk(
        `${params.baseUrl}${path}`, {}, responseArrayBuffer, cancellationToken);
        */
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

function DVIDSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
  Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<DVIDToken>()(Base), parametersConstructor);
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
      let prop = new DvidPointAnnotationProperty();

      const propertiesObj = verifyObjectProperty(entry, 'Prop', verifyObject);
      const corner = verifyObjectProperty(entry, 'Pos', x => parseIntVec(vec3.create(), x));
      // let segments: Array<Uint64> = new Array<Uint64>();
      let relatedSegments : Uint64[][] = [[]];

      if (kind === 'Note') {
        if (propertiesObj.type) {
          prop.type = DVIDToAnnotationType(propertiesObj.type);
        }
        relatedSegments[0] = verifyObjectProperty(propertiesObj, 'body ID', x => parseUint64ToArray(Array<Uint64>(), x));
      }

      let annotation: DVIDPointAnnotation = new DVIDPointAnnotation();
      annotation.kind = kind;
      annotation.id = `${corner[0]}_${corner[1]}_${corner[2]}`;
      annotation.relatedSegments = relatedSegments;
      annotation.point = corner;
      annotation.prop = prop;
      annotation.properties = [annotation.renderingAttribute];

      let description = getAnnotationDescription(annotation);
      if (description) {
        annotation.description = description;
      }
      return annotation;
    }
  }

  return null;
}

function annotationToDVIDType(typestr: string): string {
  switch (typestr) {
    case 'False Merge':
      return 'Split';
    case 'False Split':
      return 'Merge';
    default:
      return typestr;
  }
}

function DVIDToAnnotationType(typestr: string): string {
  switch (typestr) {
    case 'Split':
      return 'False Merge';
    case 'Merge':
      return 'False Split';
    default:
      return typestr;
  }
}

// const annotationPropertySerializer = new AnnotationPropertySerializer(3, []);

function parseAnnotations(
  source: DVIDAnnotationSource|DVIDAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any[],
  propSpec: AnnotationPropertySpec[]) {

  const annotationPropertySerializer = new AnnotationPropertySerializer(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializer);
  if (responses) {
    responses.forEach((response) => {
      if (response) {
        try {
          let annotation = parseAnnotation(response);
          if (annotation) {
            serializer.add(annotation);
            if (annotation.kind === 'Note') {
              source.rpc!.invoke(ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID, {
                id: source.rpcId,
                newAnnotation: {...annotation, description: getAnnotationDescription(annotation)}
              });
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

function annotationToDVID(annotation: DVIDPointAnnotation, user: string|undefined): any {
  const objectLabels =
    annotation.relatedSegments && annotation.relatedSegments[0] && annotation.relatedSegments[0].map(x => x.toString());

  let obj: { [key: string]: any } = {
    Kind: 'Note',
    Pos: [annotation.point[0], annotation.point[1], annotation.point[2]],
    Prop: {}
  };

  if (annotation.comment) {
    obj['Prop']['comment'] = annotation.comment;
  }
  if (annotation.custom) {
    obj['Prop']['custom'] = annotation.custom;
  }
  if (annotation.type) {
    obj['Prop']['type'] = annotationToDVIDType(annotation.type);
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


@registerSharedObject() //
export class DVIDAnnotationGeometryChunkSource extends (DVIDSource(AnnotationGeometryChunkSourceBackend, AnnotationChunkSourceParameters)) {
  private getPathByUserTag(user: string) {
    return `/${this.parameters.dataInstanceKey}/tag/user:${user}`;
  }

  private getElementsPath() {
    return `/${this.parameters.dataInstanceKey}/elements`;
  }

  private getPath(position: ArrayLike<number>, size: ArrayLike<number>) {
    return `${this.getElementsPath()}/${size[0]}_${size[1]}_${size[2]}/${position[0]}_${position[1]}_${position[2]}`;
  }

  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    if (parameters.usertag) {
      if (parameters.user) {
        let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey)
        return makeRequestWithCredentials(
          this.credentialsProvider,
          {
            method: 'GET',
            url: dataInstance.getNodeApiUrl(this.getPathByUserTag(parameters.user)),
            payload: undefined,
            responseType: 'json',
          },
          cancellationToken)
          .then(values => {
            parseAnnotations(this, chunk, values, parameters.properties);
          });
      } else {
        throw Error('Expecting a valid user name.')
      }
    } else {
      if (chunk.source.spec.upperChunkBound[0] <= chunk.source.spec.lowerChunkBound[0]) {
        return Promise.resolve(parseAnnotations(this, chunk, [], parameters.properties));
      }
      const chunkDataSize = this.parameters.chunkDataSize;
      const chunkPosition = chunk.chunkGridPosition.map((x, index) => x * chunkDataSize[index]);
      // const chunkPosition = vec3.multiply(vec3.create(), chunk.chunkGridPosition, chunkDataSize);
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: dataInstance.getNodeApiUrl(this.getPath(chunkPosition, chunkDataSize)),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken)
        .then(values => {
          parseAnnotations(this, chunk, values, parameters.properties);
        });
    }
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

  private getPathByBodyId(bodyId: Uint64) {
    return `/${this.parameters.dataInstanceKey}/label/${bodyId}`;
  }

  private getPathByAnnotationId(annotationId: string) {
    return `${this.getElementsPath()}/1_1_1/${annotationId}`;
  }

  /*
  downloadGeometry(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;

    if (parameters.usertag) {
      if (parameters.user) {
        let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey)
        return makeRequestWithCredentials(
          this.credentialsProvider,
          {
            method: 'GET',
            url: dataInstance.getNodeApiUrl(this.getPathByUserTag(parameters.user)),
            payload: undefined,
            responseType: 'json',
          },
          cancellationToken)
          .then(values => {
            parseAnnotations(this, chunk, values);
          });
      } else {
        throw Error('Expecting a valid user name.')
      }
    } else {
      if (chunk.source.spec.upperChunkBound[0] <= chunk.source.spec.lowerChunkBound[0]) {
        return Promise.resolve(parseAnnotations(this, chunk, []));
      }
      const chunkDataSize = this.parameters.chunkDataSize;
      const chunkPosition = chunk.chunkGridPosition.map((x, index) => x * chunkDataSize[index]);
      // const chunkPosition = vec3.multiply(vec3.create(), chunk.chunkGridPosition, chunkDataSize);
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: dataInstance.getNodeApiUrl(this.getPath(chunkPosition, chunkDataSize)),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken)
        .then(values => {
          parseAnnotations(this, chunk, values);
        });
    }
  }
  */

  downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk, _relationshipIndex: number, cancellationToken: CancellationToken) {
    const { parameters } = this;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: dataInstance.getNodeApiUrl(this.getPathByBodyId(chunk.objectId)),
        payload: undefined,
        responseType: 'json',
      },
      cancellationToken)
      .then(values => {
        parseAnnotations(this, chunk, values, parameters.properties);
      });
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    const id = chunk.key!;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: dataInstance.getNodeApiUrl(this.getPathByAnnotationId(id)),
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
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'POST',
          url: dataInstance.getNodeApiUrl(this.getElementsPath()),
          payload: JSON.stringify([dvidAnnotation]),
          responseType: '',
        })
        .then(() => {
          return `${annotation.point[0]}_${annotation.point[1]}_${annotation.point[2]}`;
        });
    } else {
      return Promise.resolve(`${annotation.type}_${JSON.stringify(annotation)}`);
    }
  }

  update(_: AnnotationId, annotation: Annotation) {
    if (this.uploadable(annotation)) {
      const { parameters } = this;
      const dvidAnnotation = annotationToDVID(<DVIDPointAnnotation>annotation, parameters.user);
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'POST',
          url: dataInstance.getNodeApiUrl(this.getElementsPath()),
          payload: JSON.stringify([dvidAnnotation]),
          responseType: '',
        });
    } else {
      return Promise.resolve(`${annotation.type}_${JSON.stringify(annotation)}`);
    }
  }

  delete (id: AnnotationId) {
    const {parameters} = this;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'DELETE',
        url: dataInstance.getNodeApiUrl(`/${parameters.dataInstanceKey}/element/${id}`),
        payload: undefined,
        responseType: '',
      });
  }
}
