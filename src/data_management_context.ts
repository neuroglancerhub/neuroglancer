/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { FrameNumberCounter } from "#src/chunk_manager/frontend.js";
import {
  CapacitySpecification,
  ChunkManager,
  ChunkQueueManager,
} from "#src/chunk_manager/frontend.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import { RPC } from "#src/worker_rpc.js";

// Global configuration for worker URLs (set by consuming apps via Viewer bundleRoot option)
declare global {
  interface Window {
    __NEUROGLANCER_CHUNK_WORKER_URL__?: string;
  }
}

export class DataManagementContext extends RefCounted {
  worker: Worker;
  chunkQueueManager: ChunkQueueManager;
  chunkManager: ChunkManager;

  get rpc(): RPC {
    return this.chunkQueueManager.rpc!;
  }

  constructor(
    public gl: GL,
    public frameNumberCounter: FrameNumberCounter,
  ) {
    super();
    // For library builds, the global __NEUROGLANCER_CHUNK_WORKER_URL__ can be set
    // (via Viewer's bundleRoot option) to point to where the worker bundle is served.
    if (
      typeof window !== "undefined" &&
      window.__NEUROGLANCER_CHUNK_WORKER_URL__
    ) {
      this.worker = new Worker(window.__NEUROGLANCER_CHUNK_WORKER_URL__, {
        type: "module",
      });
    } else {
      // Note: For compatibility with multiple bundlers, a browser-compatible URL
      // must be used with `new URL`, which means a Node.js subpath import like
      // "#src/chunk_worker.bundle.js" cannot be used.
      this.worker = new Worker(
        /* webpackChunkName: "neuroglancer_chunk_worker" */
        new URL("./chunk_worker.bundle.js", import.meta.url),
        { type: "module" },
      );
    }
    this.chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(
        new RPC(this.worker, /*waitUntilReady=*/ true),
        this.gl,
        this.frameNumberCounter,
        {
          gpuMemory: new CapacitySpecification({
            defaultItemLimit: 1e6,
            defaultSizeLimit: 1e9,
          }),
          systemMemory: new CapacitySpecification({
            defaultItemLimit: 1e7,
            defaultSizeLimit: 2e9,
          }),
          download: new CapacitySpecification({
            defaultItemLimit: 100,
            defaultSizeLimit: Number.POSITIVE_INFINITY,
          }),
          compute: new CapacitySpecification({
            defaultItemLimit: 128,
            defaultSizeLimit: 5e8,
          }),
        },
      ),
    );
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());
    this.chunkManager = this.registerDisposer(
      new ChunkManager(this.chunkQueueManager),
    );
  }
}
