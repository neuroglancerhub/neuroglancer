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

import {
  fetchOk,
  HttpError,
  type RequestInitWithProgress,
} from "#src/util/http_request.js";
import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { StatusMessage } from "#src/status.js";

export type DefaultTokenType = string;

interface HttpCall {
  method: "GET" | "POST" | "DELETE" | "HEAD";
  url: string;
  payload?: string;
}

export function responseText(response: Response): Promise<string> {
  return response.text();
}

export function responseJson(response: Response): Promise<any> {
  return response.json();
}

export function responseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  return response.arrayBuffer();
}

export function makeRequest(
  httpCall: HttpCall & { responseType: "arraybuffer" },
  options?: Partial<ProgressOptions>,
): Promise<ArrayBuffer>;

export function makeRequest(
  httpCall: HttpCall & { responseType: "json" },
  options?: Partial<ProgressOptions>,
): Promise<any>;

export function makeRequest(
  httpCall: HttpCall & { responseType: "" },
  options?: Partial<ProgressOptions>,
): Promise<string>;

export async function makeRequest(
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  options?: Partial<ProgressOptions>,
): Promise<any> {
  const requestInfo = httpCall.url;
  const init: RequestInitWithProgress = {
    method: httpCall.method,
    body: httpCall.payload,
    signal: options?.signal,
    progressListener: options?.progressListener,
  };

  const response = await fetchOk(requestInfo, init);

  if (httpCall.responseType === "") {
    return responseText(response);
  } else if (httpCall.responseType === "arraybuffer") {
    return responseArrayBuffer(response);
  } else {
    return responseJson(response);
  }
}

export function makeRequestWithCredentials<TToken>(
  credentialsProvider: CredentialsProvider<TToken>,
  httpCall: HttpCall & { responseType: "arraybuffer" },
  options?: Partial<ProgressOptions>,
): Promise<ArrayBuffer>;

export function makeRequestWithCredentials<TToken>(
  credentialsProvider: CredentialsProvider<TToken>,
  httpCall: HttpCall & { responseType: "json" },
  options?: Partial<ProgressOptions>,
): Promise<any>;

export function makeRequestWithCredentials<TToken>(
  credentialsProvider: CredentialsProvider<TToken>,
  httpCall: HttpCall & { responseType: "" },
  options?: Partial<ProgressOptions>,
): Promise<string>;

export async function makeRequestWithCredentials<TToken>(
  credentialsProvider: CredentialsProvider<TToken>,
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  options?: Partial<ProgressOptions>,
): Promise<any> {
  const requestInit: RequestInitWithProgress = {
    method: httpCall.method,
    body: httpCall.payload,
    signal: options?.signal,
    progressListener: options?.progressListener,
  };
  if (requestInit.method === "POST") {
    // Only supports posting json
    requestInit.headers = {
      "Content-Type": "application/json",
    };
  }

  const response = await fetchOkWithCredentials(
    credentialsProvider,
    httpCall.url,
    requestInit,
    applyCredentials(httpCall.url),
    (error) => {
      const { status } = error;
      if (status === 403 || status === 401) {
        // Authorization needed. Retry with refreshed token.
        return "refresh";
      }
      throw error;
    },
  );

  if (httpCall.responseType === "") {
    return responseText(response);
  } else if (httpCall.responseType === "arraybuffer") {
    return responseArrayBuffer(response);
  } else {
    return responseJson(response);
  }
}

function applyCredentials<TToken>(input: string) {
  return (credentials: TToken, init: RequestInitWithProgress) => {
    const newInit: RequestInitWithProgress = { ...init };

    if (credentials) {
      newInit.headers = {
        ...newInit.headers,
        Authorization: `Bearer ${credentials}`,
      };
    } else if (input.startsWith("https:")) {
      // DVID https without credentials provided expects credentials stored in the browser
      newInit.credentials = "include";
    }

    return newInit;
  };
}

interface AuthResponse {
  id_token: DefaultTokenType;
}

interface AuthResponseProvider {
  getAuthResponse: () => AuthResponse;
}

interface AuthClient {
  auth: AuthResponseProvider;
}

interface ClioNeurohub {
  clio: AuthClient;
}

interface NeurohubWindow {
  neurohub: ClioNeurohub;
}

const DEBUG_NEUROHUB_CREDENTIALS = false;

const mockWindow: NeurohubWindow = {
  neurohub: {
    clio: {
      auth: {
        getAuthResponse: () => {
          return { id_token: "<test-token>" };
        },
      },
    },
  },
};

function getNeurohubToken(w: any) {
  if ("neurohub" in w) {
    return Promise.resolve(
      (<NeurohubWindow>(<unknown>w)).neurohub.clio.auth.getAuthResponse()
        .id_token,
    );
  } else {
    return Promise.resolve("");
  }
}

export class FlyEMCredentialsProvider<Token> extends CredentialsProvider<Token> {
  constructor(
    public authServer: string,
    private retry?: () => void,
  ) {
    super();
  }

  private async getAuthToken(
    authServer: string,
    options?: Partial<ProgressOptions>,
  ): Promise<string> {
    if (!authServer) {
      return "";
    } else if (authServer.startsWith("token:")) {
      return authServer.substring(6);
    } else if (authServer === "neurohub") {
      return getNeurohubToken(
        DEBUG_NEUROHUB_CREDENTIALS ? mockWindow : window,
      );
    } else {
      const init: RequestInitWithProgress = {
        method: "GET",
        headers: new Headers(),
        signal: options?.signal,
        progressListener: options?.progressListener,
      };
      try {
        const response = await fetchOk(authServer, init);
        return responseText(response);
      } catch {
        // Retry without custom headers
        const retryInit: RequestInitWithProgress = {
          method: "GET",
          signal: options?.signal,
          progressListener: options?.progressListener,
        };
        const response = await fetchOk(authServer, retryInit);
        return responseText(response);
      }
    }
  }

  get = makeCredentialsGetter((options: ProgressOptions) => {
    const status = new StatusMessage(/*delay=*/ true);
    let abortController: AbortController | undefined;

    return new Promise<Token>((resolve, reject) => {
      const dispose = () => {
        abortController = undefined;
        status.dispose();
      };

      // Handle abort signal from options
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          if (abortController !== undefined) {
            abortController.abort(options.signal!.reason);
            abortController = undefined;
            status.dispose();
            reject(options.signal!.reason);
          }
        });
      }

      const writeLoginStatus = (
        msg = "Authorization required.",
        linkMessage = "Request authorization.",
      ) => {
        status.setText(msg + " ");
        if (this.retry) {
          const button = document.createElement("button");
          button.textContent = linkMessage;
          status.element.appendChild(button);
          button.addEventListener("click", this.retry);
        }
        status.setVisible(true);
      };

      const authServer = this.authServer;
      const login = () => {
        if (abortController !== undefined) {
          abortController.abort();
        }
        abortController = new AbortController();
        writeLoginStatus("Waiting for authorization...", "Retry");

        this.getAuthToken(authServer, { signal: abortController.signal }).then(
          (token) => {
            if (abortController !== undefined) {
              dispose();
              resolve(token as Token);
            }
          },
          (reason) => {
            if (abortController !== undefined) {
              abortController = undefined;
              writeLoginStatus(`Authorization failed: ${reason}.`, "Retry");
            }
          },
        );
      };
      login();
    });
  });
}
