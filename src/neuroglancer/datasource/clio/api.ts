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
import {responseJson, responseArrayBuffer, ResponseTransform} from 'neuroglancer/util/http_request';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';

export type ClioToken = string;

export const credentialsKey = 'Clio';

interface HttpCall {
  method: 'GET' | 'POST' | 'DELETE' | 'HEAD';
  url: string;
  payload?: string;
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
      throw Error(`No credentials provided ${input ? 'for input' : ''}`)
    }

    let newInit: RequestInit = { ...init };

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