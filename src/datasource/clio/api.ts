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

import type { FlyEMToken } from "#src/datasource/flyem/api.js";
import { fetchWithFlyEMCredentials } from "#src/datasource/flyem/api.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type { ClioSourceParameters } from "#src/datasource/clio/base.js";

export type ClioToken = FlyEMToken;

export const credentialsKey = "Clio";

const urlPattern = /^([^/]+:\/\/[^/]+)\/([^/]+)\/([^//?]+)(\?.*)?$/;

function parseDVIDSourceUrl(url: string): {
  baseUrl: string;
  nodeKey: string;
  dataInstanceKey: string;
} {
  const match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  return {
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };
}

export function parseGrayscaleUrl(source: string): {
  protocol: string;
  host: string;
  path: string;
} {
  let protocolMatch = source.match(/^([a-z]+):\/\/(.*)$/);
  if (protocolMatch) {
    const protocol = protocolMatch[1];
    const rest = protocolMatch[2];
    if (protocol === "precomputed") {
      protocolMatch = rest.match(/^([a-z]+):\/\/(.*)$/);
      if (protocolMatch) {
        const innerProtocol = protocolMatch[1];
        const innerRest = protocolMatch[2];
        const slashIndex = innerRest.indexOf("/");
        return {
          protocol: innerProtocol,
          host: slashIndex !== -1 ? innerRest.slice(0, slashIndex) : innerRest,
          path: slashIndex !== -1 ? innerRest.slice(slashIndex) : "",
        };
      }
    }
    const slashIndex = rest.indexOf("/");
    return {
      protocol,
      host: slashIndex !== -1 ? rest.slice(0, slashIndex) : rest,
      path: slashIndex !== -1 ? rest.slice(slashIndex) : "",
    };
  }
  return { protocol: "", host: source, path: "" };
}

export function getGrayscaleInfoUrl(u: {
  protocol: string;
  host: string;
  path: string;
}): string {
  const { protocol, host, path } = u;
  switch (protocol) {
    case "gs":
      return `https://storage.googleapis.com/${host}${path}/info`;
    case "dvid": {
      const sourceParameters = parseDVIDSourceUrl(host + path);
      return `${sourceParameters.baseUrl}/api/node/${sourceParameters.nodeKey}/${sourceParameters.dataInstanceKey}/info`;
    }
    case "https":
      return `${protocol}://${host}${path}/info`;
    default:
      throw Error("Unrecognized volume information");
  }
}

export class ClioInstance {
  constructor(public parameters: ClioSourceParameters) {}

  getTopLevelUrl(): string {
    const { baseUrl, api } = this.parameters;
    return `${baseUrl}/${api || "clio_toplevel"}`;
  }

  getDatasetsUrl(): string {
    return `${this.getTopLevelUrl()}/datasets`;
  }

  getGrayscaleInfoUrl(): string {
    const u = parseGrayscaleUrl(this.parameters.grayscale!);
    return getGrayscaleInfoUrl(u);
  }

  getAnnotationEndpoint(): string {
    return this.parameters.kind === "Atlas" ? "atlas" : "annotations";
  }

  getAnnotationEntryUrl(): string {
    return `${this.getTopLevelUrl()}/${this.getAnnotationEndpoint()}/${this.parameters.dataset}`;
  }

  getAllAnnotationsUrl(): string {
    return (
      this.getAnnotationEntryUrl() +
      (this.parameters.groups
        ? `?groups=${this.parameters.groups}`
        : "")
    );
  }

  hasPointQueryApi(): boolean {
    return (
      this.parameters.api === "clio_toplevel" ||
      this.parameters.kind === "Atlas"
    );
  }

  getPostAnnotationUrl(position: ArrayLike<number | string>): string {
    if (this.hasPointQueryApi()) {
      return `${this.getAnnotationEntryUrl()}?x=${position[0]}&y=${position[1]}&z=${position[2]}`;
    }

    return this.getAnnotationEntryUrl();
  }

  getDeleteAnnotationUrl(id: string): string {
    if (this.hasPointQueryApi()) {
      const tokens = id.match(/(-?\d+)_(-?\d+)_(-?\d+)/);
      if (tokens) {
        return this.getAnnotationUrl(tokens.slice(1, 4));
      }
    }

    return `${this.getAnnotationEntryUrl()}/${id}`;
  }

  getAnnotationUrl(position: ArrayLike<number | string>): string {
    return `${this.getAnnotationEntryUrl()}?x=${position[0]}&y=${position[1]}&z=${position[2]}`;
  }
}

export function fetchWithClioCredentials(
  credentialsProvider: CredentialsProvider<ClioToken>,
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetchWithFlyEMCredentials(credentialsProvider, input, init);
}
