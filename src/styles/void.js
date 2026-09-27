/**
 * Void: the map crushes to the atlas void so luminous anomalies float free
 * of it, the way the craft-specimens page presents them. Oceans and dark
 * water fall almost to black, landmasses survive only as a faint, cool
 * relief with a felt-not-seen coastline hint, and the anomaly spectrum
 * (magenta, violet, ion blue) keeps its full colour, boosted and haloed by
 * a cheap ring-sampled glow so points read like the specimens page rather
 * than a flat highlight.
 */
export const voidShader = {
  name: 'void',
  uniforms: {
    landAmt: { default: 0.1, min: 0, max: 1, label: 'Land brightness' },
    edgeAmt: { default: 0.25, min: 0, max: 1, label: 'Coastline' },
    keepAmt: { default: 1.0, min: 0, max: 1, label: 'Keep spectrum' },
    glowAmt: { default: 0.5, min: 0, max: 1, label: 'Point glow' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float landAmt;
    uniform float edgeAmt;
    uniform float keepAmt;
    uniform float glowAmt;
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
    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    /* How much of a sample is anomaly spectrum (magenta, violet or ion), the
       same three hue bands spectral.js keeps. Basemap ocean water commonly
       renders in this same cyan-leaning hue (measured: h.x around 0.53, the
       middle of the ion band) at moderate saturation, close enough to a
       violet point's own saturation (~0.64) that saturation cannot tell
       them apart; against spectral.js's monochrome-but-still-bright
       treatment that ocean sample was never visible enough to matter, but
       Void's near-black crush makes any partial keep glow. Value is the
       reliable separator instead (ocean measured ~0.47, every point colour
       ~1.0), so the value gate is pushed high while saturation stays loose. */
    float spectrumKeep(vec3 c) {
      vec3 h = rgb2hsv(c);
      float s = max(max(band(h.x, 0.84, 0.96, 0.03), band(h.x, 0.70, 0.80, 0.03)), band(h.x, 0.49, 0.55, 0.03));
      return s * smoothstep(0.4, 0.6, h.y) * smoothstep(0.72, 0.9, h.z);
    }
    /* One glow-ring tap: colour pre-weighted by its own spectrum-keep so the
       ring sum stays a simple weighted average (rgb in .rgb, weight in .a). */
    vec4 glowTap(vec2 uv) {
      vec3 c = texture(colorTexture, uv).rgb;
      float w = spectrumKeep(c);
      return vec4(c * w, w);
    }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec4 color = texture(colorTexture, uv);
      // #070812, not pure black, so the atmosphere rim still reads against it.
      vec3 voidColor = vec3(0.027, 0.031, 0.071);
      float luma = lum(color.rgb);
      // Landmasses survive as a barely-there, desaturated, cool relief
      // capped by landAmt; dark water and space crush toward voidColor.
      vec3 reliefTint = vec3(0.78, 0.85, 1.0);
      vec3 crushed = voidColor + reliefTint * clamp(luma, 0.0, 1.0) * landAmt;

      // A cheap coastline hint: a one-tap forward luminance gradient, not a
      // full edge kernel, so the line is felt rather than seen.
      vec2 px = 1.0 / colorTextureDimensions;
      float dx = lum(texture(colorTexture, uv + vec2(px.x, 0.0)).rgb) - luma;
      float dy = lum(texture(colorTexture, uv + vec2(0.0, px.y)).rgb) - luma;
      float edge = clamp((abs(dx) + abs(dy)) * 6.0, 0.0, 1.0) * edgeAmt;
      crushed += vec3(0.85, 0.92, 1.0) * edge * 0.35;

      // Keep the anomaly spectrum (magenta, violet, ion) in full colour, then
      // push it past the source's own saturation and brightness a little so
      // points and pulses read as luminous against the crushed map, the way
      // the craft-specimens page presents them.
      float keep = spectrumKeep(color.rgb) * keepAmt;
      vec3 hsv = rgb2hsv(color.rgb);
      vec3 vivid = clamp(mix(vec3(hsv.z), color.rgb, 1.35) * 1.12, 0.0, 1.4);
      vec3 result = mix(crushed, vivid, clamp(keep, 0.0, 1.0));

      // Point glow: a cheap 8-tap ring (not a real blur pass) re-running the
      // same spectrum test on nearby texels and additively feathering their
      // colour outward. Weighted by (1 - keep) so it never stacks onto a
      // point's own already-bright pixels (a leading cause of whiteout in
      // dense report clusters, for example France's few thousand points);
      // it only lights the void immediately around them.
      vec2 gpx = px * 3.0;
      vec4 g = vec4(0.0);
      g += glowTap(uv + vec2(gpx.x, 0.0));
      g += glowTap(uv - vec2(gpx.x, 0.0));
      g += glowTap(uv + vec2(0.0, gpx.y));
      g += glowTap(uv - vec2(0.0, gpx.y));
      g += glowTap(uv + vec2(gpx.x, gpx.y)) * 0.7;
      g += glowTap(uv + vec2(-gpx.x, gpx.y)) * 0.7;
      g += glowTap(uv + vec2(gpx.x, -gpx.y)) * 0.7;
      g += glowTap(uv + vec2(-gpx.x, -gpx.y)) * 0.7;
      float glowWeight = clamp(g.a / 4.0, 0.0, 1.0);
      vec3 glowColor = g.a > 1.0e-4 ? g.rgb / g.a : vec3(0.0);
      result += glowColor * glowWeight * (1.0 - keep) * glowAmt * 0.6;

      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
