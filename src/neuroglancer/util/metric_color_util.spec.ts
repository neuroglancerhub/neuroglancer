import {range, zip} from 'lodash';
import {MetricKeyData, mapMetricsToColors} from 'neuroglancer/util/metric_color_util';

const largeColorMap = zip(range(1, 100000), range(1, 100000));

describe('Large IDColorMap Example', function() {
  const keyData = new MetricKeyData();
  keyData.name = 'test';
  it(`mapMetricsToColors`, function() {
    let t0 = performance.now();
    mapMetricsToColors(largeColorMap, keyData);
    let t1 = performance.now();
    console.log('mapMetricsToColors perf(ms): ' + (t1 - t0));
  });
});
