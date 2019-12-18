import {SkeletonChunk} from 'neuroglancer/skeleton/backend';

export function decodeSwcSkeletonChunk(chunk: SkeletonChunk, swcStr: string) {
  let swcObjects: Array<PointObj> = parseSwc(swcStr);

  if (swcObjects.length < 1) {
    throw new Error(`ERROR parsing swc file`);
  }

  let indexMap = new Uint32Array(swcObjects.length);

  let nodeCount = 0;
  let edgeCount = 0;
  swcObjects.forEach((swc_obj, i) => {
    if (swc_obj) {
      indexMap[i] = nodeCount++;
      if (swc_obj.parent >= 0) {
        ++edgeCount;
      }
    }
  });

  let glVertices = new Float32Array(3 * nodeCount);
  let glIndices = new Uint32Array(2 * edgeCount);

  let nodeIndex = 0;
  let edgetIndex = 0;
  swcObjects.forEach(function(swc_obj) {
    if (swc_obj) {
      glVertices[3 * nodeIndex] = swc_obj.x;
      glVertices[3 * nodeIndex + 1] = swc_obj.y;
      glVertices[3 * nodeIndex + 2] = swc_obj.z;
  
      if (swc_obj.parent >= 0) {
        glIndices[2 * edgetIndex] = nodeIndex;
        glIndices[2 * edgetIndex + 1] = indexMap[swc_obj.parent];
        ++edgetIndex;
      }
      ++nodeIndex;
    }
  });

  chunk.indices = glIndices;
  chunk.vertexPositions = glVertices;
}

/*
 * Parses a standard SWC file into an array of point objects
 * modified from
 * https://github.com/JaneliaSciComp/SharkViewer/blob/d9969a7c513beee32ff9650b00bf79cda8f3c76a/html/js/sharkviewer_loader.js
 */
function parseSwc(swcStr: string) {
  // split by line
  let swcInputAr = swcStr.split('\n');
  let swcObjectsAr: Array<PointObj> = new Array();
  let float = '-?\\d*(?:\\.\\d+)?';
  let pattern = new RegExp('^[ \\t]*(' + [
    '\\d+',    // index
    '\\d+',    // type
    float,     // x
    float,     // y
    float,     // z
    float,     // radius
    '-1|\\d+'  // parent
  ].join(')[ \\t]+(') + ')[ \\t]*$');

  swcInputAr.forEach(function(e) {
    // if line meets swc point criteria, add it to the array
    // subtract 1 from indices to convert 1-indexing to 0-indexing
    let match = e.match(pattern);
    if (match) {
      let point = swcObjectsAr[parseInt(match[1], 10)] = new PointObj();
      point.type = parseInt(match[2], 10);
      point.x = parseFloat(match[3]);
      point.y = parseFloat(match[4]);
      point.z = parseFloat(match[5]);
      point.radius = parseFloat(match[6]);
      point.parent = parseInt(match[7], 10);
    }
  });
  return swcObjectsAr;
}

class PointObj {
  type: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  parent: number;
}
