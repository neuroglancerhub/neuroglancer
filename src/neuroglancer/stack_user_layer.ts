import {getStackSource} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {MultiscaleVolumeChunkSource, SliceView, VolumeChunkSource, defineParameterizedVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {StackRenderLayer} from 'neuroglancer/sliceview/stack_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {DataType, SLICEVIEW_RPC_ID, SliceViewBase, VolumeChunkSource as GenericVolumeChunkSource, VolumeChunkSpecification, VolumeType} from 'neuroglancer/sliceview/base';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';


export class StackUserLayer extends UserLayer {
  renderLayer: StackRenderLayer;
  opacity = trackableAlphaValue(0.5);
  volumePath: string;


  constructor(manager: LayerListSpecification, x:any){
    super();
    
    this.volumePath = x['source'];

    getStackSource(manager.chunkManager, this.volumePath, x).then(stackSource => {
      this.renderLayer = new StackRenderLayer(stackSource)
      this.addRenderLayer(this.renderLayer);
    });

  }
  
  toJSON() {
    let x: any = {'type': 'stack'};
    x['source'] = this.volumePath;
    return x;
  }
}