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

import {each} from 'lodash';
import {RenderLayer} from 'neuroglancer/layer';
import {MetricDropdown} from 'neuroglancer/layer_dropdown';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {CustomColorSegmentationRenderLayer} from 'neuroglancer/sliceview/custom_color_segmentation_renderlayer';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyString} from 'neuroglancer/util/json';
import {MetricKeyData, mapMetricsToColors} from 'neuroglancer/util/metric_color_util';
import {Uint64} from 'neuroglancer/util/uint64';

require('./segmentation_user_layer.css');

export class SegmentationMetricUserLayer extends SegmentationUserLayer {
  colorPath: string|undefined;
  metricLayer: CustomColorSegmentationRenderLayer;
  selectedAlphaStash: number;
  notSelectedAlphaStash: number;
  segLayers: Map<string, SegmentationRenderLayer> = new Map<string, SegmentationRenderLayer>();
  visibleLayer: SegmentationRenderLayer;
  currentLayerName: TrackableValue<string>;
  prevLayerName: string;

  constructor(public manager: LayerListSpecification, x: any, metricData: any) {
    super(manager, x);

    // bookkeeping and setup for toggling the color state
    this.visibleLayer = this.segmentationLayer;
    this.currentLayerName = new TrackableValue<string>('Random Colors', verifyString);
    this.prevLayerName = this.currentLayerName.value;
    this.segLayers.set('Random Colors', this.segmentationLayer);
    this.segmentationLayer.layerPosition = 0;


    if (this.volumePath !== undefined) {
      let metrics = new Map<string, MetricKeyData>();

      each(metricData, function(metricMap: any, metricName: string) {
        let metricKeyData = new MetricKeyData();
        metricKeyData.name = metricName;
        mapMetricsToColors(metricMap, metricKeyData);
        metrics.set(metricName, metricKeyData);
      }.bind(this));
      // use the first metric map
      this.metricLayer = this.addMetricLayer(metrics);
      // start by showing the segmentation layer
      this.hideLayer(this.metricLayer);
    }
  }

  addMetricLayer(metrics: Map<string, MetricKeyData>) {
    let {manager} = this;

    // promise for color renderlayer--gets its own copy of the data
    let colorPromise = getVolumeWithStatusMessage(this.volumePath!);

    let metricLayer =
        new CustomColorSegmentationRenderLayer(manager.chunkManager, colorPromise, metrics, this);
    metricLayer.currentMetricName = 'Random Colors';

    // don't bother rendering the layer since it's not visible
    colorPromise.then((volume) => { metricLayer.setReady(false); });

    for (let name of metrics.keys()) {
      this.segLayers.set(name, metricLayer);
    }

    this.addRenderLayer(metricLayer);
    metricLayer.layerPosition = this.renderLayers.length - 1;

    this.visibleSegments.changed.add(this.syncMetricVisibleSegments, this);

    return metricLayer;
  }

  toJSON() {
    let x: any = super.toJSON();
    x['type'] = 'metric';
    if (!x['selectedAlpha']) {
      x['selectedAlpha'] = this.selectedAlphaStash;
    }
    return x;
  }


  syncMetricVisibleSegments(x: Uint64|null, added: boolean) {
    let metricVisibleSegments = this.metricLayer.displayState.visibleSegments;
    if (x) {
      let colorSegment = this.metricLayer.getColorVal(x);
      if (added && colorSegment) {
        metricVisibleSegments.add(colorSegment);
      } else if (colorSegment) {
        metricVisibleSegments.delete(colorSegment);
      }
    } else {
      metricVisibleSegments.clear();
    }
  }

  updateVisibleSegmentsOnMetricChange() {
    let metricVisibleSegments = this.metricLayer.displayState.visibleSegments;
    metricVisibleSegments.clear();
    for (let segment of this.visibleSegments.hashTable.keys()) {
      let colorSegment = this.metricLayer.getColorVal(segment);
      metricVisibleSegments.add(colorSegment);
    }
  }

  getValueAt(position: Float32Array, pickedRenderLayer: RenderLayer|null, pickedObject: Uint64) {
    return this.segmentationLayer.getValueAt(position);
  }

  shouldUpdateMetricSegments() {
    let newLayer = this.segLayers.get(this.currentLayerName.value);
    return (newLayer instanceof CustomColorSegmentationRenderLayer);
  }

  shouldUpdateLayers() {
    let newLayer = this.segLayers.get(this.currentLayerName.value);
    return this.visibleLayer !== newLayer;
  }

  updateCurrentSegLayer() {
    if (this.currentLayerName.value === this.prevLayerName) {
      return;
    }
    this.metricLayer.updateDataTransformation(this.currentLayerName.value);
    if (this.shouldUpdateMetricSegments()) {
      // just update metrics on the metricLayer
      this.updateVisibleSegmentsOnMetricChange();
    }
    if (this.shouldUpdateLayers()) {
      let oldLayer = this.visibleLayer;
      this.visibleLayer = this.segLayers.get(this.currentLayerName.value)!;
      // only update data for the metric layer if it's the visible layer
      this.metricLayer.setReady(this.visibleLayer instanceof CustomColorSegmentationRenderLayer);

      // swap alphas
      this.visibleLayer.selectedAlpha.value = oldLayer.selectedAlpha.value;
      this.visibleLayer.notSelectedAlpha.value = oldLayer.notSelectedAlpha.value;
      this.hideLayer(oldLayer);

      // reorder layers to avoid blending hidden layers
      oldLayer.layerPosition = this.visibleLayer.layerPosition;
      this.visibleLayer.layerPosition = 0;
      this.renderLayers[oldLayer.layerPosition!] = oldLayer;
      this.renderLayers[0] = this.visibleLayer;
    }
    // update the view
    this.layersChanged.dispatch();

    // update history
    this.prevLayerName = this.currentLayerName.value;
  }
  hideLayer(layer: SegmentationRenderLayer) {
    layer.selectedAlpha.value = 0;
    layer.notSelectedAlpha.value = 0;
  }

  makeDropdown(element: HTMLDivElement) { return new MetricDropdown(element, this); }
};
