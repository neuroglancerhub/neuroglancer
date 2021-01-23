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
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {registerSharedObject, SharedObject, RPC} from 'neuroglancer/worker_rpc';
import {Uint64} from 'neuroglancer/util/uint64';
import {Annotation, AnnotationId, AnnotationSerializer, AnnotationPropertySerializer, AnnotationType, /*Sphere, Line,*/ AnnotationPropertySpec} from 'neuroglancer/annotation';
import {AnnotationGeometryChunk, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource, AnnotationSubsetGeometryChunk, AnnotationGeometryChunkSourceBackend} from 'neuroglancer/annotation/backend';
import {ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID} from 'neuroglancer/datasource/flyem/annotation';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {verifyObject, verifyObjectProperty, parseIntVec, verifyString} from 'neuroglancer/util/json';
import {vec3} from 'neuroglancer/util/geom';
import {AnnotationSourceParameters, AnnotationChunkSourceParameters} from 'neuroglancer/datasource/clio/base';
import {ClioToken, makeRequestWithCredentials, ClioInstance} from 'neuroglancer/datasource/clio/api';
import {ClioAnnotationFacade, ClioPointAnnotation, ClioAnnotation} from 'neuroglancer/datasource/clio/utils';
import {getAnnotationId, typeOfAnnotationId, isAnnotationIdValid} from 'neuroglancer/datasource/flyem/annotation';


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

function getPostionFromKey(key: string) {
  if (key) {
    let pos = key.split('_').map(x=>+x);
    if (pos.length === 3) {
      return vec3.fromValues(pos[0], pos[1], pos[2]);
    }
  }

  return null;
}

function parseAnnotation(key: string, entry: any): ClioAnnotation | null {
  if (entry) {
    const kind = verifyObjectProperty(entry, 'Kind', verifyString);
    let prop: { [key: string]: string } = {};
    let corner = getPostionFromKey(key);
    if (!corner) {
      const posKey = ('location' in entry) ? 'location' : 'Pos';
      corner = verifyObjectProperty(entry, posKey, x => parseIntVec(vec3.create(), x));
    }
    if ('Prop' in entry) {
      prop = verifyObjectProperty(entry, 'Prop', verifyObject);
    }

    let description = '';
    if ('description' in entry) {
      description = verifyObjectProperty(entry, 'description', verifyString);
    }

    let title = '';
    if ('title' in entry) {
      title = verifyObjectProperty(entry, 'title', verifyString);
    }

    let user = '';
    if ('user' in entry) {
      user = verifyObjectProperty(entry, 'user', verifyString);
    }

    let annotation: ClioPointAnnotation = {
      point: corner,
      type: AnnotationType.POINT,
      properties: [],
      kind,
      id: `${corner[0]}_${corner[1]}_${corner[2]}`,
      prop: {}
    };

    let annotationRef = new ClioAnnotationFacade(annotation);
    annotationRef.prop = prop;

    if (description) {
      annotationRef.presentation = description;
    }

    if (title) {
      annotationRef.title = title;
    }

    if (user) {
      annotationRef.user = user;
    }

    annotationRef.update();

    return annotation;
  }

  return null;
}

// const annotationPropertySerializer = new AnnotationPropertySerializer(3, []);

function parseAnnotations(
  source: ClioAnnotationSource|ClioAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any,
  propSpec: AnnotationPropertySpec[], emittingAddSignal: boolean) {
  const annotationPropertySerializer = new AnnotationPropertySerializer(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializer);
  if (responses) {
    let parseSingleAnnotation = (key: string, response: any, index: number, lastIndex: number) => {
      if (response) {
        try {
          let annotation = parseAnnotation(key, response);
          if (annotation) {
            if (index === lastIndex) {
              annotation.source = `downloaded:last`;
            } else {
              annotation.source = `downloaded:${index}/${lastIndex}`;
            }
            annotationStore.add(getAnnotationId(annotation), response);
            serializer.add(annotation);
            if (emittingAddSignal) {
              source.rpc!.invoke(ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID, {
                id: source.rpcId,
                newAnnotation: { ...annotation }
              });
            }
          }
        } catch (e) {
          console.log(`Error parsing annotation: ${e.message}`);
        }
      }
    };

    const {parameters} = source;
    const annotationCount = Object.keys(responses).length;
    Object.keys(responses).forEach((key, index) => {
      let response = responses[key];
      if (response) {
        if (!('Kind' in response)) {
          response['Kind'] = parameters.kind!;
        }
      }
      parseSingleAnnotation(key, response, index, annotationCount - 1);
    });
  }
  chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
}

// function getTopUrl(parameters: ClioSourceParameters) {
//   return `${parameters.baseUrl}`;
// }

// function getClioUrl(parameters: ClioSourceParameters, path: string) {
//   return getTopUrl(parameters) + path;
// }

/*
function getAnnotationEndpoint(parameters: ClioSourceParameters) {
  return parameters.kind === 'Atlas' ? 'atlas' : 'annotations';
}

function getElementsPath(parameters: ClioSourceParameters) {
  return `/${getAnnotationEndpoint(parameters)}/${parameters.dataset}`;
}

function getAnnotationPath(parameters: ClioSourceParameters, position: ArrayLike<number|string>) {
  return `${getElementsPath(parameters)}?x=${position[0]}&y=${position[1]}&z=${position[2]}`;
}

function getAnnotationUrl(parameters: ClioSourceParameters, position: ArrayLike<number|string>) {
  return getClioUrl(parameters, getAnnotationPath(parameters, position));
}
*/

@registerSharedObject() //
export class ClioAnnotationGeometryChunkSource extends (ClioSource(AnnotationGeometryChunkSourceBackend, AnnotationChunkSourceParameters)) {
  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    // let values: any[] = [];
    try {
      const clioInstance = new ClioInstance(this.parameters);
      let pointAnnotationValues = await makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'GET',
          url: clioInstance.getAllAnnotationsUrl(),
          payload: undefined,
          responseType: 'json',
        },
        cancellationToken);
      // values = [...pointAnnotationValues];

      return parseAnnotations(this, chunk, pointAnnotationValues, this.parameters.properties, true);
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

  private requestLineMetaData(id: AnnotationId, _: CancellationToken) {
    return Promise.resolve(annotationStore.getValue(id));
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
          chunk.annotation = parseAnnotation(chunk.key!, response);
        } else {
          chunk.annotation = null;
        }
      }
    )
  }

  private uploadable(annotation: Annotation){
    const { parameters } = this;

    if (parameters.user && parameters.user !== '') {
      if (annotation.type === AnnotationType.POINT) {
        if (parameters.kind === 'Atlas') {
          const annotationRef = new ClioAnnotationFacade(<ClioPointAnnotation>annotation);
          if (annotationRef.title) {
            return true;
          }
          return false;
        } else {
          return true;
        }
      }
    }

    return false;
  }

  private encodeAnnotation(annotation: ClioAnnotation, user: string | undefined): any {
    let obj: { [key: string]: any } = {
      Kind: annotation.kind, //todo: might not be necessary
    };

    let annotationRef = new ClioAnnotationFacade(annotation);

    if (annotationRef.presentation !== undefined) {
      obj.description = annotationRef.presentation;
    } else if (annotation.kind === 'Atlas') {
      obj.description = '';
    }

    if (annotationRef.title !== undefined) {
      obj.title = annotationRef.title;
    }

    if (user) {
      obj.user = user;
    }

    if (annotation.prop) {
      let prop = { ...annotation.prop };
      delete prop.comment;
      delete prop.user;
      delete prop.title;
      if (prop) {
        obj.Prop = prop;
      }
    }

    return obj;
  }

  private updateAnnotation(annotation: ClioAnnotation) {
    const { parameters } = this;
    const encoded = this.encodeAnnotation(annotation, parameters.user);
    let value = JSON.stringify(encoded);
    annotationStore.update(getAnnotationId(annotation), value);

    if (this.uploadable(annotation)) {
      const clioInstance = new ClioInstance(parameters);
      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'POST',
          url: clioInstance.getAnnotationUrl((<ClioPointAnnotation>annotation).point),
          payload: value,
          responseType: '',
        });
    } else {
      return Promise.resolve(getAnnotationId(annotation));
    }
  }

  private addAnnotation(annotation: ClioAnnotation) {
    return this.updateAnnotation(annotation)
      .then(() => {
        return getAnnotationId(annotation);
      })
      .catch(e => {
        throw new Error(e);
      });
  }


  add(annotation: Annotation) {
    return this.addAnnotation(<ClioAnnotation>annotation);
  }

  update(id: AnnotationId, annotation: Annotation) {
    if (getAnnotationId(<ClioAnnotation>annotation) !== id) {
      return this.updateAnnotation(<ClioAnnotation>annotation).then(() => this.delete(id));
    } else {
      return this.updateAnnotation(<ClioAnnotation>annotation);
    }
  }

  delete(id: AnnotationId) {
    if (isAnnotationIdValid(id)) {
      const clioInstance = new ClioInstance(this.parameters);
      switch (typeOfAnnotationId(id)) {
        case AnnotationType.POINT:
          annotationStore.remove(id);
          return makeRequestWithCredentials(
            this.credentialsProvider,
            {
              method: 'DELETE',
              url: clioInstance.getAnnotationUrl(id.split('_')),
              // url: getAnnotationUrl(parameters, id.split('_')),
              responseType: ''
            });
        case AnnotationType.LINE:
          annotationStore.remove(id);
          return Promise.resolve(id);
        default:
          throw new Error(`Invalid annotation ID for DVID: ${id}`)
      }
    } else {
      return Promise.resolve(null);
    }
  }
}
