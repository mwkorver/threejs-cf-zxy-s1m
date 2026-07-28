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
  }

  interface Window {
    __VIEWER_STATE__?: ViewerStateTelemetry;
    __STEP_FRAME__?: (dtMs?: number) => void;
  }
}
