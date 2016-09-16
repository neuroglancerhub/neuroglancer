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
import {SegmentSelectionState, SegmentationDisplayState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {CustomColorSegmentationRenderLayer} from 'neuroglancer/sliceview/custom_color_segmentation_renderlayer';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {MetricKeyData, mapMetricsToColors} from 'neuroglancer/util/metric_color_util';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {MetricDropdown} from 'neuroglancer/layer_dropdown';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';

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
    let IDColorMap = mapMetricsToColors(metricData['IDColorMap'], this.metricKeyData);

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

  toJSON() {
    let x: any = super.toJSON()
    x['type'] = 'metric';
    x['metricData'] = {'metricName': this.metricKeyData.name}
    if(!x['selectedAlpha']){
      x['selectedAlpha'] = this.selectedAlphaStash;
    }
    return x;
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
