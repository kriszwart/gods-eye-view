/**
 * Spectral: the world turns into a cool monochrome instrument and only the
 * anomaly spectrum (magenta, violet, ion blue) keeps its colour.
 */
export const spectralShader = {
  name: 'spectral',
  uniforms: {
    keepAmt: { default: 1.0, min: 0, max: 1, label: 'Keep spectrum' },
    coolAmt: { default: 0.6, min: 0, max: 1, label: 'Cool tint' },
    grainAmt: { default: 0.25, min: 0, max: 1, label: 'Grain' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float keepAmt;
    uniform float coolAmt;
    uniform float grainAmt;
    in vec2 v_textureCoordinates;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);
    }
    float band(float h, float a, float b, float feather) {
      return smoothstep(a - feather, a, h) * (1.0 - smoothstep(b, b + feather, h));
    }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec4 color = texture(colorTexture, uv);
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 mono = mix(vec3(luma), luma * vec3(0.86, 0.9, 1.08), coolAmt);
      vec3 hsv = rgb2hsv(color.rgb);
      float spectrum = max(max(band(hsv.x, 0.84, 0.96, 0.03), band(hsv.x, 0.70, 0.80, 0.03)), band(hsv.x, 0.49, 0.55, 0.03));
      float keep = spectrum * smoothstep(0.45, 0.7, hsv.y) * smoothstep(0.3, 0.55, hsv.z) * keepAmt;
      vec3 result = mix(mono, color.rgb, clamp(keep, 0.0, 1.0));
      float grain = fract(sin(dot(uv * colorTextureDimensions + mod(czm_frameNumber, 64.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      result += grain * 0.03 * grainAmt;
      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
