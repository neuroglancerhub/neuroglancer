/**
 * @license
 * Copyright 2024 Howard Hughes Medical Institute
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

import { defineConfig, type Plugin } from "vite";
import { resolve, dirname } from "path";
import fs from "fs";

const rootDir = resolve(__dirname);
const srcDir = resolve(rootDir, "src");

/**
 * Custom plugin to resolve Node.js subpath imports used in neuroglancer.
 */
function resolveSubpathImports(): Plugin {
  const resolveToTs = (basePath: string): string | null => {
    let pathWithoutExt = basePath;
    if (pathWithoutExt.endsWith(".js")) {
      pathWithoutExt = pathWithoutExt.slice(0, -3);
    }

    const tsPath = pathWithoutExt + ".ts";
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }

    const jsPath = pathWithoutExt + ".js";
    if (fs.existsSync(jsPath)) {
      return jsPath;
    }

    const indexPath = resolve(pathWithoutExt, "index.ts");
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }

    return null;
  };

  return {
    name: "resolve-subpath-imports",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.startsWith("#datasource/")) {
        const relativePath = source.slice(12);
        const basePath = resolve(srcDir, "datasource", relativePath);
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      if (source.startsWith("#kvstore/")) {
        const relativePath = source.slice(9);
        const basePath = resolve(srcDir, "kvstore", relativePath);
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      if (source.startsWith("#layer/")) {
        const relativePath = source.slice(7);
        const basePath = resolve(srcDir, "layer", relativePath, "index");
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      if (source.startsWith("#tests/")) {
        return { id: source, external: true };
      }

      if (source.startsWith("#testdata/")) {
        return { id: source, external: true };
      }

      if (source === "#main") {
        return resolve(srcDir, "main.ts");
      }
      if (source === "#python_integration_build") {
        return resolve(srcDir, "util/false.ts");
      }

      if (importer && importer.startsWith(srcDir) && source.endsWith(".js")) {
        if (source.startsWith("./") || source.startsWith("../")) {
          const importerDir = dirname(importer);
          const basePath = resolve(importerDir, source);
          if (basePath.startsWith(srcDir)) {
            const resolved = resolveToTs(basePath);
            if (resolved) return resolved;
          }
        }
      }

      if (source.startsWith(srcDir) && source.endsWith(".js")) {
        if (!fs.existsSync(source)) {
          const resolved = resolveToTs(source);
          if (resolved) return resolved;
        }
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveSubpathImports()],
  resolve: {
    extensions: [".ts", ".js", ".tsx", ".jsx", ".json"],
    alias: [
      {
        find: /^#datasource\/(.*)$/,
        replacement: `${srcDir}/datasource/$1`,
      },
      {
        find: /^#kvstore\/(.*)$/,
        replacement: `${srcDir}/kvstore/$1`,
      },
      {
        find: /^#layer\/(.*)$/,
        replacement: `${srcDir}/layer/$1/index`,
      },
      {
        find: "#main",
        replacement: `${srcDir}/main.ts`,
      },
      {
        find: "#python_integration_build",
        replacement: `${srcDir}/util/false.ts`,
      },
      {
        find: "#src/third_party/jpgjs/jpg.js",
        replacement: `${srcDir}/third_party/jpgjs/jpg.js`,
      },
      {
        find: /^#src\/(.*)\.js$/,
        replacement: `${srcDir}/$1.ts`,
      },
      {
        find: /^#src\/(.*)$/,
        replacement: `${srcDir}/$1`,
      },
    ],
  },
  worker: {
    format: "es",
  },
  server: {
    port: 8080,
    open: true,
  },
  define: {
    NEUROGLANCER_BRAINMAPS_CLIENT_ID: JSON.stringify(
      "639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com",
    ),
  },
});
