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
import {ANNOTAIION_COMMIT_ADD_SIGNAL_RPC_ID} from 'neuroglancer/annotation/base';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {parseAnnotation as parseDvidAnnotation} from 'neuroglancer/datasource/dvid/backend';
import {verifyObject, verifyObjectProperty, parseIntVec, verifyString, verifyBoolean} from 'neuroglancer/util/json';
import {vec3} from 'neuroglancer/util/geom';
import {AnnotationSourceParameters, AnnotationChunkSourceParameters} from 'neuroglancer/datasource/clio/base';
import {ClioToken, makeRequestWithCredentials, ClioInstance} from 'neuroglancer/datasource/clio/api';
import {ClioPointAnnotation, ClioLineAnnotation, ClioAnnotation, ClioPointAnnotationFacade, ClioLineAnnotationFacade, ClioAnnotationFacade, getAnnotationDescription, typeOfAnnotationId, getAnnotationId} from 'neuroglancer/datasource/clio/utils';

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

  contains(id: string) {
    return this.store.has(id);
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

function makeLineAnnotation(prop: any, startPos: vec3, endPos: vec3, kind: string|undefined, title?: string, description?: string, user?: string) {
  let annotation: ClioLineAnnotation = {
    pointA: startPos,
    pointB: endPos,
    type: AnnotationType.LINE,
    properties: [],
    kind,
    id: '',
    prop: {}
  };

  annotation.id = getAnnotationId(annotation);

  let annotationRef = new ClioLineAnnotationFacade(annotation);
  annotationRef.prop = prop;

  if (description) {
    annotationRef.description = description;
  }

  if (title) {
    annotationRef.title = title;
  }

  if (user) {
    annotationRef.user = user;
  }

  annotation.description = getAnnotationDescription(annotation);

  return annotation;
}

function makePointAnnotation(prop: any, pos: vec3, kind?: string, title?: string, description?: string, user?: string) {
  let annotation: ClioPointAnnotation = {
    point: pos,
    type: AnnotationType.POINT,
    properties: [],
    kind,
    id: '',
    prop: {}
  };

  annotation.id = getAnnotationId(annotation);

  let annotationRef = new ClioPointAnnotationFacade(annotation);
  annotationRef.prop = prop;

  if (description) {
    annotationRef.description = description;
  }

  if (title) {
    annotationRef.title = title;
  }

  if (user) {
    annotationRef.user = user;
  }

  annotation.description = getAnnotationDescription(annotation);

  return annotation;
}

function encodeV2Helper(annotation: ClioAnnotation) {
  let obj: { [key: string]: any } = {
    tags: []
  };

  let annotationRef = new ClioAnnotationFacade(annotation);

  const prop = { ...annotation.prop };

  if (annotation.kind === 'Atlas') {
    obj.description = annotationRef.description || '';
  } else if (annotationRef.description !== undefined) {
    obj.description = annotationRef.description;
  }

  if (annotationRef.checked) {
    obj.verified = annotationRef.checked;
  }

  obj.user = prop.user;
  delete prop.user;

  if (annotationRef.title !== undefined) {
    obj.title = annotationRef.title;
  }

  delete prop.comment;
  delete prop.title;
  if (prop) {
    obj.prop = prop;
  }

  return obj;
};

const encoder: any = {
  v1: {
    point: (annotation: ClioPointAnnotation) => {
      let obj: { [key: string]: any } = {
        Kind: annotation.kind, //todo: might not be necessary
      };

      let annotationRef = new ClioPointAnnotationFacade(annotation);

      const prop = { ...annotation.prop };
      if (annotation.kind === 'Atlas') {
        obj.description = annotationRef.description || '';
        delete prop.comment;
      }

      if (annotationRef.description !== undefined) {
        obj.description = annotationRef.description;
      }

      if (annotationRef.title !== undefined) {
        obj.title = annotationRef.title;
      }

      if (annotationRef.user) {
        obj.user = annotationRef.user;
      }

      delete prop.user;
      delete prop.title;
      if (prop) {
        obj.Prop = prop;
      }

      return obj;
    }, //point
  }, //v1
  v2: {
    point: (annotation: ClioPointAnnotation) => {
      const obj = encodeV2Helper(annotation);
      obj.kind = 'point';
      obj.pos = [annotation.point[0], annotation.point[1], annotation.point[2]];

      return obj;
    }, //point
    lineseg: (annotation: ClioLineAnnotation) =>  {
      const obj = encodeV2Helper(annotation);
      obj.kind = 'lineseg';
      obj.pos = [annotation.pointA[0], annotation.pointA[1], annotation.pointA[2], annotation.pointB[0], annotation.pointB[1], annotation.pointB[2]];
      return obj;
    }, //line
  }, //v2
};

encoder.v1.lineseg = encoder.v2.lineseg;
encoder.v1[AnnotationType.POINT] = encoder.v1.point;
encoder.v1[AnnotationType.LINE] = encoder.v1.lineseg;
encoder.clio_toplevel = encoder.v1;

encoder.v2[AnnotationType.POINT] = encoder.v2.point;
encoder.v2[AnnotationType.LINE] = encoder.v2.lineseg;

function getEncoder (api: string|undefined, kind: string|AnnotationType|undefined) {
  return encoder[api || 'v1'][kind || AnnotationType.POINT];
}

const decoder: any = {
  v1: {
    point: (key: string, entry: any) => {
      const kind = verifyObjectProperty(entry, 'Kind', verifyString);
      if (kind === 'Note') {
        return parseDvidAnnotation(entry) as ClioAnnotation;
      } else {
        let prop: { [key: string]: string } = {};
        let corner = getPostionFromKey(key);
        if (!corner) {
          const posKey = ('location' in entry) ? 'location' : 'Pos';
          corner = verifyObjectProperty(entry, posKey, x => parseIntVec(vec3.create(), x));
        }
        if ('Prop' in entry) {
          prop = verifyObjectProperty(entry, 'Prop', verifyObject);
        } else if ('prop' in entry) {
          prop = verifyObjectProperty(entry, 'prop', verifyObject);
        }

        let description = '';
        if ('description' in entry) {
          description = verifyObjectProperty(entry, 'description', verifyString);
        } else if ('comment' in prop) {
          description = verifyObjectProperty(prop, 'comment', verifyString);
        }

        let title = '';
        if ('title' in entry) {
          title = verifyObjectProperty(entry, 'title', verifyString);
        }

        let user = '';
        if ('user' in entry) {
          user = verifyObjectProperty(entry, 'user', verifyString);
        } else if (prop.user) {
          user = prop.user;
        }

        return makePointAnnotation(prop, corner, kind, title, description, user);
      }
    }, //point
  }, //v1
  v2: {
    point: (_: string, entry: any) => {
      return parseAnnotationV2(entry);
    },
    lineseg: (_: string, entry: any) => {
      return parseAnnotationV2(entry);
    }
  }, //v2
};

decoder.v1.lineseg = decoder.v2.lineseg;
decoder.v1[AnnotationType.POINT] = decoder.v1.point;
decoder.v1[AnnotationType.LINE] = decoder.v1.lineseg;
decoder.clio_toplevel = decoder.v1;

decoder.v2[AnnotationType.POINT] = decoder.v2.point;
decoder.v2[AnnotationType.LINE] = decoder.v2.lineseg;

function getDecoder (api: string|undefined, kind: string|AnnotationType|undefined) {
  return decoder[api || 'v1'][kind || AnnotationType.POINT];
}

function parseAnnotationV2(entry: any) : ClioAnnotation|null {
  let prop: { [key: string]: string } = {};

  //{"kind":"lineseg","tags":[],"pos":[15863,11100,13312,15963,11200,13412],"prop":{"user":"zhaot@hhmi.org","timestamp":"1611066453198"},"Kind":"Normal"}

  const kind = verifyObjectProperty(entry, 'kind', verifyString);
  const pos = entry['pos'];

  if ('prop' in entry) {
    prop = verifyObjectProperty(entry, 'prop', verifyObject);
  }

  let description = '';
  if (entry.description) {
    description = verifyObjectProperty(entry, 'description', verifyString);
  }

  let title = '';
  if (entry.title) {
    title = verifyObjectProperty(entry, 'title', verifyString);
  }

  let user = '';
  if (entry.user) {
    user = verifyObjectProperty(entry, 'user', verifyString);
  }

  const group = verifyObjectProperty(entry, 'Kind', verifyString);

  const startPos = vec3.fromValues(pos[0], pos[1], pos[2]);
  if (kind === 'lineseg') {
    const endPos = vec3.fromValues(pos[3], pos[4], pos[5]);
    return makeLineAnnotation(prop, startPos, endPos, group, title, description, user);
  }

  const annotation = makePointAnnotation(prop, startPos, group, title, description, user);
  if ('verified' in entry) {
    (new ClioPointAnnotationFacade(annotation)).checked = verifyObjectProperty(entry, 'verified', verifyBoolean);
  }

  return annotation;
}
/*
function parseAnnotation(key: string, entry: any, api: string|undefined) : ClioAnnotation|null {
  if (entry) {
    if (api === 'v2') {
      const annotation = parseAnnotationV2(entry);
      if (annotation) {
        annotation.key = key;
      }
      return annotation;
    }

    const kind = verifyObjectProperty(entry, 'Kind', verifyString);
    if (kind === 'Note') {
      return parseDvidAnnotation(entry) as ClioAnnotation;
    } else {
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

      return makePointAnnotation(prop, corner, undefined, title, description, user);
    }
  }

  return null;
}
*/

// const annotationPropertySerializer = new AnnotationPropertySerializer(3, []);

function parseAnnotations(
  source: ClioAnnotationSource|ClioAnnotationGeometryChunkSource,
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk, responses: any,
  propSpec: AnnotationPropertySpec[], api: string|undefined, emittingAddSignal: boolean) {
  const annotationPropertySerializer = new AnnotationPropertySerializer(3, propSpec);
  const serializer = new AnnotationSerializer(annotationPropertySerializer);
  if (responses) {
    let parseSingleAnnotation = (key: string, response: any, index: number, lastIndex: number) => {
      if (response) {
        try {
          let kind = response.kind || 'point';
          let annotation = getDecoder(api, kind)(key, response);
          // let annotation = parseAnnotation(key, response, api);
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

      return parseAnnotations(this, chunk, pointAnnotationValues, this.parameters.properties, this.parameters.api, true);
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
          chunk.annotation = getDecoder(this.parameters.api,response.kind)(chunk.key!, response);
          // chunk.annotation = parseAnnotation(chunk.key!, response, this.parameters.api);
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
          const annotationRef = new ClioPointAnnotationFacade(<ClioPointAnnotation>annotation);
          if (annotationRef.title) {
            return true;
          }
          return false;
        } else {
          return true;
        }
      } else if (annotation.type == AnnotationType.LINE) {
        if (parameters.api === 'v2' && parameters.kind !== 'Atlas') {
          return true;
        }
      }
    }

    return false;
  }

  /*
  private encodePointAnnotationV2(annotation: ClioPointAnnotation): any {
    let obj: { [key: string]: any } = {
      kind: 'point',
      tags: [],
      pos: [annotation.point[0], annotation.point[1], annotation.point[2]]
    };
    let annotationRef = new ClioPointAnnotationFacade(annotation);

    if (annotationRef.description !== undefined) {
      obj.description = annotationRef.description;
    } else if (annotation.kind === 'Atlas') {
      obj.description = '';
    }

    if (annotationRef.title !== undefined) {
      obj.title = annotationRef.title;
    }

    if (annotation.prop) {
      let prop = { ...annotation.prop };
      delete prop.comment;
      // delete prop.user;
      delete prop.title;
      if (prop) {
        obj.prop = prop;
      }
    }

    return obj;
  }

  private encodeLineAnnotationV2(annotation: ClioLineAnnotation): any {
    let obj: { [key: string]: any } = {
      kind: 'lineseg',
      tags: [],
      pos: [annotation.pointA[0], annotation.pointA[1], annotation.pointA[2], annotation.pointB[0], annotation.pointB[1], annotation.pointB[2]]
    };
    let annotationRef = new ClioLineAnnotationFacade(annotation);

    if (annotationRef.description !== undefined) {
      obj.description = annotationRef.description;
    }

    if (annotationRef.title !== undefined) {
      obj.title = annotationRef.title;
    }

    if (annotation.prop) {
      let prop = { ...annotation.prop };
      delete prop.comment;
      // delete prop.user;
      delete prop.title;
      if (prop) {
        obj.prop = prop;
      }
    }

    return obj;
  }

  private encodeAnnotationV2(annotation: ClioAnnotation): any {
    if (annotation.type === AnnotationType.POINT) {
      return this.encodePointAnnotationV2(annotation);
    } else {
      return this.encodeLineAnnotationV2(annotation);
    }
  }

  private encodeAnnotationV1(annotation: ClioAnnotation, user: string|undefined) {
    if (annotation.kind === 'Note' || annotation.type === AnnotationType.LINE) {
      return annotationToDVID(annotation, user);
    } else {
      let obj: { [key: string]: any } = {
        Kind: annotation.kind, //todo: might not be necessary
      };

      let annotationRef = new ClioPointAnnotationFacade(annotation);

      if (annotationRef.description !== undefined) {
        obj.description = annotationRef.description;
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
        let prop = {...annotation.prop};
        delete prop.comment;
        delete prop.user;
        delete prop.title;
        if (prop) {
          obj.Prop = prop;
        }
      }

      return obj;
    }
  }

  private encodeAnnotation(annotation: ClioAnnotation, user: string | undefined, api?: string): any {
    if (api === 'v2') {
      return this.encodeAnnotationV2(annotation);
    } else {
      return this.encodeAnnotationV1(annotation, user);
    }
  }
  */

  private updateAnnotation(annotation: ClioAnnotation) {
    const { parameters } = this;
    const encoded = getEncoder(parameters.api, annotation.type)(annotation);
    // const encoded = this.encodeAnnotation(annotation, parameters.user, parameters.api);
    let value = JSON.stringify(encoded);

    if (this.uploadable(annotation)) {
      const clioInstance = new ClioInstance(parameters);
      const pos = (<ClioPointAnnotation>annotation).point;
      const url = clioInstance.getPostAnnotationUrl(pos);

      return makeRequestWithCredentials(
        this.credentialsProvider,
        {
          method: 'POST',
          url,
          payload: value,
          responseType: '',
        }).then(response => {
          annotationStore.update(getAnnotationId(annotation), value);
          return response;
        });
    } else {
      annotationStore.update(getAnnotationId(annotation), value);
      return Promise.resolve(getAnnotationId(annotation));
    }
  }

  private addAnnotation(annotation: ClioAnnotation) {
    return this.updateAnnotation(annotation)
      .then((response) => {
        console.log(response);
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

  makeDeleteRequest(id: AnnotationId) {
    const clioInstance = new ClioInstance(this.parameters);
    return makeRequestWithCredentials(
      this.credentialsProvider,
      {
        method: 'DELETE',
        url: clioInstance.getDeleteAnnotationUrl(id),
        responseType: ''
      }).then(response => {
        annotationStore.remove(id);
        return response;
      });
  }

  delete(id: AnnotationId) {
    if (annotationStore.contains(id)) {
      switch (typeOfAnnotationId(id)) {
        case AnnotationType.POINT:
          return this.makeDeleteRequest(id);
        case AnnotationType.LINE:
          if (this.parameters.api === 'v2' && this.parameters.kind !== 'Atlas') {
            return this.makeDeleteRequest(id);
          } else {
            annotationStore.remove(id);
            return Promise.resolve(id);
          }
        default:
          throw new Error(`Invalid annotation ID for DVID: ${id}`)
      }
    } else {
      return Promise.resolve(null);
    }
  }
}
