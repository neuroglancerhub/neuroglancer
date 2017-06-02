import stackData from './stack_data.json';
import metricData from './metric_data.json';

var janelia = {

  loadTestStack: function(){
    var spec = {
        __name: 'stack overlay',
        source: 'dvid://stack' + Math.random(),//add a random number so neuroglancer will know this is new data.
        type: 'stack',
        stackData: stackData,
        dataScaler: 8,
        visible: false
    }
    //add the layer
    viewer.layerManager.addManagedLayer(viewer.layerSpecification.getLayer(spec.__name, spec));

  },

  loadTestMetricLayer: function(){
    viewer.layerManager.addManagedLayer(viewer.layerSpecification.getLayer(metricData.__name, metricData));
  },

  loadTestSkeleton: function(){
    var spec = {
      __name: 'seg with skeleton',
      type:'segmentation',
      source:'dvid://http://emdata2:9000/3c1d11b3263e4933a556fc2a3d802451/groundtruth_pruned',
      skeletons:'dvid://http://emdata2:9000/3c1d11b3263e4933a556fc2a3d802451/gtpruned-bodies_skeletons',
      segments:['248962']
    }

    //add the layer
    viewer.layerManager.addManagedLayer(viewer.layerSpecification.getLayer(spec.__name, spec));
    //bring the skeleton into view
    viewer.navigationState.pose.position.setVoxelCoordinates([3807.5, 2514.5, 3999.5])
    viewer.perspectiveNavigationState.zoomFactor.value = 64;
    viewer.perspectiveNavigationState.pose.orientation.orientation = [-.2, .25, .05,.95]
  }

}

window.janelia = janelia;

