/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import type { Annotation, AnnotationId, AnnotationPropertySpec } from "#src/annotation/index.js";
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
} from "#src/annotation/backend.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { ClioToken } from "#src/datasource/clio/api.js";
import { fetchWithClioCredentials, ClioInstance } from "#src/datasource/clio/api.js";
import {
  AnnotationSourceParameters,
  AnnotationChunkSourceParameters,
} from "#src/datasource/clio/base.js";
import type { ClioSourceParameters } from "#src/datasource/clio/base.js";
import type { ClioAnnotation, ClioPointAnnotation } from "#src/datasource/clio/utils.js";
import {
  ClioAnnotationFacade,
  makeEncoders,
} from "#src/datasource/clio/utils.js";
import {
  ANNOTATION_COMMIT_ADD_SIGNAL_RPC_ID,
  getAnnotationKey,
  getAnnotationId,
  parseAnnotationId,
  typeOfAnnotationId,
  isAnnotationIdValid,
} from "#src/datasource/flyem/annotation.js";
import { StringMemoize } from "#src/util/memoize.js";
import { RefCounted } from "#src/util/disposable.js";
import type { RPC, SharedObject } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

class AnnotationStore extends RefCounted {
  store = new Map<string, any>();

  clear() {
    this.store.clear();
  }

  add(id: string, value: any) {
    if (id) {
      this.store.set(id, value);
    }
  }

  remove(id: string) {
    this.store.delete(id);
  }

  update(id: string, value: any) {
    this.add(id, value);
  }

  getValue(id: string) {
    return this.store.get(id);
  }
}

const memoize = new StringMemoize();

function getAnnotationStore(parameters: ClioSourceParameters) {
  const instance = new ClioInstance(parameters);
  return memoize.get(instance.getAllAnnotationsUrl(), () => {
    return new AnnotationStore();
  });
}

function ClioSource<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<ClioToken>()(Base),
    parametersConstructor,
  );
}

function parseAnnotations(
  source: ClioAnnotationSource | ClioAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk,
  responses: any,
  propSpec: AnnotationPropertySpec[],
  emittingAddSignal: boolean,
) {
  const annotationPropertySerializers = makeAnnotationPropertySerializers(
    3,
    propSpec,
  );
  const serializer = new AnnotationSerializer(annotationPropertySerializers);
  if (responses) {
    const parseSingleAnnotation = (
      key: string,
      response: any,
      index: number,
      lastIndex: number,
    ) => {
      if (response) {
        try {
          const annotation = source.decodeAnnotation(key, response);
          if (annotation) {
            if (index === lastIndex) {
              annotation.source = `downloaded:last`;
            } else {
              annotation.source = `downloaded:${index}/${lastIndex}`;
            }
            getAnnotationStore(source.parameters).add(
              getAnnotationId(annotation),
              response,
            );
            serializer.add(annotation);
            if (emittingAddSignal) {
              source.rpc!.invoke(ANNOTATION_COMMIT_ADD_SIGNAL_RPC_ID, {
                id: source.rpcId,
                newAnnotation: annotation,
              });
            }
          }
        } catch (e) {
          console.log(`Error parsing annotation: ${(e as Error).message}`);
        }
      }
    };

    const { parameters } = source;
    const annotationCount = Object.keys(responses).length;
    Object.keys(responses).forEach((key, index) => {
      const response = responses[key];
      if (response) {
        if (!("Kind" in response)) {
          response["Kind"] = parameters.kind!;
        }
      }
      parseSingleAnnotation(
        response.key || key,
        response,
        index,
        annotationCount - 1,
      );
    });
  }
  chunk.data = Object.assign(
    new AnnotationGeometryData(),
    serializer.serialize(),
  );
}

@registerSharedObject()
export class ClioAnnotationGeometryChunkSource extends ClioSource(
  AnnotationGeometryChunkSourceBackend,
  AnnotationChunkSourceParameters,
) {
  private encoder = makeEncoders(this.parameters.api, this.parameters.kind);

  decodeAnnotation(key: string, entry: any) {
    const type = typeOfAnnotationId(key);
    if (type !== null) {
      return this.encoder[type].decode(key, entry);
    }

    return null;
  }

  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    getAnnotationStore(this.parameters).clear();

    const clioInstance = new ClioInstance(this.parameters);
    const response = await fetchWithClioCredentials(
      this.credentialsProvider,
      clioInstance.getAllAnnotationsUrl(),
      { method: "GET", signal },
    );
    const pointAnnotationValues = await response.json();

    return parseAnnotations(
      this,
      chunk,
      pointAnnotationValues,
      this.parameters.properties,
      true,
    );
  }
}

@registerSharedObject()
export class ClioAnnotationSource extends ClioSource(
  AnnotationSource,
  AnnotationSourceParameters,
) {
  private encoders = makeEncoders(this.parameters.api, this.parameters.kind);

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }

  private requestMetadata(chunk: AnnotationMetadataChunk, _signal: AbortSignal) {
    const id = chunk.key!;
    return Promise.resolve(getAnnotationStore(this.parameters).getValue(id));
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, signal: AbortSignal) {
    return this.requestMetadata(chunk, signal).then((response) => {
      if (response) {
        chunk.annotation = this.decodeAnnotation(chunk.key!, response);
      } else {
        chunk.annotation = null;
      }
    });
  }

  private uploadable(annotation: Annotation | string) {
    const encoder = this.getEncoder(annotation);
    if (encoder) {
      return encoder.uploadable(
        typeof annotation === "string"
          ? encoder.decode(
              annotation,
              getAnnotationStore(this.parameters).getValue(annotation),
            )
          : annotation,
      );
    }

    return false;
  }

  decodeAnnotation(key: string, entry: any): ClioAnnotation | null {
    const type = typeOfAnnotationId(key);
    if (type !== null) {
      return this.encoders[type].decode(key, entry);
    }

    return null;
  }

  private getEncoder(annotation: Annotation | string) {
    let type: AnnotationType | null = null;
    if (typeof annotation === "string") {
      type = typeOfAnnotationId(annotation);
    } else {
      type = annotation.type;
    }

    if (type !== null) {
      return this.encoders[type];
    }

    return undefined;
  }

  private encodeAnnotation(annotation: ClioAnnotation): any {
    const encoder = this.getEncoder(annotation);
    if (encoder) {
      return encoder.encode(annotation);
    }

    return null;
  }

  private updateAnnotation(
    annotation: ClioAnnotation,
    overwrite: boolean,
  ) {
    try {
      const { parameters } = this;
      if (!parameters.user) {
        throw Error("Cannot upload an annotation without a user");
      }

      new ClioAnnotationFacade(annotation).user = parameters.user;
      const encoded = this.encodeAnnotation(annotation);
      if (encoded === null) {
        throw new Error("Unable to encode the annotation");
      }

      if (
        !overwrite &&
        getAnnotationStore(this.parameters).getValue(
          getAnnotationId(annotation),
        )
      ) {
        throw new Error("Cannot overwrite existing annotation");
      }

      const value = JSON.stringify(encoded);
      getAnnotationStore(this.parameters).update(
        getAnnotationId(annotation),
        encoded,
      );

      if (this.uploadable(annotation)) {
        const clioInstance = new ClioInstance(parameters);
        return fetchWithClioCredentials(
          this.credentialsProvider,
          clioInstance.getPostAnnotationUrl(
            (annotation as ClioPointAnnotation).point,
          ),
          {
            method: "POST",
            body: value,
            headers: { "Content-Type": "application/json" },
          },
        ).then((response) => response.json());
      } else {
        return Promise.resolve(getAnnotationKey(annotation));
      }
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private addAnnotation(annotation: ClioAnnotation) {
    return this.updateAnnotation(annotation, false)
      .then((response) => {
        let key: string | undefined = undefined;
        if (typeof response === "string" && response.length > 0) {
          key = response;
        } else {
          key = response.key;
        }

        return getAnnotationId(annotation, key);
      })
      .catch((e) => {
        throw new Error(e);
      });
  }

  add(annotation: Annotation) {
    return this.addAnnotation(annotation as ClioAnnotation);
  }

  update(id: AnnotationId, annotation: Annotation) {
    if (getAnnotationId(annotation as ClioAnnotation) !== id) {
      delete (annotation as ClioAnnotation).key;
    }

    return this.updateAnnotation(
      annotation as ClioAnnotation,
      true,
    ).then(() => {});
  }

  private deleteAnnotation(id: AnnotationId) {
    const clioInstance = new ClioInstance(this.parameters);

    if (this.uploadable(id)) {
      const cachedAnnotation = getAnnotationStore(this.parameters).getValue(id);
      if (cachedAnnotation) {
        const { user } = cachedAnnotation;
        if (user && user !== this.parameters.user) {
          throw new Error(
            `Unable to delete annotation owned by ${user}.`,
          );
        }
      }

      const idInfo = parseAnnotationId(id);
      const key = idInfo ? idInfo.key : id;
      return fetchWithClioCredentials(
        this.credentialsProvider,
        clioInstance.getDeleteAnnotationUrl(key),
        { method: "DELETE" },
      ).then(() => {
        getAnnotationStore(this.parameters).remove(id);
      });
    } else {
      getAnnotationStore(this.parameters).remove(id);
      return Promise.resolve();
    }
  }

  delete(id: AnnotationId) {
    if (isAnnotationIdValid(id)) {
      try {
        return this.deleteAnnotation(id);
      } catch (e) {
        return Promise.reject(e);
      }
    } else {
      return Promise.resolve();
    }
  }
}
