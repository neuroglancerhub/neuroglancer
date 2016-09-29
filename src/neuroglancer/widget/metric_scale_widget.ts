import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {MetricKeyData} from 'neuroglancer/util/metric_color_util.ts';

require('./metric_scale_widget.css');

export class MetricScaleWidget extends RefCounted {
  element = document.createElement('div');
  metricKeyData: MetricKeyData;

  constructor(metricKeyData: MetricKeyData) {
    super();
    this.metricKeyData = metricKeyData;
    let {element} = this;
    element.className = 'metric-scale-widget';

    let barElement = document.createElement('div');
    barElement.className = 'metric-scale-bar';

    let step = (metricKeyData.max - metricKeyData.min) / 50;
    let metricVal: number;
    let color: string;
    for (let i = 0; i < 51; i++) {
      let span = document.createElement('span');
      span.className = 'metric-grad-step';
      metricVal = metricKeyData.min + i * step;
      color = metricKeyData.chromaScale(metricVal).hex();
      span.style.backgroundColor = color;
      barElement.appendChild(span);
    }

    // add min/max text spans
    let min = document.createElement('span');
    min.appendChild(document.createTextNode(metricKeyData.min.toString()));
    min.className = 'metric-val-min';
    let max = document.createElement('span');
    max.className = 'metric-val-max';
    max.appendChild(document.createTextNode(metricKeyData.max.toString()));

    element.appendChild(barElement);
    element.appendChild(min);
    element.appendChild(max);
  }

  disposed() { removeFromParent(this.element); }
};
