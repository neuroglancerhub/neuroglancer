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

import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  AnonymousFirstCredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import { getCredentialsWithStatus } from "#src/credentials_provider/interactive_credentials_provider.js";
import { fetchOk } from "#src/util/http_request.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export type DefaultTokenType = string;

export interface FlyEMToken {
  token?: string;
}

export const flyEMCredentialsKey = "FlyEM";

interface NeurohubWindow {
  neurohub: {
    clio: {
      auth: {
        getAuthResponse: () => { id_token: DefaultTokenType };
      };
    };
  };
}

function getNeurohubToken(w: any): Promise<string> {
  if ("neurohub" in w) {
    return Promise.resolve(
      (<NeurohubWindow>(<unknown>w)).neurohub.clio.auth
        .getAuthResponse()
        .id_token,
    );
  }
  return Promise.resolve("");
}

async function getAuthTokenFromServer(
  authServer: string,
  signal: AbortSignal,
): Promise<FlyEMToken> {
  if (!authServer) {
    return { token: "" };
  }
  if (authServer.startsWith("token:")) {
    return { token: authServer.substring(6) };
  }
  if (authServer === "neurohub") {
    const token = await getNeurohubToken(window);
    return { token };
  }
  const response = await fetchOk(authServer, {
    method: "GET",
    credentials: "include",
    signal,
  });
  const token = await response.text();
  return { token };
}

class BaseFlyEMCredentialsProvider extends CredentialsProvider<FlyEMToken> {
  constructor(public authServer: string | undefined) {
    super();
  }

  get = makeCredentialsGetter(async (options) => {
    const { authServer } = this;
    if (!authServer) return { token: "" };
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting FlyEM access token from ${authServer}`,
    });
    return await getCredentialsWithStatus(
      {
        description: `FlyEM server ${this.authServer}`,
        supportsImmediate: true,
        get: async (signal, immediate) => {
          if (immediate) {
            return await getAuthTokenFromServer(authServer, signal);
          }
          throw new Error(
            `Please check your authorization server ${authServer} to make sure it is correct.`,
          );
        },
      },
      options.signal,
    );
  });
}

export class FlyEMCredentialsProvider extends AnonymousFirstCredentialsProvider<FlyEMToken> {
  constructor(authServer: string | undefined) {
    super(new BaseFlyEMCredentialsProvider(authServer), {});
  }
}

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
