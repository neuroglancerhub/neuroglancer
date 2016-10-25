import {registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {RPC} from 'neuroglancer/worker_rpc';
import {vec3Key} from 'neuroglancer/util/geom';

export class StackChunkSource extends VolumeChunkSource{
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec.stack = true;
  }

  download(chunk: VolumeChunk) {
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      chunk.data = this.getColor(vec3Key(chunk.chunkGridPosition));
    }

    chunk.downloadSucceeded();
  }

  getColor(position: string /* vec3Key for chunk position */){
    /* Usually, the color will need to be retrieved from parameters (override in ParameterizedStackChunkSource) 
       Otherwise, stack chunks will be randomly colored
    */
    new Float32Array([Math.random(), Math.random(), Math.random(),1]);
  }

};

export class ParameterizedStackChunkSource<Parameters> extends StackChunkSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
};