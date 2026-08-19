/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Support for rendering sphere annotations.
 *
 * A sphere annotation is defined by two points at opposite ends of a diameter,
 * so its centre is their midpoint and its radius half their separation.
 *
 * The cross-section view draws the axis between the two points with endpoint
 * markers, like a Line annotation but with sphere-specific setter names. The
 * perspective view additionally draws the sphere itself as shaded geometry.
 */

import type { Sphere } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationRenderContext,
  AnnotationShaderGetter,
} from "#src/annotation/type_handler.js";
import {
  AnnotationRenderHelper,
  registerAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { projectPointToLineSegment } from "#src/util/geom.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
  VERTICES_PER_CIRCLE,
} from "#src/webgl/circles.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVectorArrayVertexShaderInput } from "#src/webgl/shader_lib.js";
import { SphereRenderHelper } from "#src/webgl/spheres.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

function defineNoOpEndpointMarkerSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setSphereEndpointMarkerSize(float startSize, float endSize) {}
void setSphereEndpointMarkerBorderWidth(float startSize, float endSize) {}
void setSphereEndpointMarkerColor(vec4 startColor, vec4 endColor) {}
void setSphereEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {}
`);
}

function defineNoOpSphereSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setSphereColor(vec4 color) {}
`);
}

// The axis between the two points is no longer drawn, but the setters remain
// defined so that saved shaders which call them still compile.
function defineNoOpAxisSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setSphereAxisWidth(float width) {}
void setSphereAxisColor(vec4 startColor, vec4 endColor) {}
`);
}

class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    const { rank } = this;
    defineVectorArrayVertexShaderInput(
      builder,
      "float",
      WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
      "VertexPosition",
      rank,
      2,
    );
    builder.addVertexCode(`
struct SphereParams {
  highp vec3 subspaceCenter;
  highp vec3 subspaceRadii;
  highp float clipCoefficient;
  bool cull;
};
SphereParams getSphereParams() {
  SphereParams params;
  highp float modelPositionA[${rank}] = getVertexPosition0();
  highp float modelPositionB[${rank}] = getVertexPosition1();
  highp float modelCenter[${rank}];
  highp float modelRadii[${rank}];
  float diameterSquared = 0.0;
  for (int i = 0; i < ${rank}; ++i) {
    float dx = modelPositionA[i] - modelPositionB[i];
    diameterSquared += dx * dx;
    modelCenter[i] = (modelPositionA[i] + modelPositionB[i]) * 0.5;
  }
  float radius = sqrt(diameterSquared) * 0.5;
  for (int i = 0; i < ${rank}; ++i) {
    modelRadii[i] = radius;
  }
  float radiusAdjustment = 1.0;
  float clipCoefficient = 1.0;
  for (int i = 0; i < ${rank}; ++i) {
    float r = modelRadii[i];
    float c = modelCenter[i];
    float x = uModelClipBounds[i];
    float clipRadius = uModelClipBounds[i + ${rank}];
    if (r != 0.0 && clipRadius != 0.0) {
      float d = c - x;
      d = d * d;
      radiusAdjustment -= d / (r * r);
    }
    float e = abs(x - clamp(x, c - r, c + r)) * clipRadius;
    clipCoefficient *= max(0.0, 1.0 - e);
  }
  radiusAdjustment = sqrt(max(0.0, radiusAdjustment));
  params.subspaceCenter = projectModelVectorToSubspace(modelCenter);
  params.subspaceRadii = projectModelVectorToSubspace(modelRadii) * radiusAdjustment;
  params.clipCoefficient = clipCoefficient;
  params.cull = clipCoefficient == 0.0 || radiusAdjustment == 0.0;
  return params;
}
`);
  }

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  private endpointShaderGetter = this.getDependentShader(
    "annotation/sphere/endpoint",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp vec4", "vBorderColor");
      defineNoOpAxisSetters(builder);
      defineNoOpSphereSetters(builder);
      builder.addVertexCode(`
float ng_markerDiameter;
float ng_markerBorderWidth;
int getEndpointIndex() {
  return gl_VertexID / ${VERTICES_PER_CIRCLE};
}
void setSphereEndpointMarkerSize(float startSize, float endSize) {
  ng_markerDiameter = mix(startSize, endSize, float(getEndpointIndex()));
}
void setSphereEndpointMarkerBorderWidth(float startSize, float endSize) {
  ng_markerBorderWidth = mix(startSize, endSize, float(getEndpointIndex()));
}
void setSphereEndpointMarkerColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, float(getEndpointIndex()));
}
void setSphereEndpointMarkerBorderColor(vec4 startColor, vec4 endColor) {
  vBorderColor = mix(startColor, endColor, float(getEndpointIndex()));
}
`);
      builder.setVertexMain(`
float modelPosition[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPosition[i], modelPositionB[i], float(getEndpointIndex()));
}
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
${this.invokeUserMain}
emitCircle(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
${this.setPartIndex(builder, "uint(getEndpointIndex()) + 1u")};
`);
      builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
    },
  );

  // The cross section of a sphere is always a circle, so this reuses the circle
  // shader rather than the general ellipse machinery in ellipsoid.ts.
  // getSphereParams already shrinks the radius to the cross section at the
  // current plane, so what is left is projecting it into pixels.
  private crossSectionShaderGetter = this.getDependentShader(
    "annotation/sphere/crossSection",
    (builder: ShaderBuilder) => {
      this.defineShader(builder);
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp vec4", "vBorderColor");
      defineNoOpAxisSetters(builder);
      defineNoOpEndpointMarkerSetters(builder);
      builder.addVertexCode(`
void setSphereColor(vec4 color) {
  vBorderColor = color;
}
`);
      builder.setVertexMain(`
SphereParams params = getSphereParams();
if (params.cull) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vClipCoefficient = params.clipCoefficient;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
${this.invokeUserMain}
vec4 clipCenter = uModelViewProjection * vec4(params.subspaceCenter, 1.0);
float w = max(abs(clipCenter.w), 1e-6);
// Project a radius offset along each subspace axis and keep the longest: in a
// slice view the axis lying along the plane normal projects to nothing, so the
// longest is the in-plane radius.
float pixelRadius = 0.0;
for (int i = 0; i < 3; ++i) {
  vec3 offset = vec3(0.0);
  offset[i] = params.subspaceRadii[i];
  vec4 clipOffset = uModelViewProjection * vec4(offset, 0.0);
  vec2 pixelOffset = vec2(clipOffset.x * 0.5 / (uCircleParams.x * w),
                          clipOffset.y * 0.5 / (uCircleParams.y * w));
  pixelRadius = max(pixelRadius, length(pixelOffset));
}
emitCircle(clipCenter, 2.0 * pixelRadius, 1.0);
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
    },
  );

  drawCrossSection(context: AnnotationRenderContext) {
    this.enable(this.crossSectionShaderGetter, context, (shader) => {
      initializeCircleShader(
        shader,
        context.renderContext.projectionParameters,
        { featherWidthInPixels: 0.5 },
      );
      drawCircles(shader.gl, 1, context.count);
    });
  }

  enable(
    shaderGetter: AnnotationShaderGetter,
    context: AnnotationRenderContext,
    callback: (shader: ShaderProgram) => void,
    usingVertexIdHelper = true,
  ) {
    super.enable(shaderGetter, context, (shader) => {
      const binder = shader.vertexShaderInputBinders.VertexPosition;
      binder.enable(1);
      this.gl.bindBuffer(
        WebGL2RenderingContext.ARRAY_BUFFER,
        context.buffer.buffer,
      );
      binder.bind(this.geometryDataStride, context.bufferOffset);
      const { vertexIdHelper } = this;
      if (usingVertexIdHelper) vertexIdHelper.enable();
      callback(shader);
      if (usingVertexIdHelper) vertexIdHelper.disable();
      binder.disable();
    });
  }

  drawEndpoints(context: AnnotationRenderContext) {
    this.enable(this.endpointShaderGetter, context, (shader) => {
      initializeCircleShader(
        shader,
        context.renderContext.projectionParameters,
        { featherWidthInPixels: 0.5 },
      );
      drawCircles(shader.gl, 2, context.count);
    });
  }

  draw(context: AnnotationRenderContext) {
    this.drawEndpoints(context);
    this.drawCrossSection(context);
  }
}

function snapPositionToLine(position: Float32Array, endpoints: Float32Array) {
  const rank = position.length;
  projectPointToLineSegment(
    position,
    endpoints.subarray(0, rank),
    endpoints.subarray(rank),
    position,
  );
}

function snapPositionToEndpoint(
  position: Float32Array,
  endpoints: Float32Array,
  endpointIndex: number,
) {
  const rank = position.length;
  const startOffset = rank * endpointIndex;
  for (let i = 0; i < rank; ++i) {
    position[i] = endpoints[startOffset + i];
  }
}

/**
 * Draws the sphere itself as shaded geometry, on top of the axis and endpoint
 * markers. Only used in the perspective view: the lighting parameters it needs
 * come from PerspectiveViewRenderContext.
 */
class PerspectiveRenderHelper extends RenderHelper {
  private sphereRenderHelper = this.registerDisposer(
    new SphereRenderHelper(this.gl, 20, 20),
  );

  private sphereShaderGetter = this.getDependentShader(
    "annotation/sphere/projection",
    (builder: ShaderBuilder) => {
      this.defineShader(builder);
      this.sphereRenderHelper.defineShader(builder);
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp mat4", "uNormalTransform");
      builder.addVarying("highp float", "vClipCoefficient");
      defineNoOpAxisSetters(builder);
      defineNoOpEndpointMarkerSetters(builder);
      builder.addVertexCode(`
void setSphereColor(vec4 color) {
  vColor = vec4(color.rgb, color.a * 0.5);
}
`);
      builder.setVertexMain(`
SphereParams params = getSphereParams();
if (params.cull) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vClipCoefficient = params.clipCoefficient;
${this.invokeUserMain}
emitSphere(uModelViewProjection, uNormalTransform, params.subspaceCenter,
           params.subspaceRadii, uLightDirection);
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb * vLightingFactor, vColor.a * vClipCoefficient));
`);
    },
  );

  private tempLightVec = new Float32Array(4);

  drawSphere(
    context: AnnotationRenderContext & {
      renderContext: PerspectiveViewRenderContext;
    },
  ) {
    this.enable(
      this.sphereShaderGetter,
      context,
      (shader) => {
        const { gl } = shader;
        const lightVec = <vec3>this.tempLightVec;
        const { lightDirection, ambientLighting, directionalLighting } =
          context.renderContext;
        vec3.scale(lightVec, lightDirection, directionalLighting);
        lightVec[3] = ambientLighting;
        gl.uniform4fv(shader.uniform("uLightDirection"), lightVec);
        gl.uniformMatrix4fv(
          shader.uniform("uNormalTransform"),
          /*transpose=*/ false,
          mat4.transpose(mat4.create(), context.renderSubspaceInvModelMatrix),
        );
        this.sphereRenderHelper.draw(shader, context.count);
      },
      // SphereRenderHelper supplies its own vertex attributes.
      /*usingVertexIdHelper=*/ false,
    );
  }

  draw(
    context: AnnotationRenderContext & {
      renderContext: PerspectiveViewRenderContext;
    },
  ) {
    this.drawEndpoints(context);
    this.drawSphere(context);
  }
}

registerAnnotationTypeRenderHandler<Sphere>(AnnotationType.SPHERE, {
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: PerspectiveRenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpEndpointMarkerSetters(builder);
    defineNoOpAxisSetters(builder);
    defineNoOpSphereSetters(builder);
  },
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition(position, data, offset, partIndex) {
    const rank = position.length;
    const endpoints = new Float32Array(data, offset, rank * 2);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, endpoints);
    } else {
      snapPositionToEndpoint(
        position,
        endpoints,
        partIndex - ENDPOINTS_PICK_OFFSET,
      );
    }
  },
  getRepresentativePoint(out, ann, partIndex) {
    out.set(
      partIndex === FULL_OBJECT_PICK_OFFSET ||
        partIndex === ENDPOINTS_PICK_OFFSET
        ? ann.pointA
        : ann.pointB,
    );
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    const baseSphere = { ...oldAnnotation };
    const rank = position.length;
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET: {
        const { pointA, pointB } = oldAnnotation;
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const pos = (newPointA[i] = position[i]);
          newPointB[i] = pointB[i] + (pos - pointA[i]);
        }
        return { ...oldAnnotation, pointA: newPointA, pointB: newPointB };
      }
      case FULL_OBJECT_PICK_OFFSET + 1:
        return { ...oldAnnotation, pointA: new Float32Array(position) };
      case FULL_OBJECT_PICK_OFFSET + 2:
        return { ...oldAnnotation, pointB: new Float32Array(position) };
    }
    return baseSphere;
  },
});
