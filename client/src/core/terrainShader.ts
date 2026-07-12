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
      
      gl_FragColor = vec4(baseColor.rgb * shade, baseColor.a);
      
      #include <fog_fragment>
    }
  `
};
