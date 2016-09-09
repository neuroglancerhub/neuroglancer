import {UserLayerDropdown, UserLayer} from 'neuroglancer/layer';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {Uint64} from 'neuroglancer/util/uint64';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {SegmentationMetricUserLayer} from 'neuroglancer/segmentation_metric_user_layer';
import {MetricScaleWidget} from 'neuroglancer/widget/metric_scale_widget';



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
  }
};

export class MetricDropdown extends SegmentationDropdown {
  metricSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.metricLayer.selectedAlpha));
  metricNotSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.metricLayer.notSelectedAlpha));

  constructor(public element: HTMLDivElement, public layer: SegmentationMetricUserLayer) {
    super(element, layer);

    element.insertBefore(this.metricNotSelectedAlphaWidget.element, element.firstChild);
    element.insertBefore(this.metricSelectedAlphaWidget.element, element.firstChild);


    this.metricSelectedAlphaWidget.element.style.display = 'none';
    this.metricNotSelectedAlphaWidget.element.style.display = 'none';
    this.metricSelectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    this.metricNotSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';

    //add metric checkbox
    let showMetricLayerCheckbox =
        this.registerDisposer(new TrackableBooleanCheckbox(layer.showMetrics));
    let showMetricLayerLabel = document.createElement('label');
    showMetricLayerLabel.appendChild(document.createTextNode('Show Metric Data'));
    showMetricLayerLabel.appendChild(showMetricLayerCheckbox.element);
    this.element.appendChild(showMetricLayerLabel);
    this.registerSignalBinding(layer.showMetrics.changed.add(() => {
       layer.toggleUserLayer(); 
       this.toggleSliders();
    }));

    //add metric scale
    let metricScaleWidget = this.registerDisposer( new MetricScaleWidget(layer.metricKeyData));
    element.appendChild(metricScaleWidget.element);
  }

  toggleSliders(){
    if(this.layer.showMetrics.value){
      this.metricSelectedAlphaWidget.element.style.display = 'flex';
      this.metricNotSelectedAlphaWidget.element.style.display = 'flex';
      this.selectedAlphaWidget.element.style.display = 'none';
      this.notSelectedAlphaWidget.element.style.display = 'none';
    }
    else{
      this.metricSelectedAlphaWidget.element.style.display = 'none';
      this.metricNotSelectedAlphaWidget.element.style.display = 'none';
      this.selectedAlphaWidget.element.style.display = 'flex';
      this.notSelectedAlphaWidget.element.style.display = 'flex';      
    }
  }

};