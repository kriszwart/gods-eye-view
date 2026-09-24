import * as Cesium from 'cesium';

/**
 * The atlas sky: a deeper, cooler atmosphere, a void background and a real
 * night side, so sightings glow against darkness. Returns a restore function
 * that puts GEV's own look back exactly as it was.
 */
export function applyAtlasAtmosphere(viewer) {
  const scene = viewer.scene;
  const globe = scene.globe;
  const sky = scene.skyAtmosphere;
  const prev = {
    background: scene.backgroundColor.clone(),
    sky: sky && [sky.hueShift, sky.saturationShift, sky.brightnessShift],
    globe: globe && [
      globe.atmosphereHueShift,
      globe.atmosphereSaturationShift,
      globe.atmosphereBrightnessShift,
      globe.enableLighting,
    ],
    moon: scene.moon?.show,
  };
  scene.backgroundColor = Cesium.Color.fromCssColorString('#070812');
  if (sky) {
    sky.hueShift = 0.08;
    sky.saturationShift = -0.35;
    sky.brightnessShift = -0.25;
  }
  if (globe) {
    globe.atmosphereHueShift = 0.08;
    globe.atmosphereSaturationShift = -0.3;
    globe.atmosphereBrightnessShift = -0.2;
    globe.enableLighting = true;
  }
  if (scene.moon) scene.moon.show = false;
  scene.requestRender();
  return () => {
    scene.backgroundColor = prev.background;
    if (sky && prev.sky)
      [sky.hueShift, sky.saturationShift, sky.brightnessShift] = prev.sky;
    if (globe && prev.globe)
      [
        globe.atmosphereHueShift,
        globe.atmosphereSaturationShift,
        globe.atmosphereBrightnessShift,
        globe.enableLighting,
      ] = prev.globe;
    if (scene.moon && prev.moon != null) scene.moon.show = prev.moon;
    scene.requestRender();
  };
}
