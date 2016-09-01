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

var chroma = require('chroma-js');//needs to be imported this way due to export style differences

require('./segmentation_user_layer.css');

export class SegmentationMetricUserLayer extends UserLayer implements SegmentationDisplayState {
  segmentColorHash = SegmentColorHash.getDefault();
  segmentSelectionState = new SegmentSelectionState();
  selectedAlpha = trackableAlphaValue(0.5);
  notSelectedAlpha = trackableAlphaValue(0);
  visibleSegments: Uint64Set;
  volumePath: string|undefined;
  meshPath: string|undefined;
  meshLod: number|undefined;
  skeletonsPath: string|undefined;
  meshLayer: MeshLayer|undefined;
  wasDisposed = false;
  ReferenceUserLayer: SegmentationUserLayer;
  metricKeyData: MetricKeyData = new MetricKeyData();

  constructor(public manager: LayerListSpecification, x: any, metricData: any, ReferenceUserLayer: SegmentationUserLayer) {
    super([]);
    this.ReferenceUserLayer = ReferenceUserLayer;
    this.visibleSegments = Uint64Set.makeWithCounterpart(manager.worker);
    this.visibleSegments.changed.add(() => { this.specificationChanged.dispatch(); });
    this.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.selectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.notSelectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });

    this.selectedAlpha.restoreState(x['selectedAlpha']);
    this.notSelectedAlpha.restoreState(x['notSelectedAlpha']);
    //add the color layer
    let volumePath = this.volumePath = verifyOptionalString(x['source']);
    let meshPath = this.meshPath = verifyOptionalString(x['mesh']);
    let skeletonsPath = this.skeletonsPath = verifyOptionalString(x['skeletons']);
    if (this.volumePath !== undefined) {

      let cvolumePromise = getVolumeWithStatusMessage(this.volumePath);
      cvolumePromise
      .then(volume => {
        if (!this.wasDisposed) {
          if (!this.meshLayer) {
            let meshSource = volume.getMeshSource(this.manager.chunkManager);
            if (meshSource != null) {
              this.addMesh(meshSource);
            }
          }
        }
      });
      this.metricKeyData.name = metricData['metricName'];
      let IDColorMap = this.mapMetricsToColors(metricData['IDColorMap']);
      this.addRenderLayer(new CustomColorSegmentationRenderLayer(
          manager.chunkManager, cvolumePromise, this, this.selectedAlpha, this.notSelectedAlpha, IDColorMap));
      
    }

  }

  mapMetricsToColors(IdMetricMap: any){
    let metricKeyData = this.metricKeyData;
    let colors = ['White', 'Yellow', 'aquamarine', 'deepskyblue', 'mediumorchid'];
    let metricIteratee = function(el){
      return el[1];//metric value
    }
    let min = metricKeyData.min = minBy(IdMetricMap, metricIteratee)[1];
    let max = metricKeyData.max = maxBy(IdMetricMap, metricIteratee)[1];
    let scale = metricKeyData.chromaScale = chroma.scale(colors).domain([min, max]);
    console.log(scale(50))
    for(let metricArr of IdMetricMap){
      let metricVal = metricArr[1];
      let rgb = (scale(metricVal)).rgba();
      metricArr[1] = (rgb[3]<<24)+(rgb[2]<<16)+(rgb[1]<<8)+ rgb[0]//convert to 32bit little-endian(?) value
    }
    let IDColorMap = new Map(IdMetricMap);
    return IDColorMap;
  }

  getValueAt(position: Float32Array, pickedRenderLayer: RenderLayer|null, pickedObject: Uint64) {
    let result: any;
    let {renderLayers} = this;
    let {ReferenceUserLayer} = this;

    return ReferenceUserLayer.renderLayers[0].getValueAt(position);

  }

  disposed() {
    super.disposed();
    this.wasDisposed = true;
  }

  addMesh(meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this);
    this.addRenderLayer(this.meshLayer);
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['meshLod'] = this.meshLod;
    x['skeletons'] = this.skeletonsPath;
    x['selectedAlpha'] = this.selectedAlpha.toJSON();
    x['notSelectedAlpha'] = this.notSelectedAlpha.toJSON();
    let {visibleSegments} = this;
    if (visibleSegments.size > 0) {
      let segments = x['segments'] = new Array<string>();
      for (let id of visibleSegments) {
        segments.push(id.toString());
      }
    }
    return x;
  }

  makeDropdown(element: HTMLDivElement) { return new MetricDropdown(element, this); }

//disable segmentation actions for now
  handleAction(action: string) {
    switch (action) {
      case 'recolor': 
      case 'clear-segments': 
      case 'select': {
        break;
      }
    }
  }
};
