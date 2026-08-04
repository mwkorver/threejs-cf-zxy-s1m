export const TerrainShader = {
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldNormal;
    varying float vElevation;
    #include <fog_pars_vertex>

    void main() {
      vUv = uv;
      vWorldNormal = normal;
      vElevation = position.z;
      
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
    uniform float demSourceType; // 0.0=farfield, 1.0=usgs13, 2.0=s1m, 3.0=flat
    uniform float shadingMode;   // 0.0=satellite, 1.0=DEM, 2.0=hypsometric
    uniform float hypsometricBlend; // 0.0 to 1.0
    uniform float useLocalHypso;    // 0.0 = global, 1.0 = local to viewport
    uniform float localMinElev;
    uniform float localMaxElev;
    uniform float uZScale; // vertex Z = trueElevation * sec(lat); divide to recover metres
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;

    varying vec2 vUv;
    varying vec3 vWorldNormal;
    varying float vElevation;
    #include <fog_pars_fragment>

    vec3 getHypsometricColor(float height) {
      float minE = useLocalHypso > 0.5 ? localMinElev : 0.0;
      float maxE = useLocalHypso > 0.5 ? localMaxElev : 4000.0;
      
      float h = clamp(height, minE, maxE);
      float range = max(1.0, maxE - minE);
      float t = (h - minE) / range;
      
      vec3 c0 = vec3(0.12, 0.45, 0.15); // dark green (low)
      vec3 c1 = vec3(0.56, 0.73, 0.35); // light green
      vec3 c2 = vec3(0.92, 0.85, 0.55); // yellow/tan
      vec3 c3 = vec3(0.65, 0.42, 0.25); // brown
      vec3 c4 = vec3(0.95, 0.95, 0.95); // white/peak
      
      if (t < 0.05) {
        return mix(c0, c1, t / 0.05);
      } else if (t < 0.25) {
        return mix(c1, c2, (t - 0.05) / 0.20);
      } else if (t < 0.625) {
        return mix(c2, c3, (t - 0.25) / 0.375);
      } else {
        return mix(c3, c4, (t - 0.625) / 0.375);
      }
    }

    void main() {
      vec4 baseColor;
      if (shadingMode > 1.5) {
        // Hypsometric tinting blended with imagery. vElevation is Mercator-
        // scaled (elevation * sec(lat)); divide by uZScale for true metres so
        // it matches the true-metre elevation bounds.
        vec3 hypCol = getHypsometricColor(vElevation / max(uZScale, 0.0001));
        vec3 satCol = useTexture ? texture2D(map, vUv).rgb : fallbackColor;
        
        // Pre-apply color adjustments to the satellite part before blending
        if (useTexture) {
          satCol *= brightness;
          satCol = (satCol - 0.5) * contrast + 0.5;
          float luma = dot(satCol, vec3(0.299, 0.587, 0.114));
          satCol = mix(vec3(luma), satCol, saturation);
          satCol = clamp(satCol, 0.0, 1.0);
        }
        
        baseColor = vec4(mix(satCol, hypCol, hypsometricBlend), 1.0);
      } else if (shadingMode > 0.5) {
        // DEM Shading (DEM Colors)
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
        // Satellite / normal imagery: sample texture if present; if 404/absent,
        // render smooth elevation-tinted terrain color so holes blend seamlessly.
        if (useTexture) {
          baseColor = texture2D(map, vUv);
        } else {
          vec3 hypCol = getHypsometricColor(vElevation / max(uZScale, 0.0001));
          baseColor = vec4(hypCol, 1.0);
        }
      }
      
      // Perform dot product with unexaggerated normal and sun direction
      vec3 normal = normalize(vWorldNormal);
      float diffuse = max(0.0, dot(normal, sunDirection));
      
      // Multiplicative hillshade
      float shade = 1.0 - hillshadeIntensity * (1.0 - diffuse);
      
      vec3 rgb = baseColor.rgb * shade;
      
      // Apply brightness, contrast, and saturation adjustments to textures ONLY in satellite mode
      if (shadingMode < 0.5 && useTexture) {
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
