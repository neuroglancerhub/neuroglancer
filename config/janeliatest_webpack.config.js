'use strict';
const HtmlWebpackPlugin = require('html-webpack-plugin');
const resolveReal = require('./resolve_real');
const path = require('path');
const webpack_helpers = require('./webpack_helpers');

var CopyWebpackPlugin = require('copy-webpack-plugin');

var dest = path.resolve(__dirname, '../dist/janelia_test')
var copy_plugin =  new CopyWebpackPlugin([
  {
    from: resolveReal(__dirname, '../flyem_testing_support/janelia-test.js'),
    to: dest 
  }
]);

var config = webpack_helpers.getViewerConfig({
      outputPath: dest,
      htmlPlugin: new HtmlWebpackPlugin({template: resolveReal(__dirname, '../flyem_testing_support/index.html')}),
      frontendPlugins: [copy_plugin],
      supportedLayers: [
        'neuroglancer/segmentation_metric_user_layer',
        'neuroglancer/stack_user_layer'
      ].concat(webpack_helpers.DEFAULT_SUPPORTED_LAYERS)
    });


config.push(Object.assign(
        {
          entry: {'janelia_test': resolveReal(__dirname, '../flyem_testing_support/janelia-test.js')},
          target: 'web',
        },
        webpack_helpers.getBaseConfig({
          outputPath: dest
        })))

module.exports = config
