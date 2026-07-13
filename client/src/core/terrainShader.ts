import * as THREE from "three";

export const TerrainShader = {
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldNormal;
    #include <fog_pars_vertex>

    void main() {
      vUv = uv;
      vWorldNormal = normal;
      
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      
      #include <fog_vertex>
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform bool useTexture;
    uniform vec3 fallbackColor;
    uniform float hillshadeIntensity;
    uniform vec3 sunDirection;
    uniform bool showOutlines;
    uniform bool showDemColors;
    uniform float demSourceType; // 0.0=farfield, 1.0=usgs13, 2.0=s1m, 3.0=flat
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;

    varying vec2 vUv;
    varying vec3 vWorldNormal;
    #include <fog_pars_fragment>

    void main() {
      vec4 baseColor;
      if (showDemColors) {
        vec3 col = vec3(0.4, 0.4, 0.4); // farfield dark gray
        if (demSourceType > 2.5) {
          col = vec3(0.8, 0.7, 0.0); // flat (no DEM) yellow
        } else if (demSourceType > 1.5) {
          col = vec3(0.0, 0.8, 0.8); // s1m cyan
        } else if (demSourceType > 0.5) {
          col = vec3(0.8, 0.0, 0.8); // usgs13 magenta
        }
        baseColor = vec4(col, 1.0);
      } else {
        baseColor = useTexture ? texture2D(map, vUv) : vec4(fallbackColor, 1.0);
      }
      
      // Perform dot product with unexaggerated normal and sun direction
      vec3 normal = normalize(vWorldNormal);
      float diffuse = max(0.0, dot(normal, sunDirection));
      
      // Multiplicative hillshade
      float shade = 1.0 - hillshadeIntensity * (1.0 - diffuse);
      
      vec3 rgb = baseColor.rgb * shade;
      
      // Apply brightness, contrast, and saturation adjustments to textures
      if (!showDemColors && useTexture) {
        // Brightness
        rgb *= brightness;

        // Contrast (relative to 0.5 middle gray)
        rgb = (rgb - 0.5) * contrast + 0.5;

        // Saturation (using standard luma coefficients)
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        rgb = mix(vec3(luma), rgb, saturation);

        // Keep values in valid [0, 1] range
        rgb = clamp(rgb, 0.0, 1.0);
      }
      
      if (showOutlines) {
        // Use screen-space derivatives to compute a crisp 1.5-pixel wide border
        vec2 uvDeriv = fwidth(vUv);
        vec2 edgeThreshold = uvDeriv * 1.5;
        bool isEdge = vUv.x < edgeThreshold.x || vUv.x > 1.0 - edgeThreshold.x ||
                      vUv.y < edgeThreshold.y || vUv.y > 1.0 - edgeThreshold.y;
        if (isEdge) {
          rgb = mix(rgb, vec3(1.0, 1.0, 1.0), 0.7); // blend with white outline
        }
      }
      
      gl_FragColor = vec4(rgb, baseColor.a);
      
      #include <fog_fragment>
    }
  `
};
