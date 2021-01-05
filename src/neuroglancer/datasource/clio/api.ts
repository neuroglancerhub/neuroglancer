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

import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {responseJson, responseArrayBuffer, ResponseTransform, parseUrl} from 'neuroglancer/util/http_request';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
// import {parseSourceUrl as parseDVIDSourceUrl} from 'neuroglancer/datasource/dvid/frontend';
import {ClioSourceParameters} from 'neuroglancer/datasource/clio/base';

export type ClioToken = string;

export const credentialsKey = 'Clio';

interface HttpCall {
  method: 'GET' | 'POST' | 'DELETE' | 'HEAD';
  url: string;
  payload?: string;
}

const urlPattern = /^([^\/]+:\/\/[^\/]+)\/([^\/]+)\/([^\/\?]+)(\?.*)?$/;
function parseDVIDSourceUrl(url: string): { baseUrl: string, nodeKey: string, dataInstanceKey: string } {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  return {
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };
}

export function getGrayscaleInfoUrl(u: {protocol: string, host: string, path: string}): string {
  if (u.protocol === 'gs') {
    return `https://storage.googleapis.com/${u.host}${u.path}/info`;
  }else if (u.protocol === 'dvid') {
    const sourceParameters = parseDVIDSourceUrl(u.host + u.path);
    return `${sourceParameters.baseUrl}/api/node/${sourceParameters.nodeKey}/${sourceParameters.dataInstanceKey}/info`;
  }

  throw Error("Unrecognized volume information");
}

export class ClioInstance {
  constructor(public parameters: ClioSourceParameters) {}

  getTopLevelUrl(): string {
    return this.parameters.apiVersion > 1 ? this.parameters.baseUrl : `${this.parameters.baseUrl}/clio_toplevel`;
  }

  getDatasetsUrl(): string {
    return `${this.getTopLevelUrl()}/datasets`;
  }

  getGrayscaleInfoUrl(): string {
    const u = parseUrl(this.parameters.grayscale!);

    return getGrayscaleInfoUrl(u);
  }

  getAnnotationEndpoint(): string {
    return this.parameters.kind === 'Atlas' ? 'atlas' : 'annotations';
  }

  getAnnotationEntryUrl(): string {
    return `${this.getTopLevelUrl()}/${this.getAnnotationEndpoint()}/${this.parameters.dataset}`;
  }
  getAllAnnotationsUrl(): string {
    return this.getAnnotationEntryUrl();
  }

  getAnnotationUrl(position: ArrayLike<number|string>): string {
    return `${this.getAnnotationEntryUrl()}?x=${position[0]}&y=${position[1]}&z=${position[2]}`;
  }
}

export function responseText(response: Response): Promise<any> {
  return response.text();
}

export function makeRequestWithCredentials(
  credentialsProvider: CredentialsProvider<ClioToken>,
  httpCall: HttpCall & { responseType: 'arraybuffer' },
  cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequestWithCredentials(
  credentialsProvider: CredentialsProvider<ClioToken>,
  httpCall: HttpCall & { responseType: 'json' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
  credentialsProvider: CredentialsProvider<ClioToken>,
  httpCall: HttpCall & { responseType: '' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
  credentialsProvider: CredentialsProvider<ClioToken>,
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
    return fetchWithClioCredentials(
      credentialsProvider,
      httpCall.url,
      { method: httpCall.method, body: httpCall.payload },
      httpCall.responseType === '' ? responseText : (httpCall.responseType === 'json' ? responseJson : responseArrayBuffer),
      cancellationToken
    );
}

function  applyCredentials(input?: string) {
  return (credentials: ClioToken, init: RequestInit) => {
    if (credentials === undefined || credentials === null) {
      throw Error(`No credentials provided ${input} ? 'for input' : ''}`)
    }

    let newInit: RequestInit = { ...init };
    newInit.headers = { ...newInit.headers };

    if (credentials) {
      newInit.headers = { ...newInit.headers, Authorization: `Bearer ${credentials}` };
    }
    return newInit;
  }
}

export function fetchWithClioCredentials<T>(
  credentialsProvider: CredentialsProvider<ClioToken>,
  input: string,
  init: RequestInit,
  transformResponse: ResponseTransform<T>,
  cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  return fetchWithCredentials(
    credentialsProvider, input, init, transformResponse,
    applyCredentials(input),
    error => {
      const { status } = error;
      if (status === 403 || status === 401) {
        // Authorization needed.  Retry with refreshed token.
        return 'refresh';
      }
      if (status === 504) {
        // Gateway timeout can occur if the server takes too long to reply.  Retry.
        return 'retry';
      }
      throw error;
    },
    cancellationToken);
}