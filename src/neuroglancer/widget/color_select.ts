import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

require('./color_select.css');

export class ColorSelect extends RefCounted {
  element = document.createElement('label');
  select = document.createElement('select');

  constructor(options: Array<string>, public model: TrackableValue<string>) {
    super();
    let {element, select} = this;

    element.className = 'color-select-widget';
    select.name = 'colorselect';

    for (let optionStr of options) {
      this.addOption(optionStr);
    }
    select.value = model.value;  // initial state
    element.appendChild(document.createTextNode('Color Options: '));
    element.appendChild(select);

    this.registerDisposer(model.changed.add(this.update.bind(this)))

    this.registerEventListener(
        select, 'change', function(this: typeof select, _: Event) { model.value = this.value; });
  }

  update() { this.select.value = this.model.value; }
  
  addOption(optionStr: string) {
      let optionEl = document.createElement('option');
      optionEl.innerHTML = optionStr;
      optionEl.value = optionStr;
      this.select.appendChild(optionEl);
  }
  
  disposed() { removeFromParent(this.element); }
}
