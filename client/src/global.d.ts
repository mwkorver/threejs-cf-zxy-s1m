export {};

declare global {
  interface ViewerStateTelemetry {
    getCameraPos: () => { x: number; y: number; z: number };
    getCameraRotation: () => { x: number; y: number; z: number };
    setCameraPos: (x: number, y: number, z: number) => void;
    getTileCount: () => number;
    getSpeedKts: () => number;
    getAltitudeFt: () => number;
    isHudVisible: () => boolean;
    stepFrame: (dtMs?: number) => void;
    /** True once the tile pool is idle and every visible node has drawn. */
    isSceneReady: () => boolean;
    /**
     * Live GPU resource counts straight off WebGLRenderer.info, for leak
     * assertions. `textures` and `geometries` are what three.js currently holds
     * on the GPU; they fall only when something is disposed.
     */
    getRendererInfo: () => {
      geometries: number;
      textures: number;
      calls: number;
      triangles: number;
    };
  }

  interface Window {
    __VIEWER_STATE__?: ViewerStateTelemetry;
    __STEP_FRAME__?: (dtMs?: number) => void;
    /**
     * Debug handles for poking at the scene from the browser console. Declared
     * here rather than reached through `window as any` at the assignment, so
     * console use gets completion and the two stay in step with their types.
     * Loosely typed on purpose: importing TileManager/THREE into a .d.ts to
     * name them would make this file a module and break the global augmentation.
     */
    tileManager?: object;
    camera?: object;
  }
}
