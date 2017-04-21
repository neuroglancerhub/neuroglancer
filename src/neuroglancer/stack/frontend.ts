import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkFormatHandler, VolumeChunk, ChunkFormat, VolumeChunkSource, 
  registerChunkFormatHandler, MultiscaleVolumeChunkSource, defineParameterizedVolumeChunkSource} from 'neuroglancer/sliceview/frontend.ts';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {vec4, vec3, Vec3, vec3Key} from 'neuroglancer/util/geom';
import {RPC} from 'neuroglancer/worker_rpc';
import {stableStringify} from 'neuroglancer/util/json';
import {StackChunkFormat} from 'neuroglancer/stack/chunk_format';

export class StackChunk extends VolumeChunk {
  chunkFormat: StackChunkFormat;
  data: Float32Array;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.data = x['data'];
  }
  getChannelValueAt(dataPosition: Vec3, channel=0){
    return this.data;
  }
}

export class StackChunkSource extends VolumeChunkSource {
  chunks: Map<string, StackChunk>;

  getValueAt(position: Vec3) {
    return '';//don't display anything on hover. Could display the chunk value
  }

}

export function defineParameterizedStackChunkSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor = class ParameterizedStackChunkSource extends StackChunkSource {
    constructor(
        chunkManager: ChunkManager, spec: VolumeChunkSpecification, public parameters: Parameters) {
      super(chunkManager, spec);
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static get(chunkManager: ChunkManager, spec: VolumeChunkSpecification, parameters: Parameters) {
      return chunkManager.getChunkSource(
          this, stableStringify({parameters, spec: spec.toObject()}),
          () => new this(chunkManager, spec, parameters));
    }
    toString() { return parametersConstructor.stringify(this.parameters); }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}


