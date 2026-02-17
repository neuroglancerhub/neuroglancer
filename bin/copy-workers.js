#!/usr/bin/env node
/**
 * Helper script to copy neuroglancer worker files to a target directory.
 *
 * Usage:
 *   npx @janelia-flyem/neuroglancer-copy-workers [target-dir]
 *   npx @janelia-flyem/neuroglancer-copy-workers public/
 *
 * If no target directory is specified, defaults to "public/"
 *
 * This copies the self-contained worker files:
 * - chunk_worker.bundle.js - Web Worker for chunk processing
 * - async_computation.bundle.js - Web Worker for async computations
 * - main.css - Neuroglancer styles (optional, for convenience)
 *
 * Workers are self-contained with no external dependencies.
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceDir = resolve(__dirname, '..', 'dist', 'module');
const targetDir = process.argv[2] || 'public';

const files = [
  'chunk_worker.bundle.js',
  'async_computation.bundle.js',
  'main.css'
];

// Ensure target directory exists
if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

if (!existsSync(sourceDir)) {
  console.error(`Error: Source directory not found: ${sourceDir}`);
  console.error('Make sure you have built the library with: npm run build:lib-janelia');
  process.exit(1);
}

console.log(`Copying neuroglancer workers to ${targetDir}/`);

for (const file of files) {
  const source = join(sourceDir, file);
  const target = join(targetDir, file);

  if (existsSync(source)) {
    copyFileSync(source, target);
    console.log(`  ✓ ${file}`);
  } else {
    console.warn(`  ✗ ${file} (not found)`);
  }
}

console.log('Done.');
