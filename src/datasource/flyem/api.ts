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

/**
 * @file Backend-safe FlyEM API helpers.
 *
 * Everything here must remain free of DOM access so that it can be included in
 * the chunk worker bundle. The interactive credentials provider lives in
 * #src/datasource/flyem/credentials_provider.js.
 */

import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";

export type DefaultTokenType = string;

export interface FlyEMToken {
  token?: string;
}

export const flyEMCredentialsKey = "FlyEM";

export function fetchWithFlyEMCredentials(
  credentialsProvider: CredentialsProvider<FlyEMToken>,
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetchOkWithCredentials(
    credentialsProvider,
    input,
    init,
    (credentials: FlyEMToken, init: RequestInit) => {
      const newInit: RequestInit = { ...init };
      if (credentials.token) {
        newInit.headers = {
          ...newInit.headers,
          Authorization: `Bearer ${credentials.token}`,
        };
      } else if (input.startsWith("https:")) {
        newInit.credentials = "include";
      }
      return newInit;
    },
    (error) => {
      const { status } = error;
      if (status === 403 || status === 401) {
        return "refresh";
      }
      throw error;
    },
  );
}
