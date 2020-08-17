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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {AnnotationSourceParameters, AnnotationChunkSourceParameters, ClioSourceParameters} from 'neuroglancer/datasource/clio/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {registerSharedObject, SharedObject, RPC} from 'neuroglancer/worker_rpc';
import {Uint64} from 'neuroglancer/util/uint64';
import {Annotation, AnnotationId, AnnotationSerializer, AnnotationPropertySerializer, AnnotationType, Point, /*Sphere, Line,*/ AnnotationPropertySpec} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk, AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID} from 'neuroglancer/annotation/base';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {ClioToken, makeRequestWithCredentials} from 'neuroglancer/datasource/clio/api';
import {DVIDPointAnnotation, getAnnotationDescription, typeOfAnnotationId, isAnnotationIdValid, getAnnotationId} from 'neuroglancer/datasource/dvid/utils';
import {parseAnnotation, annotationToDVID} from 'neuroglancer/datasource/dvid/backend'

class AnnotationStore {
  store = new Map();

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

let annotationStore = new AnnotationStore;

function ClioSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
  Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<ClioToken>()(Base), parametersConstructor);
}


export function parseUint64ToArray(out: Uint64[], v: string): Uint64[] {
  if (v) {
    out.push(Uint64.parseString(v));
  }

  return out;
}


// const annotationPropertySerializer = new AnnotationPropertySerializer(3, []);

function parseAnnotations(
  source: ClioAnnotationSource|ClioAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any[],
  propSpec: AnnotationPropertySpec[], emittingAddSignal: boolean) {

  const annotationPropertySerializer = new AnnotationPropertySerializer(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializer);
  if (responses) {
    let parseSingleAnnotation = (response: any) => {
      if (response) {
        try {
          let annotation = parseAnnotation(response);
          if (annotation) {
            annotationStore.add(getAnnotationId(annotation), response);
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
    };

    responses.forEach(parseSingleAnnotation);
  }
  chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
}

function getTopUrl(parameters: ClioSourceParameters) {
  return `${parameters.baseUrl}/clio_toplevel`;
}

function getClioUrl(parameters: ClioSourceParameters, path: string) {
  return getTopUrl(parameters) + path;
}

function getElementsPath(parameters: ClioSourceParameters) {
  return `/annotations/${parameters.dataset}`;
} 

function getAnnotationPath(parameters: ClioSourceParameters, position: ArrayLike<number|string>) {
  return `${getElementsPath(parameters)}?x=${position[0]}&y=${position[1]}&z=${position[2]}`;
}

function getAnnotationUrl(parameters: ClioSourceParameters, position: ArrayLike<number|string>) {
  return getClioUrl(parameters, getAnnotationPath(parameters, position));
}

@registerSharedObject() //
export class ClioAnnotationGeometryChunkSource extends (ClioSource(AnnotationGeometryChunkSourceBackend, AnnotationChunkSourceParameters)) {
  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    // let values: any[] = [];
    try {
      let pointAnnotationValues = await makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: getClioUrl(this.parameters, getElementsPath(this.parameters)),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken);
      // values = [...pointAnnotationValues];

      return parseAnnotations(this, chunk, Object.values(pointAnnotationValues), this.parameters.properties, true);
    } catch(e) {
      console.log(e);
    }
  }
}

@registerSharedObject() export class ClioAnnotationSource extends (ClioSource(AnnotationSource, AnnotationSourceParameters)) {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // updateAnnotationTypeHandler();
  }

  private requestPointMetaData(id: AnnotationId, _: CancellationToken) {
    return Promise.resolve(annotationStore.getValue(id));
    /*
    const { parameters } = this;
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'GET',
        url: getAnnotationUrl(parameters, id.split('_')),
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
      */
  }

  private requestMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    const id = chunk.key!;
    switch (typeOfAnnotationId(id)) {
      case AnnotationType.POINT:
        return this.requestPointMetaData(id, cancellationToken);
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

  private uploadable(annotation: Annotation): annotation is Point /*| Sphere | Line*/ {
    const { parameters } = this;

    if (parameters.user && parameters.user !== '') {
      return annotation.type === AnnotationType.POINT/* || annotation.type === AnnotationType.SPHERE ||
      annotation.type === AnnotationType.LINE*/;
    }

    return false;
  }

  private updatePointAnnotation(annotation: DVIDPointAnnotation) {
    const { parameters } = this;
    const dvidAnnotation = annotationToDVID(annotation, parameters.user);

    let value = JSON.stringify(dvidAnnotation);
    annotationStore.update(getAnnotationId(annotation), value);

    if (parameters.baseUrl.startsWith('http://localhost')) { //mock server
      //no support for POST yet
      console.log(getAnnotationUrl(parameters, annotation.point));
      console.log(value);
      return Promise.resolve('');
    } else {
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'POST',
          url: getAnnotationUrl(parameters, annotation.point),
          payload: value,
          responseType: '',
        });
    }
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


  add(annotation: Annotation) {
    if (this.uploadable(annotation)) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          return this.addPointAnnotation(<DVIDPointAnnotation>annotation);
        default:
          throw('Unspported annotation type');
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
        default:
          throw ('Unspported annotation type');
      }
    } else {
      throw new Error('Cannot update DVID annotation');
    }
  }

  delete(id: AnnotationId) {
    if (isAnnotationIdValid(id)) {
      const { parameters } = this;
      switch (typeOfAnnotationId(id)) {
        case AnnotationType.POINT:
          annotationStore.remove(id);
          return makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: getAnnotationUrl(parameters, id.split('_')),
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
