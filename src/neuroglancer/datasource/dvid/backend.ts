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
import {assignMeshFragmentData, decodeTriangleVertexPositionsAndIndices, decodeTriangleVertexPositionsAndIndicesM, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
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
import {Annotation, AnnotationId, AnnotationSerializer, AnnotationPropertySerializer, AnnotationType, Point, Sphere, Line, AnnotationPropertySpec} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk, AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {verifyObject, verifyObjectProperty, parseIntVec, verifyString} from 'neuroglancer/util/json';
import {ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID} from 'neuroglancer/annotation/base';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {DVIDInstance, DVIDToken, makeRequestWithCredentials, appendQueryStringForDvid, fetchMeshDataFromService} from 'neuroglancer/datasource/dvid/api';
import {DVIDPointAnnotation, DVIDPointAnnotationFacade, DVIDLineAnnotation, DVIDLineAnnotationFacade, DVIDSphereAnnotation, DVIDSphereAnnotationFacade, getAnnotationDescription, typeOfAnnotationId, isAnnotationIdValid, sphereAnnotationDataName, lineAnnotationDataName, DVIDAnnotation, DVIDAnnotationKindMap} from 'neuroglancer/datasource/dvid/utils';
// import {StringMemoize} from 'neuroglancer/util/memoize';

// let MeshMemoize = new StringMemoize();

function DVIDSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
  Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<DVIDToken>()(Base), parametersConstructor);
}

@registerSharedObject() export class DVIDSkeletonSource extends
(DVIDSource(SkeletonSource, SkeletonSourceParameters)) {
  download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let bodyid = `${chunk.objectId}`;
    const url = `${parameters.baseUrl}/api/node/${parameters['nodeKey']}` +
        `/${parameters['dataInstanceKey']}/key/` + bodyid + '_swc';
    return makeRequestWithCredentials(this.credentialsProvider, {
      method: 'GET', 
      url: appendQueryStringForDvid(url, parameters.user), 
      responseType: 'arraybuffer'
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

export function decodeFragmentChunkM(chunk: FragmentChunk, responses: Array<ArrayBuffer>) {
  let numVerticesArray = new Array<number>();
  for (let response of responses) {
    let dv = new DataView(response);
    let numVertices = dv.getUint32(0, true);
    numVerticesArray.push(numVertices);
  }
  
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndicesM(
          responses, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVerticesArray));
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

  /*
  private fetchMeshDataFromService(fragmentId: string, cancellationToken: CancellationToken) {
    if (defaultMeshService) {
      const {parameters} = this;
      const serviceUrl = defaultMeshService + `?dvid=${parameters.baseUrl}&uuid=${parameters.nodeKey}&body=${fragmentId}&decimation=1.0` + (parameters.user ? `&u=${parameters.user}` : '');
      // console.log('Fetching mesh from ' + serviceUrl);
      return makeRequestWithCredentials(this.credentialsProvider, {
        method: 'GET',
        url: serviceUrl,
        responseType: 'arraybuffer',
      },
      cancellationToken);
    } else {
      throw new Error('No mesh service available');
    }
  }
  */

  private fetchMeshData(fragmentId: string, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let dvidInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    let meshUrl = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, `${fragmentId}.ngmesh`);

    return makeRequestWithCredentials(this.credentialsProvider, {
      method: 'GET', 
      url: appendQueryStringForDvid(meshUrl, parameters.user), 
      responseType: 'arraybuffer'
    }, cancellationToken).catch(
      () => fetchMeshDataFromService(parameters, fragmentId, this.credentialsProvider, cancellationToken)
    );
  }

  async downloadMergeFragment(masterId: string, idArray: any, cancellationToken: CancellationToken) : Promise<Array<ArrayBuffer>>
  {
    const {parameters} = this;
    let dvidInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);

    let data = new Array<ArrayBuffer>();
    for (let id of idArray) {
      if (String(masterId) === String(id)) { //Download master mesh
        try {
          let response = await this.fetchMeshData(masterId, cancellationToken);

          data.push(response);
        } catch(e) {
          console.log(e);
        }
      } else { //Download merged meshes
        let urlPattern = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, String(id));
        await makeRequestWithCredentials(this.credentialsProvider, {
          method: 'GET', url: urlPattern + '.merge', responseType: 'json'
        }, cancellationToken).then(
          response => this.downloadMergeFragment(
          id, response, cancellationToken
        )).then(
          result =>  { 
            data.push(...result);
            console.log(data.length);
          }
        ).catch(async () => { //Try to download single mesh
          try {
            let response = await this.fetchMeshData(id, cancellationToken);

            data.push(response);
          } catch (e) {
            console.log(e);
          }
        }
        );
      }
    }
    return data;
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    let dvidInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    const mergeUrl = dvidInstance.getKeyValueUrl(parameters.dataInstanceKey, `${chunk.fragmentId}.merge`);

    return makeRequestWithCredentials(this.credentialsProvider, {
      method: 'GET', 
      url: appendQueryStringForDvid(mergeUrl, parameters.user), 
      responseType: 'json'
    }, cancellationToken)
    .then(
      response => this.downloadMergeFragment(chunk.fragmentId!, response,  cancellationToken)
      .then(data => decodeFragmentChunkM(chunk, data)))
    .catch((e) => {
      console.log(e);
      // const url = `${keyBaseUrl}/${chunk.fragmentId}.ngmesh`;
      return this.fetchMeshData(chunk.fragmentId!, cancellationToken).then(
        response => decodeFragmentChunk(chunk, response)
      ).catch(e => {
        console.error(e);
      });
    });
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
        url: appendQueryStringForDvid(`${params.baseUrl}${path}`, params.user),
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

export function parseUint64ToArray(out: Uint64[], v: string): Uint64[] {
  if (v) {
    out.push(Uint64.parseString(v));
  }

  return out;
}

function parseLineAnnotation(entry: any): DVIDLineAnnotation
{
  const pos = verifyObjectProperty(entry, 'Pos', x => parseIntVec(new Float32Array(6), x));
  let annotation:DVIDLineAnnotation = {
    type: AnnotationType.LINE,
    id: `${pos[0]}_${pos[1]}_${pos[2]}-${pos[3]}_${pos[4]}_${pos[5]}-Line`,
    pointA: new Float32Array([pos[0], pos[1], pos[2]]),
    pointB: new Float32Array([pos[3], pos[4], pos[5]]),
    properties: [0],
    prop: {}
  };

  if ('Prop' in entry) {
    const propertiesObj = verifyObjectProperty(entry, 'Prop', verifyObject);
    annotation.prop = propertiesObj;
  }

  let description = getAnnotationDescription(annotation);
  if (description) {
    annotation.description = description;
  }

  return annotation;
}

function parseSphereAnnotation(entry: any): DVIDSphereAnnotation
{
  const pos = verifyObjectProperty(entry, 'Pos', x => parseIntVec(new Float32Array(6), x));
  let annotation:DVIDSphereAnnotation = {
    type: AnnotationType.SPHERE,
    id: `${pos[0]}_${pos[1]}_${pos[2]}-${pos[3]}_${pos[4]}_${pos[5]}`,
    pointA: new Float32Array([pos[0], pos[1], pos[2]]),
    pointB: new Float32Array([pos[3], pos[4], pos[5]]),
    properties: [0],
    prop: {}
  };

  let annotationRef = new DVIDSphereAnnotationFacade(annotation);
  if ('Prop' in entry) {
    const propertiesObj = verifyObjectProperty(entry, 'Prop', verifyObject);
    annotationRef.prop = propertiesObj;
  }

  let description = getAnnotationDescription(annotation);
  if (description) {
    annotation.description = description;
  }

  return annotation;
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
    if (propertiesObj.type) {
      prop.type = DVIDToAnnotationType(propertiesObj.type);
    }
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

  let annotationRef = new DVIDPointAnnotationFacade(annotation);
  annotationRef.prop = prop;

  let description = getAnnotationDescription(annotation);
  if (description) {
    annotation.description = description;
  }
  return annotation;
}

export function parseAnnotation(entry: any): DVIDAnnotation|null {
  if (entry) {
    const kind = verifyObjectProperty(entry, 'Kind', verifyString);
    if (kind !== 'Unknown') {
      if (kind === 'Line' || kind === 'Sphere') { //The kind should really be 'Sphere', but use 'Line' here for back-compatibility
        return parseSphereAnnotation(entry);
      } else if (kind === 'PureLine') {
        return parseLineAnnotation(entry);
      } else {
        return parsePointAnnotation(entry, kind);
      }
    }
  }

  return null;
}

export function annotationToDVIDType(typestr: string): string {
  switch (typestr) {
    case 'False Merge':
      return 'Split';
    case 'False Split':
      return 'Merge';
    case '---':
      return '';
    default:
      return typestr;
  }
}

export function DVIDToAnnotationType(typestr: string): string {
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
  propSpec: AnnotationPropertySpec[], emittingAddSignal: boolean) {

  const annotationPropertySerializer = new AnnotationPropertySerializer(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializer);
  if (responses) {
    responses.forEach((response) => {
      if (response) {
        try {
          let annotation = parseAnnotation(response);
          if (annotation) {
            serializer.add(annotation);
            if (emittingAddSignal) {
              if (annotation.type === AnnotationType.SPHERE || annotation.type === AnnotationType.LINE || (annotation.type === AnnotationType.POINT && annotation.kind === 'Note')) {
                source.rpc!.invoke(ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID, {
                      id: source.rpcId,
                      newAnnotation: { ...annotation, description: getAnnotationDescription(annotation) }
                    });
              }
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

function removeEmptyField(obj: {[key:string]: string})
{
  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (obj[key] === '') {
        delete obj[key];
      }
    }
  }
}

export function annotationToDVID(annotation: DVIDAnnotation, user?: string): any {
  if (annotation.type === AnnotationType.POINT) {
    const objectLabels =
    annotation.relatedSegments && annotation.relatedSegments[0] && annotation.relatedSegments[0].map(x => x.toString());

    let obj: { [key: string]: any } = {
      Kind: 'Note',
      Pos: [annotation.point[0], annotation.point[1], annotation.point[2]],
      Prop: {}
    };

    let annotFac = new DVIDPointAnnotationFacade(annotation);

    obj.Prop = { ...annotFac.prop };
    if (annotFac.bookmarkType) {
      let type = annotationToDVIDType(annotFac.bookmarkType);
      if (type) {
        obj.Prop['type'] = type;
      } else {
        delete obj.Prop['type'];
      }
    }
    removeEmptyField(obj.Prop);
    if ('checked' in obj.Prop) {
      if (!annotFac.checked) {
        delete obj.Prop['checked'];
      }
    }

    if (objectLabels && objectLabels.length > 0) {
      obj.Prop['body ID'] = objectLabels[0];
    }
    if (user) {
      obj['Tags'] = ['user:' + user];
      obj.Prop['user'] = user;
    }

    return obj;
  } else if (annotation.type === AnnotationType.SPHERE || annotation.type == AnnotationType.LINE) {
    let obj:any = {
      Kind: DVIDAnnotationKindMap[annotation.type],
      Pos: [...annotation.pointA, ...annotation.pointB]
    };

    if (annotation.type == AnnotationType.SPHERE) {
      let annotFac = new DVIDSphereAnnotationFacade(annotation);
      obj.Prop = { ...annotFac.prop };
    } else {
      let annotFac = new DVIDLineAnnotationFacade(annotation);
      obj.Prop = { ...annotFac.prop };
    }

    return obj;
  } 
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
        let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);

        let values:any[] = [];
        try {
          let pointAnnotationValues = await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'GET',
              url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(this.getPathByUserTag(parameters.user)), parameters.user),
              payload: undefined,
              responseType: 'json',
            },
            cancellationToken);
          values = [...pointAnnotationValues];
        } catch {
        }

        try {
          let keys = await makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'GET',
              url: appendQueryStringForDvid(dataInstance.getKeyValueRangeUrl(sphereAnnotationDataName, parameters.user + '--0', parameters.user + '--z'), parameters.user),
              payload: undefined,
              responseType: 'json',
            },
            cancellationToken);

          console.log(keys);

          for (let key of keys) {
            try {
              let sphereAnnotaionValue = await makeRequestWithCredentials(
                this.credentialsProvider,
                {
                  method: 'GET',
                  url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(sphereAnnotationDataName, key), parameters.user),
                  responseType: 'json',
                },
                cancellationToken);
              values.push(sphereAnnotaionValue);
            } catch (e) {
              console.log(e);
            }
          }
        } catch(e) {
          console.log(e);
        }
        return parseAnnotations(this, chunk, values, parameters.properties, true);
      } else {
        throw Error('Expecting a valid user name.')
      }
    } else {
      if (chunk.source.spec.upperChunkBound[0] <= chunk.source.spec.lowerChunkBound[0]) {
        return Promise.resolve(parseAnnotations(this, chunk, [], parameters.properties, true));
      }
      const chunkDataSize = this.parameters.chunkDataSize;
      const chunkPosition = chunk.chunkGridPosition.map((x, index) => x * chunkDataSize[index]);
      // const chunkPosition = vec3.multiply(vec3.create(), chunk.chunkGridPosition, chunkDataSize);
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

  private requestBookmarkMetaData(dataName: string, id: AnnotationId, cancellationToken: CancellationToken) {
    const { parameters } = this;
    if (parameters.user) {
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(dataName, `${this.parameters.user}--${id}`), parameters.user),
          responseType: 'json',
        },
        cancellationToken);
    } else {
      throw new Error('User must be specified for sphere annotation.');
    }
  }

  private requestSphereMetaData(id: AnnotationId, cancellationToken: CancellationToken) {
    return this.requestBookmarkMetaData(sphereAnnotationDataName, id, cancellationToken);
  }

  private requestLineMetaData(id: AnnotationId, cancellationToken: CancellationToken) {
    return this.requestBookmarkMetaData(lineAnnotationDataName, id, cancellationToken);
  }

  private requestMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const id = chunk.key!;
    switch (typeOfAnnotationId(id)) {
      case AnnotationType.POINT:
        return this.requestPointMetaData(id, cancellationToken);
      case AnnotationType.SPHERE:
        return this.requestSphereMetaData(id, cancellationToken);
      case AnnotationType.LINE:
        return this.requestLineMetaData(id, cancellationToken);
      default:
        throw new Error(`Invalid annotation ID for DVID: ${id}`);
    }
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    return this.requestMetadata(chunk, cancellationToken).then(
      response => {
        if (response) {
          chunk.annotation = parseAnnotation(response);
        } else {
          chunk.annotation = null;
        }
      }
    )
  }

  private uploadable(annotation: Annotation): annotation is Point | Sphere | Line {
    const { parameters } = this;

    if (parameters.user && parameters.user !== '') {
      return annotation.type === AnnotationType.POINT || annotation.type === AnnotationType.SPHERE ||
      annotation.type === AnnotationType.LINE;
    }

    return false;
  }

  private updatePointAnnotation(annotation: DVIDPointAnnotation) {
    const { parameters } = this;
    const dvidAnnotation = annotationToDVID(annotation, parameters.user);

    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'POST',
        url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(this.getElementsPath()), parameters.user),
        payload: JSON.stringify([dvidAnnotation]),
        responseType: '',
      });
  }

  private addPointAnnotation(annotation: DVIDPointAnnotation) {
    return this.updatePointAnnotation(annotation)
      .then(() => {
        return `${annotation.point[0]}_${annotation.point[1]}_${annotation.point[2]}`;
      })
      .catch(e => {
        throw new Error(e);
      });
  }

  private getLineAnnotationId(annotation: DVIDLineAnnotation) {
    return `${annotation.pointA[0]}_${annotation.pointA[1]}_${annotation.pointA[2]}-${annotation.pointB[0]}_${annotation.pointB[1]}_${annotation.pointB[2]}-Line`;
  }

  private getLineAnnotationKeyFromId(id: AnnotationId) {
    if (this.parameters.user) {
      return `${this.parameters.user}--${id}`;
    } else {
      throw new Error('Cannot commit line annotation because no user is specified');
    } 
  }

  private getLineAnnotationKey(annotation: DVIDLineAnnotation) {
    return this.getLineAnnotationKeyFromId(this.getLineAnnotationId(annotation));
  }

  private updateLineAnnotation(annotation: DVIDLineAnnotation) {
    const { parameters } = this;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    const dvidAnnotation = annotationToDVID(annotation);
    const key = this.getLineAnnotationKey(annotation);

    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'POST',
        url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(lineAnnotationDataName, key), parameters.user),
        payload: JSON.stringify(dvidAnnotation),
        responseType: '',
      });
  }

  private addLineAnnotation(annotation: DVIDLineAnnotation) {
    return this.updateLineAnnotation(annotation)
      .then(() => {
        return this.getLineAnnotationId(annotation);
      })
      .catch(e => {
        throw new Error(e);
      });
  }

  private getSphereAnnotationId(annotation: DVIDSphereAnnotation) {
    return `${annotation.pointA[0]}_${annotation.pointA[1]}_${annotation.pointA[2]}-${annotation.pointB[0]}_${annotation.pointB[1]}_${annotation.pointB[2]}`;
  }

  private getSphereAnnotationKeyFromId(id: AnnotationId) {
    if (this.parameters.user) {
      return `${this.parameters.user}--${id}`;
    } else {
      throw new Error('Cannot commit sphere annotation because no user is specified');
    }
  }

  private getSphereAnnotationKey(annotation: DVIDSphereAnnotation) {
    return this.getSphereAnnotationKeyFromId(this.getSphereAnnotationId(annotation));
  }

  private updateSphereAnnotation(annotation: DVIDSphereAnnotation) {
    const { parameters } = this;
    let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
    const dvidAnnotation = annotationToDVID(annotation);
    const key = this.getSphereAnnotationKey(annotation);

    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'POST',
        url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(sphereAnnotationDataName, key), parameters.user),
        payload: JSON.stringify(dvidAnnotation),
        responseType: '',
      });
  }

  private addSphereAnnotation(annotation: DVIDSphereAnnotation) {
    return this.updateSphereAnnotation(annotation)
      .then(() => {
        return this.getSphereAnnotationId(annotation);
      })
      .catch(e => {
        throw new Error(e);
      });
  }

  add(annotation: Annotation) {
    if (this.uploadable(annotation)) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          return this.addPointAnnotation(<DVIDPointAnnotation>annotation);
        case AnnotationType.SPHERE:
          return this.addSphereAnnotation(<DVIDSphereAnnotation>annotation);
        case AnnotationType.LINE:
          return this.addLineAnnotation(<DVIDLineAnnotation>annotation);
      }
      
    } else {
      return Promise.resolve(`${annotation.type}_${JSON.stringify(annotation)}`);
    }
  }
  
  update(_: AnnotationId, annotation: Annotation) {
    if (this.uploadable(annotation)) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          return this.updatePointAnnotation(<DVIDPointAnnotation>annotation);
        case AnnotationType.SPHERE:
          return this.updateSphereAnnotation(<DVIDSphereAnnotation>annotation);
        case AnnotationType.LINE:
          return this.updateLineAnnotation(<DVIDLineAnnotation>annotation);
      }
    } else {
      throw new Error('Cannot update DVID annotation');
    }
  }

  delete(id: AnnotationId) {
    if (isAnnotationIdValid(id)) {
      const { parameters } = this;
      let dataInstance = new DVIDInstance(parameters.baseUrl, parameters.nodeKey);
      switch (typeOfAnnotationId(id)) {
        case AnnotationType.POINT:
          return makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: appendQueryStringForDvid(dataInstance.getNodeApiUrl(`/${parameters.dataInstanceKey}/element/${id}`), parameters.user),
              responseType: '',
            });
        case AnnotationType.SPHERE:
          return makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(sphereAnnotationDataName, this.getSphereAnnotationKeyFromId(id)), parameters.user),
              responseType: '',
            });
        case AnnotationType.LINE:
          return makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: appendQueryStringForDvid(dataInstance.getKeyValueUrl(lineAnnotationDataName, this.getLineAnnotationKeyFromId(id)), parameters.user),
              responseType: '',
            });
        default:
          throw new Error(`Invalid annotation ID for DVID: ${id}`)
      }
    } else {
      return Promise.resolve(null);
    }
  }
}
