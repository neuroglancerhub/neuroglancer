import {each} from 'lodash';
import {BLOCK_HEADER_SIZE} from 'neuroglancer/sliceview/compressed_segmentation/encode_common.ts';

/**
 * Update the lookup table data, which usually contains segment IDs, with new data provided 
 * in newDataMap, which acts like a dictionary mapping segment IDs to new values.
 * Values not found in this mapping are set to 0
 */
export function updateLookupTableData(
    data: Uint32Array, newDataMap:any, offset: number, 
    blockSize:ArrayLike<number>, volumeSize:ArrayLike<number>){
  //get index ranges for the lookup table data
  let headerSize = getHeaderSize(volumeSize, blockSize);
  let ranges = getLookupRanges(data, offset, headerSize/2);

  each(ranges, function(range: Range){

    for(let i = range.start; i<range.stop; i++){
      if(newDataMap[data[i]]){
        data[i] = newDataMap[data[i]];
      }
      else{
        //TODO: map missing data to greyscale and add new values to 
        //idea: just map 1st 8 bits to the rest of the bits (greyscale)
        data[i] = 0;
      }
    }

  }.bind(newDataMap))

}

function getLookupRanges(data: Uint32Array, offset: number, numBlocks: number){//assume data is a Uint32Array
  const byteOffset = offset*4;
  let dat8 = new Uint8Array(data.buffer, byteOffset);//skip the padding bytes
  let offsets:Array<Offset> = [];
  const headerByteLength = numBlocks * 4*2;//size is numBlocks * bytesizeofheader

  for(let i=0; i<headerByteLength; i=i+8){//iterate by 1 block header
    //decode offsets
    const lookupOffset = dat8[i] + (dat8[i+1]<< 8) + (dat8[i+2]<< 16);
    let dataOffset = lookupOffset + 1;
    if(dat8[i+3] !== 0){//number of encoding bits is 0
      dataOffset = dat8[i+4] + (dat8[i+5]<< 8) + (dat8[i+6]<< 16)+ (dat8[i+7]<< 24);        
    }
    
    offsets.push({offset: lookupOffset + offset, type: 'lookup'});
    offsets.push({offset: dataOffset + offset,   type:'data'});
  }
  offsets.sort(compareOffsets);

  let ranges: Array<Range> = [];

  for(let i=0; i < offsets.length; i++){
    if(offsets[i].type === 'lookup'){
      //start by assuming end condition--range ends at the end of the data array
      let range: Range = {start: offsets[i].offset, stop: data.length}
      //look for the next offset of type data, as the next data offset is the end of your range of lookup tables
      while(i < offsets.length && offsets[i].type !== 'data'){
        i++;
      }
      //make sure the index isn't outside our offsets array
      if(i < offsets.length){
        //current index now points to next type 'data' offset
        range.stop = offsets[i].offset;        
      }
      ranges.push(range)
    }
  }

  return ranges;
}

function getHeaderSize(volumeSize: ArrayLike<number>, blockSize: ArrayLike<number>){
  let blockIndexSize = BLOCK_HEADER_SIZE;

  for (let i = 0; i < 3; ++i) {
    let curGridSize = Math.ceil(volumeSize[i] / blockSize[i]);
    blockIndexSize *= curGridSize;
  }
  return blockIndexSize;
}

function compareOffsets(a:Offset, b:Offset){
  if(a.offset < b.offset ){
    return -1;
  }
  if(a.offset > b.offset ){
    return 1;
  }
  if(a.offset === b.offset && a.type === b.type){
    return 0;
  }
  if(a.type === 'data'){
    return 1;
  }
  //a's type is 'lookup'
  return -1;
}

interface Offset{
  offset: number;
  type: string;
}
interface Range{
  start: number;
  stop: number;
}
