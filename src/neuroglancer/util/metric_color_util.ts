import {Uint64} from 'neuroglancer/util/uint64';
import {iteratee, minBy, maxBy, each} from 'lodash';

var chroma:any = require('chroma-js');//needs to be imported this way due to export style differences

export function mapMetricsToColors(IdMetricMap: any, metricKeyData:MetricKeyData): Map<string, Uint64>{
    let colors = ['Yellow', 'aquamarine', 'deepskyblue', 'mediumorchid'];
    let metricIteratee = function(el:ArrayLike<number>){
      return el[1];//metric value
    }
    let min = metricKeyData.min = minBy(IdMetricMap, metricIteratee)[1];
    let max = metricKeyData.max = maxBy(IdMetricMap, metricIteratee)[1];
    let scale = metricKeyData.chromaScale = chroma!.scale(colors).domain([min, max]);

    for(let i=0, len = IdMetricMap.length; i<len; i++){
      let metricArr = IdMetricMap[i];
      let metricVal = metricArr[1];
      let rgb = (scale(metricVal)).rgba();
      metricArr[1] = (rgb[3]<<24)+(rgb[2]<<16)+(rgb[1]<<8)+ rgb[0]//convert color to 32bit little-endian value
      //make data key
      let idUint64 = new Uint64();
      idUint64.parseString(metricArr[0].toString())
      metricArr[0] = idUint64.low + ',' + idUint64.high;
      //convert val to Uint64 with rand high values
      let randHigh = Math.floor(Math.random()*Math.pow(2,32));
      metricArr[1] = new Uint64(metricArr[1], randHigh)
  }

    return new Map<string, Uint64>(IdMetricMap);
    
}

export class MetricKeyData{
  min: number;
  max: number;
  chromaScale: any;
  name: string;
}