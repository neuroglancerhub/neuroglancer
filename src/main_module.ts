import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeDefaultViewer} from 'neuroglancer/ui/default_viewer';
import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';

import {ImageUserLayer} from 'neuroglancer/image_user_layer';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
// import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';

import {DVIDDataSource} from 'neuroglancer/datasource/dvid/frontend';
import {registerProvider} from 'neuroglancer/datasource/default_provider';

/**
 * Sets up the default neuroglancer viewer.
 */
// TODO: options here could enable or disable datasources.
export function setupDefaultViewer() {
  // image_register();
  registerLayerType('image', ImageUserLayer);
  registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);

  // segmentation_register();
  registerLayerType('segmentation', SegmentationUserLayer);
  registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);

  registerProvider('dvid', () => new DVIDDataSource());

  let viewer = makeDefaultViewer();
  setDefaultInputEventBindings(viewer.inputEventBindings);

  /* const hashBinding = viewer.registerDisposer(new UrlHashBinding(viewer.state));
  viewer.registerDisposer(hashBinding.parseError.changed.add(() => {
    const {value} = hashBinding.parseError;
    if (value !== undefined) {
      const status = new StatusMessage();
      status.setErrorMessage(`Error parsing state: ${value.message}`);
      console.log('Error parsing state', value);
    }
    hashBinding.parseError;
  }));
  hashBinding.updateFromUrlHash(); */

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}

export default class Neuroglancer {
  version() {
    return '0.0.1';
  }
}
