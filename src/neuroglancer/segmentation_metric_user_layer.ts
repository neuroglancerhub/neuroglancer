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
import {getVolumeWithStatusMessage, LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {SegmentationUserLayer, SegmentationDropdown} from 'neuroglancer/segmentation_user_layer';
import {CustomColorSegmentationRenderLayer} from 'neuroglancer/sliceview/custom_color_segmentation_renderlayer';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyString} from 'neuroglancer/util/json';
import {MetricKeyData, mapMetricsToColors} from 'neuroglancer/util/metric_color_util';
import {Uint64} from 'neuroglancer/util/uint64';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3} from 'neuroglancer/util/geom';
import {VolumeType} from 'neuroglancer/sliceview/base';
import {SegmentationDisplayState3D} from 'neuroglancer/segmentation_display_state/frontend';
import {RangeWidget} from 'neuroglancer/widget/range';
import {MetricScaleWidget} from 'neuroglancer/widget/metric_scale_widget';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ColorSelect} from 'neuroglancer/widget/color_select';

require('./segmentation_user_layer.css');

export class SegmentationMetricUserLayer extends SegmentationUserLayer {
  colorPath: string|undefined;
  metricLayer: CustomColorSegmentationRenderLayer;
  metricDisplayState: SliceViewSegmentationDisplayState;
  selectedAlphaStash: number;
  notSelectedAlphaStash: number;
  segLayers: Map<string, SegmentationRenderLayer> = new Map<string, SegmentationRenderLayer>();
  visibleLayer: SegmentationRenderLayer | CustomColorSegmentationRenderLayer;
  currentLayerName: TrackableValue<string>;
  prevLayerName: string;
  dropdown: MetricDropdown | undefined;

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    let metricData: any = x['metricData'];
    // bookkeeping and setup for toggling the color state

    if (this.volumePath !== undefined) {
      let metrics = new Map<string, MetricKeyData>();

      each(metricData, function(metricMap: any, metricName: string) {
        let metricKeyData = new MetricKeyData();
        metricKeyData.name = metricName;
        mapMetricsToColors(metricMap, metricKeyData);
        metrics.set(metricName, metricKeyData);
      }.bind(this));
      // use the first metric map
      this.addMetricLayer(metrics);

    }
    this.currentLayerName = new TrackableValue<string>('Random Colors', verifyString);
  }

  initializeSegLayer(volume: any){
    super.initializeSegLayer(volume);
    this.visibleLayer = this.segmentationLayer;
    this.prevLayerName = this.currentLayerName.value;
    this.segLayers.set('Random Colors', this.segmentationLayer);
    if(this.dropdown){
      this.dropdown.colorSelectWidget.addOption('Random Colors');
    }
  }

  addMetricLayer(metrics: Map<string, MetricKeyData>) {
    let {manager} = this;

    // promise for color renderlayer--gets its own copy of the data
    this.metricDisplayState = Object.assign({}, this.displayState, {
      selectedAlpha: trackableAlphaValue(0.5),
      notSelectedAlpha: trackableAlphaValue(0),
      visibleSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    });

    getVolumeWithStatusMessage(manager.chunkManager, this.volumePath!, {
       volumeType: VolumeType.SEGMENTATION
    }).then(volume => {
        if (!this.wasDisposed) {
          this.metricLayer = new CustomColorSegmentationRenderLayer(volume, this.metricDisplayState, metrics);
          this.addRenderLayer(this.metricLayer);
          // start by showing the segmentation layer
          this.hideLayer(this.metricLayer);
          // don't bother rendering the layer since it's not visible
          this.metricLayer.setReady(false);
          this.metricLayer.currentMetricName = 'Random Colors';

          for (let name of metrics.keys()) {
            this.segLayers.set(name, this.metricLayer);
            if(this.dropdown){
              this.dropdown.colorSelectWidget.addOption(name);
            }
          }

          this.metricLayer.layerPosition = this.renderLayers.length - 1;
          this.displayState.visibleSegments.changed.add(this.syncMetricVisibleSegments.bind(this));

      }
    });

  }

  toJSON() {
    let x: any = super.toJSON();
    x['type'] = 'metric';
    x['selectedAlpha'] = this.segmentationLayer.displayState.selectedAlpha.value || 
      this.metricLayer.displayState.selectedAlpha.value;

    return x;
  }

  addSegment(id:number){
    const segment = new Uint64();
    segment.parseString(id.toString());
    this.displayState.visibleSegments.add(segment);
    
    if(this.visibleLayer !== this.segmentationLayer){
      //translate into metric coordinates
      const metricSegment = this.metricLayer.getColorVal(segment);
      this.metricLayer.displayState.visibleSegments.add(metricSegment);
    }
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
    for (let segment of this.displayState.visibleSegments.hashTable.keys()) {
      let colorSegment = this.metricLayer.getColorVal(segment);
      metricVisibleSegments.add(colorSegment);
    }
  }

  getValueAt(position: Float32Array) {
    return this.segmentationLayer.getValueAt(vec3.fromValues(position[0],position[1],position[2]));
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
    if (this.shouldUpdateLayers()) {
      let oldLayer = this.visibleLayer;
      this.visibleLayer = this.segLayers.get(this.currentLayerName.value)!;
      // only update data for the metric layer if it's the visible layer
      this.metricLayer.setReady(this.visibleLayer instanceof CustomColorSegmentationRenderLayer);

      // swap alphas
      this.visibleLayer.displayState.selectedAlpha.value = oldLayer.displayState.selectedAlpha.value;
      this.visibleLayer.displayState.notSelectedAlpha.value = oldLayer.displayState.notSelectedAlpha.value;
      this.hideLayer(oldLayer);

      // reorder layers to avoid blending hidden layers
      oldLayer.layerPosition = this.visibleLayer.layerPosition;
      this.visibleLayer.layerPosition = 0;
      this.renderLayers[oldLayer.layerPosition!] = oldLayer;
      this.renderLayers[0] = this.visibleLayer;
    }
    // update the view
    this.layersChanged.dispatch();

    this.metricLayer.updateDataTransformation(this.currentLayerName.value);
    if (this.shouldUpdateMetricSegments()) {
      // just update metrics on the metricLayer
      this.updateVisibleSegmentsOnMetricChange();
    }


    // update history
    this.prevLayerName = this.currentLayerName.value;
  }
  hideLayer(layer: SegmentationRenderLayer | CustomColorSegmentationRenderLayer) {
    layer.displayState.selectedAlpha.value = 0;
    layer.displayState.notSelectedAlpha.value = 0;
  }

  makeDropdown(element: HTMLDivElement) { 
    this.dropdown = new MetricDropdown(element, this, this.metricDisplayState);
    return this.dropdown;
  }
};

class MetricDropdown extends SegmentationDropdown {
  metricSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.metricLayerDisplayState.selectedAlpha));
  metricNotSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.metricLayerDisplayState.notSelectedAlpha));
  colorSelectWidget = this.registerDisposer(
      new ColorSelect(Array.from(this.layer.segLayers.keys()), this.layer.currentLayerName));
  metricScaleWidget: MetricScaleWidget;

  constructor(public element: HTMLDivElement, public layer: SegmentationMetricUserLayer, public metricLayerDisplayState: SliceViewSegmentationDisplayState) {
    super(element, layer);

    element.insertBefore(this.metricNotSelectedAlphaWidget.element, element.firstChild);
    element.insertBefore(this.metricSelectedAlphaWidget.element, element.firstChild);
    element.appendChild(this.colorSelectWidget.element);

    this.metricSelectedAlphaWidget.element.style.display = 'none';
    this.metricNotSelectedAlphaWidget.element.style.display = 'none';
    this.metricSelectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    this.metricNotSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';

    this.registerDisposer(layer.currentLayerName.changed.add(() => {
      this.updateDropdown();
      this.layer.updateCurrentSegLayer();
    }));
  }

  updateDropdown() {
    if (this.layer.shouldUpdateLayers()) {
      this.toggleSliders();
    }
    if (this.metricScaleWidget) {
      this.metricScaleWidget.dispose();
    }
    let metric = this.layer.metricLayer.metrics.get(this.layer.currentLayerName.value);
    if (metric) {
      this.metricScaleWidget = this.registerDisposer(new MetricScaleWidget(metric));
      this.element.appendChild(this.metricScaleWidget.element);
    }
  }

  toggleSliders() {
    if (this.layer.visibleLayer != this.layer.metricLayer) {
      // new layer is the metric layer
      this.metricSelectedAlphaWidget.element.style.display = 'flex';
      this.metricNotSelectedAlphaWidget.element.style.display = 'flex';
      this.selectedAlphaWidget.element.style.display = 'none';
      this.notSelectedAlphaWidget.element.style.display = 'none';
    } else {
      this.metricSelectedAlphaWidget.element.style.display = 'none';
      this.metricNotSelectedAlphaWidget.element.style.display = 'none';
      this.selectedAlphaWidget.element.style.display = 'flex';
      this.notSelectedAlphaWidget.element.style.display = 'flex';
    }
  }
};

registerLayerType('metric', SegmentationMetricUserLayer);
registerVolumeLayerType(VolumeType.METRIC, SegmentationMetricUserLayer);