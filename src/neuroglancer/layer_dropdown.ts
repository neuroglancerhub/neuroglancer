import {UserLayerDropdown, UserLayer} from 'neuroglancer/layer';
import {ManagedUserMetricLayer} from 'neuroglancer/layer_specification';
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
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer | SegmentationMetricUserLayer) {
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
  
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer | SegmentationMetricUserLayer) {
    super(element, layer);
    //must be a ManagedUserMetricLayer
    let managedUserLayer = layer.managingUserLayer;

    //add metric checkbox
    let showMetricLayerCheckbox =
        this.registerDisposer(new TrackableBooleanCheckbox(managedUserLayer.showMetrics));
    let showMetricLayerLabel = document.createElement('label');
    showMetricLayerLabel.appendChild(document.createTextNode('Show Metric Data'));
    showMetricLayerLabel.appendChild(showMetricLayerCheckbox.element);
    this.element.appendChild(showMetricLayerLabel);
    this.registerSignalBinding(managedUserLayer.showMetrics.changed.add(() => { managedUserLayer.toggleUserLayer(); }));

    if(layer.metricKeyData){
      let metricScaleWidget = this.registerDisposer( new MetricScaleWidget(layer.metricKeyData));
      element.appendChild(metricScaleWidget.element);
    }
  }

};