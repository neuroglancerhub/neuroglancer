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

import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";
import {
  AnnotationGeometryData,
  AnnotationGeometryChunkSourceBackend,
  AnnotationSource,
} from "#src/annotation/backend.js";
import type {
  AnnotationGeometryChunk,
  AnnotationMetadataChunk,
  AnnotationSubsetGeometryChunk,
} from "#src/annotation/backend.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { DVIDToken } from "#src/datasource/dvid/api.js";
import {
  DVIDInstance,
  appendQueryString,
  appendQueryStringForDvid,
  fetchMeshDataFromService,
  fetchWithDVIDCredentials,
} from "#src/datasource/dvid/api.js";
import {
  AnnotationChunkSourceParameters,
  AnnotationSourceParameters,
  MeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/dvid/base.js";
import type {
  DVIDAnnotation,
  DVIDPointAnnotation,
} from "#src/datasource/dvid/utils.js";
import { DVIDAnnotationFacade } from "#src/datasource/dvid/utils.js";
import type { FragmentChunk, ManifestChunk } from "#src/mesh/backend.js";
import {
  assignMeshFragmentData,
  decodeTriangleVertexPositionsAndIndices,
  MeshSource,
} from "#src/mesh/backend.js";
import type { SkeletonChunk } from "#src/skeleton/backend.js";
import { SkeletonSource } from "#src/skeleton/backend.js";
import { decodeSwcSkeletonChunk } from "#src/skeleton/decode_swc_skeleton.js";
import { decodeCompressedSegmentationChunk } from "#src/sliceview/backend_chunk_decoders/compressed_segmentation.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { Endianness } from "#src/util/endian.js";
import { vec3 } from "#src/util/geom.js";
import {
  parseIntVec,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import type { RPC, SharedObject } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

function DVIDSource<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<DVIDToken>()(Base),
    parametersConstructor,
  );
}

@registerSharedObject()
export class DVIDSkeletonSource extends DVIDSource(
  SkeletonSource,
  SkeletonSourceParameters,
) {
  download(chunk: SkeletonChunk, signal: AbortSignal) {
    const { parameters } = this;
    if (parameters.supervoxels) {
      return Promise.reject();
    }

    const bodyid = `${chunk.objectId}`;
    const url =
      `${parameters.baseUrl}/api/node/${parameters.nodeKey}` +
      `/${parameters.dataInstanceKey}/key/` +
      bodyid +
      "_swc";
    return fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(url, parameters.user),
      {
        signal: signal,
      },
    )
      .then((response) => response.arrayBuffer())
      .then((response) => {
        const enc = new TextDecoder("utf-8");
        decodeSwcSkeletonChunk(chunk, enc.decode(response));
      });
  }
}

export function decodeFragmentChunk(
  chunk: FragmentChunk,
  response: ArrayBuffer,
) {
  const dv = new DataView(response);
  const numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
    chunk,
    decodeTriangleVertexPositionsAndIndices(
      response,
      Endianness.LITTLE,
      /*vertexByteOffset=*/ 4,
      numVertices,
    ),
  );
}

@registerSharedObject()
export class DVIDMeshSource extends DVIDSource(
  MeshSource,
  MeshSourceParameters,
) {
  download(chunk: ManifestChunk) {
    // DVID does not currently store meshes chunked, the main
    // use-case is for low-resolution 3D views.
    // for now, fragmentId is the body id
    chunk.fragmentIds = [`${chunk.objectId}`];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { fragmentId } = chunk;
    if (fragmentId) {
      const { parameters } = this;
      const dvidInstance = new DVIDInstance(
        parameters.baseUrl,
        parameters.nodeKey,
      );
      const meshUrl = dvidInstance.getKeyValueUrl(
        parameters.dataInstanceKey,
        `${fragmentId}.ngmesh`,
      );

      const { forceDvidService, supervoxels } = parameters;
      // DVID should never load meshes for supervoxels, so if that parameter is
      // true, then we should always use the small mesh service.
      if (forceDvidService || supervoxels) {
        return fetchMeshDataFromService(parameters, fragmentId, signal)
          .then((response) => decodeFragmentChunk(chunk, response))
          .catch((error) => {
            console.log(error);
          });
      }

      return fetchWithDVIDCredentials(
        this.credentialsProvider,
        appendQueryStringForDvid(meshUrl, parameters.user),
        {
          signal: signal,
        },
      )
        .then((response) => response.arrayBuffer())
        .catch(() =>
          fetchMeshDataFromService(parameters, fragmentId, signal),
        )
        .then((response) => decodeFragmentChunk(chunk, response))
        .catch((error) => {
          console.log(error);
        });
    }

    throw new Error("Invalid mesh fragment ID.");
  }
}

function parseBigUint64(value: string): bigint {
  if (value) {
    return BigInt(value);
  }
  return 0n;
}

function parsePointAnnotation(
  entry: any,
  kind: string,
): DVIDPointAnnotation {
  let prop: { [key: string]: string } = {};

  const propertiesObj = verifyObjectProperty(entry, "Prop", verifyObject);
  const corner = verifyObjectProperty(entry, "Pos", (x) =>
    parseIntVec(vec3.create(), x),
  );
  const relatedSegments: BigUint64Array[] = [new BigUint64Array(0)];

  prop = propertiesObj;
  if (kind === "Note") {
    const bodyId = verifyObjectProperty(
      propertiesObj,
      "body ID",
      (x) => (x ? parseBigUint64(x) : undefined),
    );
    if (bodyId !== undefined) {
      relatedSegments[0] = new BigUint64Array([bodyId]);
    }
  }

  const annotation: DVIDPointAnnotation = {
    point: new Float32Array(corner),
    type: AnnotationType.POINT,
    properties: [],
    kind,
    id: `${corner[0]}_${corner[1]}_${corner[2]}`,
    relatedSegments,
    prop: {},
  };

  const annotationRef = new DVIDAnnotationFacade(annotation);
  annotationRef.prop = prop;
  annotationRef.update();

  const description = annotationRef.description;
  if (description) {
    annotation.description = description;
  }
  return annotation;
}

export function parseAnnotation(entry: any): DVIDAnnotation | null {
  if (entry) {
    const kind = verifyObjectProperty(entry, "Kind", verifyString);
    if (kind !== "Unknown") {
      return parsePointAnnotation(entry, kind);
    }
  }
  return null;
}

@registerSharedObject()
export class DVIDAnnotationGeometryChunkSource extends DVIDSource(
  AnnotationGeometryChunkSourceBackend,
  AnnotationChunkSourceParameters,
) {
  private getBlocksPath() {
    return `/${this.parameters.dataInstanceKey}/blocks`;
  }

  private getPath(position: ArrayLike<number>, size: ArrayLike<number>) {
    return `${this.getBlocksPath()}/${size[0]}_${size[1]}_${size[2]}/${position[0]}_${position[1]}_${position[2]}`;
  }

  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    const { parameters } = this;
    if (
      chunk.source.spec.upperChunkBound[0] <=
      chunk.source.spec.lowerChunkBound[0]
    ) {
      parseAnnotations(chunk, [], parameters.properties, true);
      return;
    }
    const chunkDataSize = this.parameters.chunkDataSize;
    const chunkPosition = chunk.chunkGridPosition.map(
      (x, index) => x * chunkDataSize[index],
    );
    const dvidInstance = new DVIDInstance(
      parameters.baseUrl,
      parameters.nodeKey,
    );
    const response = await fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(
        dvidInstance.getNodeApiUrl(this.getPath(chunkPosition, chunkDataSize)),
        parameters.user,
      ),
      { signal },
    );
    const values = await response.json();
    parseAnnotations(chunk, values, parameters.properties, false);
  }
}

@registerSharedObject()
export class DVIDAnnotationSourceBackend extends DVIDSource(
  AnnotationSource,
  AnnotationSourceParameters,
) {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  private getElementsPath() {
    return `/${this.parameters.dataInstanceKey}/elements`;
  }

  private getPathByBodyId(segmentation: string, bodyId: bigint) {
    return `/${segmentation}/label/${bodyId}`;
  }

  private getPathByAnnotationId(annotationId: string) {
    return `${this.getElementsPath()}/1_1_1/${annotationId}`;
  }

  downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk,
    _relationshipIndex: number,
    signal: AbortSignal,
  ) {
    const { parameters } = this;
    if (parameters.syncedLabel) {
      const dvidInstance = new DVIDInstance(
        parameters.baseUrl,
        parameters.nodeKey,
      );
      return fetchWithDVIDCredentials(
        this.credentialsProvider,
        appendQueryStringForDvid(
          dvidInstance.getNodeApiUrl(
            this.getPathByBodyId(
              parameters.dataInstanceKey,
              chunk.objectId,
            ),
          ),
          parameters.user,
        ),
        { signal },
      )
        .then((response) => response.json())
        .then((values) => {
          parseAnnotations(
            chunk,
            values,
            parameters.properties,
            false,
          );
        });
    }
    throw Error("Synced label missing");
  }

  private requestPointMetaData(id: string, signal: AbortSignal) {
    const { parameters } = this;
    const dvidInstance = new DVIDInstance(
      parameters.baseUrl,
      parameters.nodeKey,
    );
    return fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(
        dvidInstance.getNodeApiUrl(this.getPathByAnnotationId(id)),
        parameters.user,
      ),
      { signal },
    )
      .then((response) => response.json())
      .then((response) => {
        if (response && response.length > 0) {
          return response[0];
        }
        return response;
      });
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, signal: AbortSignal) {
    const id = chunk.key!;
    return this.requestPointMetaData(id, signal).then((response: any) => {
      if (response) {
        chunk.annotation = parseAnnotation(response);
      } else {
        chunk.annotation = null;
      }
    });
  }
}

function parseAnnotations(
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk,
  responses: any[] | { [key: string]: any[] },
  propSpec: AnnotationPropertySpec[],
  _emittingAddSignal: boolean,
) {
  const annotationPropertySerializers = makeAnnotationPropertySerializers(
    3,
    propSpec,
  );
  const serializer = new AnnotationSerializer(annotationPropertySerializers);
  if (responses) {
    let itemList: any[];
    if (!Array.isArray(responses)) {
      itemList = Object.keys(responses).reduce(
        (acc: any[], key) => [...acc, ...(responses as any)[key]],
        [],
      );
    } else {
      itemList = responses;
    }

    itemList.forEach((response) => {
      if (response) {
        try {
          const annotation = parseAnnotation(response);
          if (annotation) {
            serializer.add(annotation);
          }
        } catch (e) {
          throw new Error(
            `Error parsing annotation: ${(e as Error).message}`,
          );
        }
      }
    });
  }
  chunk.data = Object.assign(
    new AnnotationGeometryData(),
    serializer.serialize(),
  );
}

@registerSharedObject()
export class DVIDVolumeChunkSource extends DVIDSource(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const params = this.parameters;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      const chunkPosition = this.computeChunkBounds(chunk);
      const chunkDataSize = chunk.chunkDataSize!;

      // if the volume is an image, get a jpeg
      path = this.getPath(chunkPosition, chunkDataSize);
      if (params.supervoxels) {
        path = appendQueryString(path, "supervoxels", "true");
      }
    }
    const decoder = this.getDecoder(params);
    const response = await fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(`${params.baseUrl}${path}`, params.user),
      { signal: signal },
    ).then((response) => response.arrayBuffer());
    await decoder(
      chunk,
      signal,
      params.encoding === VolumeChunkEncoding.JPEG
        ? response.slice(16)
        : response,
    );
  }
  getPath(chunkPosition: Float32Array, chunkDataSize: Uint32Array) {
    const params = this.parameters;
    if (params.encoding === VolumeChunkEncoding.JPEG) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/subvolblocks/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}`
      );
    }
    if (params.encoding === VolumeChunkEncoding.RAW) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}/jpeg`
      );
    }
    if (params.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip&scale=${params.dataScale}`
      );
    }
    // encoding is COMPRESSED_SEGMENTATION
    return (
      `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
      `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
      `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip`
    );
  }
  getDecoder(params: any) {
    if (
      params.encoding === VolumeChunkEncoding.JPEG ||
      params.encoding === VolumeChunkEncoding.RAW
    ) {
      return decodeJpegChunk;
    }
    // encoding is COMPRESSED_SEGMENTATION
    return decodeCompressedSegmentationChunk;
  }
}
