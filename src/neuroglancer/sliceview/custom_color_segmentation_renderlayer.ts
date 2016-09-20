import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {SegmentSelectionState, SegmentationDisplayState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationMetricUserLayer} from 'neuroglancer/segmentation_metric_user_layer';
import {MultiscaleVolumeChunkSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer, trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {updateLookupTableData} from 'neuroglancer/sliceview/compressed_segmentation/change_tabledata';
import {Chunk} from 'neuroglancer/chunk_manager/frontend';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Uint64} from 'neuroglancer/util/uint64';
import {HashTableBase} from 'neuroglancer/gpu_hash/hash_table';
import {MetricKeyData} from 'neuroglancer/util/metric_color_util';
import {chain} from 'lodash';


//TODO: pare this down to only necessary imports

export class CustomColorSegmentationRenderLayer extends SegmentationRenderLayer{
  protected gpuHashTable: GPUHashTable<any>;
  protected currentMetricName: string;
  //data transformation function applied to chunk data
  protected fn = function(IDColorMap: any, chunk:Chunk){
      updateLookupTableData(chunk.data, IDColorMap, 1, chunk.source.chunkFormat.subchunkSize, chunk.chunkDataSize);
  };

  constructor(
      chunkManager: ChunkManager, multiscaleSourcePromise: Promise<MultiscaleVolumeChunkSource>,
      public metrics : Map<string, MetricKeyData>,
      public displayState: SegmentationMetricUserLayer,
      public selectedAlpha = trackableAlphaValue(0.5),
      public notSelectedAlpha = trackableAlphaValue(0)) {
    
    super(chunkManager, multiscaleSourcePromise, displayState, selectedAlpha, notSelectedAlpha);
    //copy display state
    this.displayState = Object.assign({}, displayState);
    this.displayState.visibleSegments = Uint64Set.makeWithCounterpart(displayState.manager.worker);
    this.gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments.hashTable);
    this.currentMetricName = metrics.keys().next().value;
    let metricKeyData = this.metrics.get(this.currentMetricName);

    multiscaleSourcePromise.then(function(chunkSource) {
      this.chunkSource = chunkSource;
      let transforms = chunkManager.dataTransformFns; 
      let fn = this.fn.bind({}, metricKeyData.IDColorMap);//apply IDColorMap
      transforms.set(chunkSource.dataInstanceKey, fn);

    }.bind(this));

  }

  updateDataTransformation(metricName: string){
    let {chunkSource, chunkManager} = this;
    if(this.currentMetricName === metricName){
      return;
    }
    this.currentMetricName = metricName;

    let metricKeyData = this.metrics.get(metricName);

    let fn = this.fn.bind({}, metricKeyData.IDColorMap);//apply IDColorMap
    
    chain(chunkSource.getSources(chunkManager))
      .flatten()
      .each(function(chunkSource){
        for(let chunk of chunkSource.chunks.values()){
        let dataStash = new Uint32Array(chunk.data.buffer.slice(0));
        fn(chunk);
        chunk.copyToGPU(chunkSource.gl);
        chunk.data = dataStash;
        }

      }).value();
    let transforms = chunkManager.dataTransformFns; 
    transforms.set(chunkSource.dataInstanceKey, fn);

    this.setReady(true);//updates layer

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
    alpha = has || (uShowSegmentsOnHover > 0.0 )? alpha : 0.0; 
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
  vec3 rgb = vec3(value.low);
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`);
  }

  getSelectedSegment(){
    let {segmentSelectionState} = this.displayState;
    let selectedSegmentStash = segmentSelectionState.selectedSegment;
    let colorVal = this.getColorVal(selectedSegmentStash);

    segmentSelectionState.selectedSegment = colorVal;
    
    let segmentVal = super.getSelectedSegment();

    segmentSelectionState.selectedSegment = selectedSegmentStash;

    return segmentVal;
  }

  getColorVal(id: Uint64) {
    let colorVal = this.metrics.get(this.currentMetricName).IDColorMap.get(String(id.low) + ',' + String(id.high))
    return colorVal ? colorVal : new Uint64();
  }
}