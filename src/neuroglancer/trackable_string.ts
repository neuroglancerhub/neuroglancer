import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {verifyString} from 'neuroglancer/util/json';

export class TrackableString extends TrackableValue<string> {
  constructor(value: string) {
    super(value, verifyString);
  }
}

export class TrackableStringEdit extends RefCounted {
  element = document.createElement('input');
  constructor(public model: WatchableValueInterface<string>) {
    super();
    let{element} = this;
    element.type = 'text';
    element.setAttribute('autocomplete', "off");
    this.registerDisposer(model.changed.add(() => {
      this.updateEdit();
    }));
    this.updateEdit();
    this.registerEventListener(element, 'change', function(this: typeof element, _e: Event) {
      model.value = this.value;
    });
  }

  updateEdit() {
    this.element.value = this.model.value;
  }

  disposed() {
    let {element} = this;
    let {parentElement} = element;
    if (parentElement) {
      parentElement.removeChild(element);
    }
    super.disposed();
  }
}