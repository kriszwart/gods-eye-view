/**
 * Infrared: a heat ramp in the atlas palette (void, violet, magenta, amber,
 * white). The anomaly layer also reveals infrared-only craft while it is on.
 */
export const infraredShader = {
  name: 'infrared',
  uniforms: {
    gainAmt: { default: 1.15, min: 0.5, max: 2, label: 'Gain' },
    contrastAmt: { default: 1.3, min: 0.5, max: 2.5, label: 'Contrast' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform float intensity;
    uniform float gainAmt;
    uniform float contrastAmt;
    in vec2 v_textureCoordinates;

    vec3 ramp(float t) {
      vec3 c0 = vec3(0.02, 0.02, 0.07);
      vec3 c1 = vec3(0.26, 0.14, 0.6);
      vec3 c2 = vec3(0.95, 0.16, 0.55);
      vec3 c3 = vec3(1.0, 0.64, 0.2);
      vec3 c4 = vec3(1.0, 0.98, 0.9);
      t = clamp(t, 0.0, 1.0);
      if (t < 0.25) return mix(c0, c1, t / 0.25);
      if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
      if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
      return mix(c3, c4, (t - 0.75) / 0.25);
    }

    void main() {
      vec4 color = texture(colorTexture, v_textureCoordinates);
      float l = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      float heat = pow(clamp(l * gainAmt, 0.0, 1.0), 1.0 / contrastAmt);
      out_FragColor = vec4(mix(color.rgb, ramp(heat), intensity), color.a);
    }
  `,
};
