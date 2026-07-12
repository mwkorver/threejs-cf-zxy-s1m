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

    varying vec2 vUv;
    varying vec3 vWorldNormal;
    #include <fog_pars_fragment>

    void main() {
      vec4 baseColor = useTexture ? texture2D(map, vUv) : vec4(fallbackColor, 1.0);
      
      // Perform dot product with unexaggerated normal and sun direction
      vec3 normal = normalize(vWorldNormal);
      float diffuse = max(0.0, dot(normal, sunDirection));
      
      // Multiplicative hillshade
      float shade = 1.0 - hillshadeIntensity * (1.0 - diffuse);
      
      vec3 rgb = baseColor.rgb * shade;
      
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
