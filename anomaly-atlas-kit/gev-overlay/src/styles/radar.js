/**
 * Radar: edges only, a slow sweep and range rings. A distinct look from the
 * CRT and night-vision styles, closer to an instrument than a camera.
 */
export const radarShader = {
  name: 'radar',
  uniforms: {
    edgeAmt: { default: 0.8, min: 0, max: 1, label: 'Edges' },
    sweepAmt: { default: 0.7, min: 0, max: 1, label: 'Sweep' },
    gridAmt: { default: 0.5, min: 0, max: 1, label: 'Range rings' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float edgeAmt;
    uniform float sweepAmt;
    uniform float gridAmt;
    in vec2 v_textureCoordinates;

    float lum(vec2 uv) { return dot(texture(colorTexture, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec2 px = 1.0 / colorTextureDimensions;
      vec4 color = texture(colorTexture, uv);
      float gx = lum(uv + vec2(px.x, 0.0)) - lum(uv - vec2(px.x, 0.0));
      float gy = lum(uv + vec2(0.0, px.y)) - lum(uv - vec2(0.0, px.y));
      float edge = clamp(length(vec2(gx, gy)) * 5.0 * edgeAmt, 0.0, 1.0);
      vec2 p = (uv - 0.5) * vec2(colorTextureDimensions.x / colorTextureDimensions.y, 1.0);
      float t = czm_frameNumber / 60.0;
      float sweep = fract(atan(p.y, p.x) / 6.2831853 + 0.5 - t * 0.08);
      float trail = pow(1.0 - sweep, 7.0) * sweepAmt;
      float f = fract(length(p) * 7.0);
      float ring = (1.0 - smoothstep(0.0, 0.015, min(f, 1.0 - f))) * gridAmt * 0.3;
      vec3 ink = vec3(0.85, 0.87, 0.92);
      vec3 ion = vec3(0.25, 0.88, 1.0);
      vec3 result = vec3(lum(uv) * 0.14) + ink * edge * 0.8 + ion * trail * (0.2 + edge) + ink * ring;
      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
