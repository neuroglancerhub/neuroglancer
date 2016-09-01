import {encodeChannel} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint64';
import {updateLookupTableData} from 'neuroglancer/sliceview/compressed_segmentation/change_tabledata';
import {Uint32ArrayBuilder} from 'neuroglancer/util/uint32array_builder.ts';

fdescribe('change_tabledata uint64', () => {

   describe('change_tabledata ', () => {
    it('base', () => {
      const input = Uint32Array.of(
          4, 0, 3, 0, 5, 0, 4, 0,  //block 1
          1, 0, 3, 0, 3, 0, 3, 0   //block 2
          );
      const volumeSize = [2, 2, 2];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      const dataMap = new Map([
          [5, 10],
          [3, 6]
        ]
      );
      output.appendArray([1, 2, 3]);
      encodeChannel(output, blockSize, input, volumeSize);

      updateLookupTableData(output.view, dataMap, 3, blockSize, volumeSize);
      expect(output.view)
          .toEqual(Uint32Array.of(
              1, 2, 3,                       //junk padding
              5 | (2 << 24), 4,              //block 1 header
              12 | (1 << 24), 11,            //block 2 header
              0b01100001, 6, 0, 0, 0, 10, 0,  //block 1 enc data & lookup table
              0b1110, 0, 0, 6, 0             //block 2 enc data & lookup table
              ));
    });
    it('map data with 0-bit encoded data', () => {
    const input = Uint32Array.of(
        4, 0, 4, 0, 4, 0, 4, 0,  //block 1
        3, 0, 3, 0, 3, 0, 3, 0,  //block 2
        3, 0, 3, 0, 3, 0, 3, 0,  //block 3
        4, 0, 4, 0, 4, 0, 4, 0   //block 4
        );
    const volumeSize = [2, 2, 4];
    const blockSize = [2, 2, 1];
    const output = new Uint32ArrayBuilder();
    output.appendArray([1, 2, 3]);
    encodeChannel(output, blockSize, input, volumeSize);
    const dataMap = new Map([
      [4,10]
    ]);

    updateLookupTableData(output.view, dataMap, 3, blockSize, volumeSize);
    expect(output.view)
        .toEqual(Uint32Array.of(
            1, 2, 3,             //junk padding
            8 | (0 << 24), 8,    //header block 1
            10 | (0 << 24), 10,  //header block 2
            10 | (0 << 24), 12,  //header block 3
            8 | (0 << 24), 12,   //header block 4
            10, 0,                //data for blocks 1, 4
            0, 0                 //data for blocks 2, 3
            ));
     });
   });
});