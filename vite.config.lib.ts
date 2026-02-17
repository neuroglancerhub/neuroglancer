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
import dts from "vite-plugin-dts";
import fs from "fs";

const rootDir = resolve(__dirname);
const srcDir = resolve(rootDir, "src");

/**
 * Custom plugin to resolve Node.js subpath imports used in neuroglancer.
 * Handles patterns like:
 *   #src/*.js -> ./src/*.ts
 *   #datasource/* -> ./src/datasource/*
 *
 * Also handles .js to .ts resolution for files that don't exist as .js
 */
function resolveSubpathImports(): Plugin {
  const resolveToTs = (basePath: string): string | null => {
    // Remove .js extension if present
    let pathWithoutExt = basePath;
    if (pathWithoutExt.endsWith(".js")) {
      pathWithoutExt = pathWithoutExt.slice(0, -3);
    }

    // Try .ts first
    const tsPath = pathWithoutExt + ".ts";
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }

    // Try .js (for actual JS files)
    const jsPath = pathWithoutExt + ".js";
    if (fs.existsSync(jsPath)) {
      return jsPath;
    }

    // Try as directory with index.ts
    const indexPath = resolve(pathWithoutExt, "index.ts");
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }

    return null;
  };

  return {
    name: "resolve-subpath-imports",
    enforce: "pre",
    resolveId(source, importer, options) {
      // Note: #src/ imports are handled by resolve.alias configuration
      // This plugin handles other subpath imports and .js->.ts fallback

      // Handle #datasource imports
      if (source.startsWith("#datasource/")) {
        const relativePath = source.slice(12); // Remove '#datasource/'
        const basePath = resolve(srcDir, "datasource", relativePath);
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      // Handle #kvstore imports
      if (source.startsWith("#kvstore/")) {
        const relativePath = source.slice(9); // Remove '#kvstore/'
        const basePath = resolve(srcDir, "kvstore", relativePath);
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      // Handle #layer imports
      if (source.startsWith("#layer/")) {
        const relativePath = source.slice(7); // Remove '#layer/'
        const basePath = resolve(srcDir, "layer", relativePath, "index");
        const resolved = resolveToTs(basePath);
        if (resolved) return resolved;
        return basePath + ".ts";
      }

      // Handle #tests imports (skip for library build)
      if (source.startsWith("#tests/")) {
        return { id: source, external: true };
      }

      // Handle #testdata imports (skip for library build)
      if (source.startsWith("#testdata/")) {
        return { id: source, external: true };
      }

      // Handle #main and #python_integration_build
      if (source === "#main") {
        return resolve(srcDir, "main.ts");
      }
      if (source === "#python_integration_build") {
        return resolve(srcDir, "util/false.ts");
      }

      // Handle relative imports with .js extension within src/
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

      // Handle absolute paths to .js files in src/ that don't exist
      // This catches cases where another resolver (e.g., Node.js subpath imports)
      // resolved to an absolute .js path
      if (source.startsWith(srcDir) && source.endsWith(".js")) {
        if (!fs.existsSync(source)) {
          const resolved = resolveToTs(source);
          if (resolved) return resolved;
        }
      }

      return null;
    },
    // Also handle load to redirect .js to .ts if the file doesn't exist
    load(id) {
      if (id.startsWith(srcDir) && id.endsWith(".js") && !fs.existsSync(id)) {
        const tsPath = id.slice(0, -3) + ".ts";
        if (fs.existsSync(tsPath)) {
          // Return null to let Vite's default loader handle the .ts file
          // after we update the id
          return null;
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    resolveSubpathImports(),
    dts({
      include: ["src/**/*.ts"],
      exclude: ["**/*.spec.ts", "**/*.browser_test.ts"],
    }),
  ],
  resolve: {
    extensions: [".ts", ".js", ".tsx", ".jsx", ".json"],
    alias: [
      // Handle #datasource/* -> src/datasource/*
      {
        find: /^#datasource\/(.*)$/,
        replacement: `${srcDir}/datasource/$1`,
      },
      // Handle #kvstore/* -> src/kvstore/*
      {
        find: /^#kvstore\/(.*)$/,
        replacement: `${srcDir}/kvstore/$1`,
      },
      // Handle #layer/* -> src/layer/*/index
      {
        find: /^#layer\/(.*)$/,
        replacement: `${srcDir}/layer/$1/index`,
      },
      // Handle #main
      {
        find: "#main",
        replacement: `${srcDir}/main.ts`,
      },
      // Handle #python_integration_build
      {
        find: "#python_integration_build",
        replacement: `${srcDir}/util/false.ts`,
      },
      // Specific handling for actual .js files (not TypeScript)
      {
        find: "#src/third_party/jpgjs/jpg.js",
        replacement: `${srcDir}/third_party/jpgjs/jpg.js`,
      },
      // Handle #src/*.js -> src/*.ts (most .js imports are actually TypeScript)
      {
        find: /^#src\/(.*)\.js$/,
        replacement: `${srcDir}/$1.ts`,
      },
      // Handle #src/* (without extension) -> src/*
      {
        find: /^#src\/(.*)$/,
        replacement: `${srcDir}/$1`,
      },
    ],
  },
  worker: {
    format: "es",
  },
  build: {
    lib: {
      entry: {
        main: resolve(__dirname, "src/main_module.ts"),
        "chunk_worker.bundle": resolve(
          __dirname,
          "src/chunk_worker.bundle.js",
        ),
        "async_computation.bundle": resolve(
          __dirname,
          "src/async_computation.bundle.js",
        ),
      },
      formats: ["es"],
    },
    outDir: "dist/lib",
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      // Note: For library distribution, lodash-es and gl-matrix could be externalized
      // to reduce bundle size if consumers provide them. For now, bundle everything.
      // external: [/^lodash-es/, /^gl-matrix/],
      output: {
        assetFileNames: "neuroglancer.[ext]",
        entryFileNames: "[name].js",
      },
      // Preserve side-effect imports (like async computation registrations)
      treeshake: {
        moduleSideEffects: true,
      },
    },
  },
  define: {
    NEUROGLANCER_BRAINMAPS_CLIENT_ID: JSON.stringify(""),
  },
});
