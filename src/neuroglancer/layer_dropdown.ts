import {UserLayerDropdown, UserLayer} from 'neuroglancer/layer';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {Uint64} from 'neuroglancer/util/uint64';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {SegmentationMetricUserLayer} from 'neuroglancer/segmentation_metric_user_layer';
import {MetricScaleWidget} from 'neuroglancer/widget/metric_scale_widget';
import {ColorSelect} from 'neuroglancer/widget/color_select';


export class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.selectedAlpha));
  notSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.notSelectedAlpha));
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';

    element.appendChild(this.selectedAlphaWidget.element);
    element.appendChild(this.notSelectedAlphaWidget.element);
    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add segment ID';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerSignalBinding(this.addSegmentWidget.valueEntered.add(
        (value: Uint64) => { this.layer.visibleSegments.add(value); }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
    
    //add show segments on hover checkbox
    let showSegmentsOnHoverCheckbox =
        this.registerDisposer(new TrackableBooleanCheckbox(layer.showSegmentsOnHover));
    let showSegmentsOnHoverLabel = document.createElement('label');
    showSegmentsOnHoverLabel.appendChild(document.createTextNode('Show Segments On Hover'));
    showSegmentsOnHoverLabel.appendChild(showSegmentsOnHoverCheckbox.element);
    this.element.appendChild(showSegmentsOnHoverLabel);
  }
};

export class MetricDropdown extends SegmentationDropdown {
  metricSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.metricLayer.selectedAlpha));
  metricNotSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.metricLayer.notSelectedAlpha));
  colorSelectWidget = this.registerDisposer(new ColorSelect(Array.from(this.layer.segLayers.keys()), this.layer.currentLayerName));
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

    this.registerSignalBinding(layer.currentLayerName.changed.add(function () {
       this.updateDropdown();
       this.layer.updateCurrentSegLayer();
    }.bind(this)));

    //add metric scale widget
    this.metricScaleWidget = this.registerDisposer( new MetricScaleWidget(layer.metricLayer.metrics.get(layer.metricLayer.currentMetricName)));
    this.metricScaleWidget.element.style.display = 'none';
    element.appendChild(this.metricScaleWidget.element);
  }

  updateDropdown(){
    if(this.layer.shouldUpdateLayers()){
      this.toggleSlidersAndMetricWidget();
    }
    if(this.layer.shouldUpdateMetrics()){
      
      this.metricScaleWidget.dispose()
      this.metricScaleWidget = this.registerDisposer( new MetricScaleWidget(this.layer.metricLayer.metrics.get(this.layer.currentLayerName.value)));
      this.element.appendChild(this.metricScaleWidget.element);

    }
  }

  toggleSlidersAndMetricWidget(){
    if(this.layer.visibleLayer !== this.layer.metricLayer) {
      //new layer is the metric layer
      this.metricSelectedAlphaWidget.element.style.display = 'flex';
      this.metricNotSelectedAlphaWidget.element.style.display = 'flex';
      this.metricScaleWidget.element.style.display = 'block'
      this.selectedAlphaWidget.element.style.display = 'none';
      this.notSelectedAlphaWidget.element.style.display = 'none';
    }
    else {
      this.metricSelectedAlphaWidget.element.style.display = 'none';
      this.metricNotSelectedAlphaWidget.element.style.display = 'none';
      this.metricScaleWidget.element.style.display = 'none';     
      this.selectedAlphaWidget.element.style.display = 'flex';
      this.notSelectedAlphaWidget.element.style.display = 'flex';
    }
  }

};