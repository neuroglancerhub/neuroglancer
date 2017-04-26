import {ChunkFormatHandler, VolumeChunk, ChunkFormat, VolumeChunkSource, 
  registerChunkFormatHandler, MultiscaleVolumeChunkSource, defineParameterizedVolumeChunkSource} from 'neuroglancer/sliceview/frontend.ts';
import {GL} from 'neuroglancer/webgl/context';
import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {StackChunk} from 'neuroglancer/stack/frontend.ts';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {every} from 'lodash';

export class StackChunkFormat implements ChunkFormat {

  shaderKey = 'stack.StackChunkFormat';

  defineShader(builder: ShaderBuilder){
    builder.addUniform('highp vec4', 'uSubstackColor');
  }

  beginDrawing(_gl: GL, _shader: ShaderProgram) {}

  endDrawing(_gl: GL, _shader: ShaderProgram) {}

  bindChunk(gl: GL, shader: ShaderProgram, chunk: StackChunk){
    gl.uniform4fv(shader.uniform('uSubstackColor'), vec4.fromValues(chunk.data[0],chunk.data[1],chunk.data[2], chunk.data[3]));
  }

  beginSource(_gl: GL, _shader: ShaderProgram) {}
}

export class StackChunkFormatHandler extends RefCounted implements ChunkFormatHandler{
  chunkFormat = new StackChunkFormat();

  getChunk(source: VolumeChunkSource, x: any) {
    return new StackChunk(source, x);
  }
}

registerChunkFormatHandler((_gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.stack != null) {
    return new StackChunkFormatHandler();
  }
  return null;
});
