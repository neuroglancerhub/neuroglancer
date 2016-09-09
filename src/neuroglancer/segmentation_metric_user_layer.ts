/**
 * @license
 * Copyright 2016 Google Inc.
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

import {getMeshSource, getSkeletonSource} from 'neuroglancer/datasource/factory';
import {UserLayer, RenderLayer} from 'neuroglancer/layer';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {LayerListSpecification, ManagedUserLayerWithSpecification} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentSelectionState, SegmentationDisplayState} from 'neuroglancer/segmentation_display_state';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {CustomColorSegmentationRenderLayer} from 'neuroglancer/sliceview/custom_color_segmentation_renderlayer';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {MetricKeyData} from 'neuroglancer/widget/metric_scale_widget';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {MetricDropdown} from 'neuroglancer/layer_dropdown';
import {iteratee, minBy, maxBy} from 'lodash';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';

var chroma:any = require('chroma-js');//needs to be imported this way due to export style differences

require('./segmentation_user_layer.css');

export class SegmentationMetricUserLayer extends SegmentationUserLayer {
  colorPath: string|undefined;
  metricKeyData: MetricKeyData = new MetricKeyData();
  showMetrics: TrackableBoolean = new TrackableBoolean(false, false);
  metricLayer: CustomColorSegmentationRenderLayer;
  selectedAlphaStash: number;
  notSelectedAlphaStash: number;

  constructor(public manager: LayerListSpecification, x: any, metricData: any) {
    super(manager, x);
    this.metricKeyData.name = metricData['metricName'];
    let IDColorMap = this.mapMetricsToColors(metricData['IDColorMap']);

    let colorPath = this.colorPath = this.volumePath + '#';

    if(this.volumePath != undefined){
      //promise for color renderlayer
      let colorPromise = getVolumeWithStatusMessage(this.colorPath);

      //assumption: seg and metric layers are the top two layers
      this.metricLayer = new CustomColorSegmentationRenderLayer(
          manager.chunkManager, colorPromise, IDColorMap, this);
      this.addRenderLayer(this.metricLayer);

      this.hideLayer(this.metricLayer);
      this.visibleSegments.changed.add(this.syncMetricVisibleSegments, this);
    }


  }

  syncMetricVisibleSegments(x: Uint64|null, added: boolean){
    let metricVisibleSegments = this.metricLayer.displayState.visibleSegments;
    if(x){
      let colorSegment = this.metricLayer.getColorVal(x);
      if(added && colorSegment){
        metricVisibleSegments.add(colorSegment);
      }
      else if(colorSegment){
        metricVisibleSegments.delete(colorSegment);
      }
    }
    else{
        metricVisibleSegments.clear();
    }

  }

  mapMetricsToColors(IdMetricMap: any): Map<string, Uint64>{
    let metricKeyData = this.metricKeyData;
    let colors = ['Yellow', 'aquamarine', 'deepskyblue', 'mediumorchid'];
    let metricIteratee = function(el:ArrayLike<number>){
      return el[1];//metric value
    }
    let min = metricKeyData.min = minBy(IdMetricMap, metricIteratee)[1];
    let max = metricKeyData.max = maxBy(IdMetricMap, metricIteratee)[1];
    let scale = metricKeyData.chromaScale = chroma!.scale(colors).domain([min, max]);

    for(let metricArr of IdMetricMap){
      let metricVal = metricArr[1];
      let rgb = (scale(metricVal)).rgba();
      metricArr[1] = (rgb[3]<<24)+(rgb[2]<<16)+(rgb[1]<<8)+ rgb[0]//convert color to 32bit little-endian value
      //make data key
      let idUint64 = new Uint64();
      idUint64.parseString(metricArr[0].toString())
      metricArr[0] = idUint64.low + ',' + idUint64.high;
      //convert val to Uint64 with rand high values
      let randHigh = Math.floor(Math.random()*Math.pow(2,32));
      metricArr[1] = new Uint64(metricArr[1], randHigh)
    }

    let IDColorMap = new Map<string, Uint64>(IdMetricMap);
    return IDColorMap;
  }

  getValueAt(position: Float32Array, pickedRenderLayer: RenderLayer|null, pickedObject: Uint64) {
    let result: any;
    let {renderLayers} = this;

    return this.segmentationLayer.getValueAt(position);

  }

  toggleUserLayer(){
    if(this.showMetrics.value){
      this.showLayer(this.metricLayer);
      this.hideLayer(this.segmentationLayer);
    }
    else{
      this.showLayer(this.segmentationLayer);
      this.hideLayer(this.metricLayer);
    }
  }
  showLayer(layer: SegmentationRenderLayer){
      //make sure this layer is in front to avoid blending hidden layers
      this.renderLayers[1] = this.renderLayers[0];
      this.renderLayers[0] = layer;
      layer.selectedAlpha.value = this.selectedAlphaStash;
      layer.notSelectedAlpha.value = this.notSelectedAlphaStash;
      this.layersChanged.dispatch();
  }
  hideLayer(layer: SegmentationRenderLayer){
      this.selectedAlphaStash = layer.selectedAlpha.value;
      this.notSelectedAlphaStash= layer.notSelectedAlpha.value;

      layer.selectedAlpha.value = 0;
      layer.notSelectedAlpha.value = 0;
  }

  makeDropdown(element: HTMLDivElement) { return new MetricDropdown(element, this); }

};