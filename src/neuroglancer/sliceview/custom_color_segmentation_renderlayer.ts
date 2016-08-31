import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {GPUHashTable, HashTableShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state';
import {MultiscaleVolumeChunkSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer, trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {updateLookupTableData} from 'neuroglancer/sliceview/compressed_segmentation/change_tabledata';
import {Chunk} from 'neuroglancer/chunk_manager/frontend';

//TODO: pare this down to only necessary imports

export class CustomColorSegmentationRenderLayer extends SegmentationRenderLayer{
  IDColorMap: any;

  constructor(
      chunkManager: ChunkManager, multiscaleSourcePromise: Promise<MultiscaleVolumeChunkSource>,
      public displayState: SegmentationDisplayState,
      public selectedAlpha = trackableAlphaValue(0.5),
      public notSelectedAlpha = trackableAlphaValue(0), IDColorMap: any) {
        
    super(chunkManager, multiscaleSourcePromise, displayState, selectedAlpha, notSelectedAlpha);
    multiscaleSourcePromise.then(chunkSource => {
      let transforms = chunkManager.dataTransformFns; 
      this.IDColorMap = IDColorMap;
      let fn = function(IDColorMap: any, chunk:Chunk){
        updateLookupTableData(chunk.data, IDColorMap, 1, chunk.source.chunkFormat.subchunkSize, chunk.chunkDataSize);
      }.bind({}, this.IDColorMap);
      transforms.set(chunkSource.dataInstanceKey, fn);
      
    });

  }

  getShaderKey(){
      return 'customColorShader'
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);

    builder.setFragmentMain(`
  uint64_t value = toUint64(getDataValue());
  float alpha = uSelectedAlpha;
  float saturation = 1.0;
  if (value.low == vec4(0,0,0,0) && value.high == vec4(0,0,0,0)) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
  bool has = uShowAllSegments > 0.0 ? true : ${this.hashTableManager.hasFunctionName}(value);
  if (uSelectedSegment[0] == value.low && uSelectedSegment[1] == value.high) {
    saturation = has ? 0.5 : 0.75;
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
  vec3 rgb = vec3(value.low);
  //emit(vec4(rgb, alpha));
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`);
  }

  getSelectedSegment(){
    let {segmentSelectionState} = this.displayState;
    let selectedSegmentStash = segmentSelectionState.selectedSegment;

    let colorVal = this.IDColorMap[segmentSelectionState.selectedSegment];
    segmentSelectionState.selectedSegment = colorVal? { low: colorVal, high: 0}: { low:0, high: 0};
    
    let segmentVal = super.getSelectedSegment();

    segmentSelectionState.selectedSegment = selectedSegmentStash;

    return segmentVal;
  }
}