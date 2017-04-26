import {UserLayerDropdown} from 'neuroglancer/layer';
import {SegmentationMetricUserLayer} from 'neuroglancer/segmentation_metric_user_layer';
import {SegmentationUserLayer, SegmentationDropdown} from 'neuroglancer/segmentation_user_layer';
import {Uint64} from 'neuroglancer/util/uint64';
import {ColorSelect} from 'neuroglancer/widget/color_select';
import {MetricScaleWidget} from 'neuroglancer/widget/metric_scale_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

export class MetricDropdown extends SegmentationDropdown {
  metricSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.metricLayer.displayState.selectedAlpha));
  metricNotSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.metricLayer.displayState.notSelectedAlpha));
  colorSelectWidget = this.registerDisposer(
      new ColorSelect(Array.from(this.layer.segLayers.keys()), this.layer.currentLayerName));
  metricScaleWidget: MetricScaleWidget;

  constructor(public element: HTMLDivElement, public layer: SegmentationMetricUserLayer) {
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
