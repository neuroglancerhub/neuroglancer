import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {SliceView, MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ImageRenderLayer, getTrackableFragmentMain} from 'neuroglancer/sliceview/image_renderlayer';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {BoundingBox, vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {ChunkState} from 'neuroglancer/chunk_manager/base';

export class StackRenderLayer extends RenderLayer {
  opacity = trackableAlphaValue(0.5);
  constructor(stackSource: MultiscaleVolumeChunkSource) {
    
    super(stackSource);
  }
    getShaderKey() { return `sliceview.StackRenderLayer`; }
  
  defineShader(builder: ShaderBuilder) {
    this.vertexComputationManager.defineShader(builder);
    this.chunkFormat.defineShader(builder);

    builder.addUniform('highp float', 'uOpacity');
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragData[0] = color;
}
void emitRGBA(vec4 rgba) {
  emit(vec4(rgba.rgb, rgba.a * uOpacity));
}

`);
    builder.setFragmentMainFunction(
`void main() {
    emitRGBA(vec4(uSubstackColor));
}`);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    return shader;
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this)!;
    if (visibleSources.length === 0) {
      return;
    }

    this.initializeShader();
    if (this.shader === undefined) {
      return;
    }

    let gl = this.gl;

    let chunkPosition = vec3.create();
    let shader = this.beginSlice(sliceView);
    let vertexComputationManager = this.vertexComputationManager;

    // All sources are required to have the same texture format.
    let chunkFormat = this.chunkFormat;
    chunkFormat.beginDrawing(gl, shader);

    for (let source of visibleSources) {
      let chunkLayout = source.spec.chunkLayout;

      let chunks = source.chunks;

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: vec3|undefined;
      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      vertexComputationManager.beginSource(gl, shader, sliceView, sliceView.dataToDevice, source.spec);
      let sourceChunkFormat = source.chunkFormat;
      sourceChunkFormat.beginSource(gl, shader);

      let setChunkDataSize = (newChunkDataSize: vec3) => {
        chunkDataSize = newChunkDataSize;
        vertexComputationManager.setupChunkDataSize(gl, shader, chunkDataSize);
      };

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {

          let newChunkDataSize = chunk.chunkDataSize;

          if (newChunkDataSize !== chunkDataSize) {
            setChunkDataSize(newChunkDataSize);
          }

          vec3.scale(chunkPosition, chunk.chunkGridPosition, source.spec.dataScaler);
          sourceChunkFormat.bindChunk(gl, shader, chunk);

          vertexComputationManager.drawChunk(gl, shader, chunkPosition);
        }
      }
    }
    chunkFormat.endDrawing(gl, shader);
    this.endSlice(shader);
  }

}