import {each, flatten} from 'lodash';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {GPUHashTable} from 'neuroglancer/gpu_hash/shader';
import {SegmentationMetricUserLayer} from 'neuroglancer/segmentation_metric_user_layer';
import {updateLookupTableData} from 'neuroglancer/sliceview/compressed_segmentation/change_tabledata';
import {CompressedSegmentationVolumeChunk} from 'neuroglancer/sliceview/compressed_segmentation/chunk_format.ts';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {VolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {MetricKeyData} from 'neuroglancer/util/metric_color_util';
import {Uint64} from 'neuroglancer/util/uint64';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';

export class CustomColorSegmentationRenderLayer extends SegmentationRenderLayer {
  protected gpuHashTable: GPUHashTable<any>;
  public currentMetricName: string;
  protected chunkSource: MultiscaleVolumeChunkSource;
  // data transformation function applied to chunk data
  protected fn = function(IDColorMap: any, chunk: CompressedSegmentationVolumeChunk) {
    updateLookupTableData(
        chunk.data, IDColorMap, 1, chunk.chunkFormat.subchunkSize, chunk.chunkDataSize);
  };

  constructor(
      chunkManager: ChunkManager, multiscaleSourcePromise: Promise<MultiscaleVolumeChunkSource>,
      public metrics: Map<string, MetricKeyData>, public displayState: SegmentationMetricUserLayer,
      public selectedAlpha = trackableAlphaValue(0.5),
      public notSelectedAlpha = trackableAlphaValue(0)) {
    super(chunkManager, multiscaleSourcePromise, displayState, selectedAlpha, notSelectedAlpha);
    // copy display state
    this.displayState = Object.assign({}, displayState);
    this.displayState.visibleSegments = Uint64Set.makeWithCounterpart(displayState.manager.worker);
    this.gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments.hashTable);
  }

  updateDataTransformation(metricName: string) {
    this.currentMetricName = metricName;

    let metricKeyData = this.metrics.get(metricName);
    let fn = undefined;

    if (metricKeyData) {
      fn = this.fn.bind({}, metricKeyData.IDColorMap);
    }

    let sourceList = flatten(this.sources!);

    each(sourceList, function(chunkSource: VolumeChunkSource) {
      chunkSource.transform = fn;
      for (let chunk of chunkSource.chunks.values()) {
        if (chunk.state === ChunkState.GPU_MEMORY) {
          chunk.copyToGPU(chunkSource.gl);
        }
      }
    });
  }

  getShaderKey() { return 'customColorShader'; }

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

  getSelectedSegment() {
    let {segmentSelectionState} = this.displayState;
    let selectedSegmentStash = segmentSelectionState.selectedSegment;
    let colorVal = this.getColorVal(selectedSegmentStash);

    segmentSelectionState.selectedSegment = colorVal;

    let segmentVal = super.getSelectedSegment();

    segmentSelectionState.selectedSegment = selectedSegmentStash;

    return segmentVal;
  }

  getColorVal(id: Uint64) {
    let metric = this.metrics.get(this.currentMetricName);
    if (!metric) {
      return new Uint64();
    }
    let colorVal = metric.IDColorMap.get(String(id.low) + ',' + String(id.high));
    return colorVal ? colorVal : new Uint64();
  }
}
