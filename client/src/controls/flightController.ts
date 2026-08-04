import * as THREE from "three";
import { type TileManager } from "../core/tileManager";
import { type HudContext } from "../ui/hud";

export interface FlyToState {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startQuat: THREE.Quaternion;
  endQuat: THREE.Quaternion;
  startTime: number;
  duration: number;
  cruiseAlt: number;
}

export interface FlightControllerContext {
  updateFlight: (dt: number, groundSkyColor: THREE.Color, baseFogDensity: number) => number;
  cancelFlyTo: () => void;
  flyTo: (targetGround: THREE.Vector3) => void;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export function setupFlightController(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tileManager: TileManager,
  hudCtx: HudContext,
  worldAnchor: [number, number]
): FlightControllerContext {
  let flyToState: FlyToState | null = null;
  const activeKeys = new Set<string>();
  let previousMousePosition = { x: 0, y: 0 };
  let speedKnots = 800;

  const velocity = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const compassFwd = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 0, 1);
  const framePrevPos = new THREE.Vector3();

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function cancelFlyTo(): void {
    flyToState = null;
  }

  function pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
    camera.updateMatrixWorld();
    ndc.x = (clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(scene.children, true);
    return hits.length ? hits[0]!.point.clone() : null;
  }

  function rayToPlane(clientX: number, clientY: number, planeZ: number): THREE.Vector3 | null {
    camera.updateMatrixWorld();
    ndc.x = (clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    if (Math.abs(d.z) < 1e-6) return null;
    const t = (planeZ - o.z) / d.z;
    if (t <= 0) return null;
    return tmpV.copy(d).multiplyScalar(t).add(o).clone();
  }

  function flyTo(targetGround: THREE.Vector3): void {
    tileManager.prefetchTargetGround(targetGround, 1500);

    const start = camera.position.clone();
    const dist = start.distanceTo(targetGround);
    const duration = Math.min(8000, Math.max(2000, dist * 0.04));
    const cruiseAlt = Math.max(start.z, targetGround.z) + Math.min(dist * 0.15, 5000);

    const endQuat = new THREE.Quaternion();
    const lookFrom = targetGround.clone();
    lookFrom.z += 1500;
    const lookTarget = targetGround.clone();
    const m = new THREE.Matrix4().lookAt(lookFrom, lookTarget, new THREE.Vector3(0, 1, 0));
    endQuat.setFromRotationMatrix(m);

    flyToState = {
      startPos: start,
      endPos: lookFrom,
      startQuat: camera.quaternion.clone(),
      endQuat,
      startTime: performance.now(),
      duration,
      cruiseAlt,
    };
  }

  function updateFlyTo(): boolean {
    if (!flyToState) return false;
    const s = flyToState;
    const elapsed = performance.now() - s.startTime;
    const t = Math.min(1, elapsed / s.duration);
    const e = smoothstep(t);

    camera.position.lerpVectors(s.startPos, s.endPos, e);
    const arcZ = Math.sin(t * Math.PI) * (s.cruiseAlt - Math.max(s.startPos.z, s.endPos.z));
    camera.position.z += Math.max(0, arcZ);

    camera.quaternion.slerpQuaternions(s.startQuat, s.endQuat, e);

    if (t >= 1) {
      flyToState = null;
    }
    return true;
  }

  const movementCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
  window.addEventListener("keydown", (e) => {
    activeKeys.add(e.code);
    if (movementCodes.has(e.code)) {
      cancelFlyTo();
      if (hudCtx.ctrlPanorama.checked) {
        hudCtx.ctrlPanorama.checked = false;
        hudCtx.ctrlPanorama.dispatchEvent(new Event("change"));
      }
    }
  });
  window.addEventListener("keyup", (e) => activeKeys.delete(e.code));

  window.addEventListener("contextmenu", (e) => {
    if (!hudCtx.hud.contains(e.target as Node)) {
      e.preventDefault();
    }
  });

  let dragMode: "pan" | "orbit" | null = null;
  const panAnchor = new THREE.Vector3();
  let panPlaneZ = 0;
  const orbitTarget = new THREE.Vector3();

  window.addEventListener("mousedown", (e) => {
    if (hudCtx.hud.contains(e.target as Node)) {
      return;
    }
    dragMode = null;
    previousMousePosition = { x: e.clientX, y: e.clientY };

    if (e.button === 0) {
      const g = pickGround(e.clientX, e.clientY);
      panPlaneZ = g ? g.z : 0;
      const anchor = g ?? rayToPlane(e.clientX, e.clientY, panPlaneZ);
      if (anchor) {
        panAnchor.copy(anchor);
        dragMode = "pan";
      }
    } else if (e.button === 2) {
      const t =
        pickGround(window.innerWidth / 2, window.innerHeight / 2) ??
        pickGround(e.clientX, e.clientY) ??
        rayToPlane(window.innerWidth / 2, window.innerHeight / 2, 0);
      if (t) {
        orbitTarget.copy(t);
        dragMode = "orbit";
      }
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (dragMode === null || e.buttons === 0) return;
    cancelFlyTo();
    const dx = e.clientX - previousMousePosition.x;
    const dy = e.clientY - previousMousePosition.y;
    previousMousePosition = { x: e.clientX, y: e.clientY };

    if (dragMode === "pan") {
      const q = rayToPlane(e.clientX, e.clientY, panPlaneZ);
      if (q) camera.position.add(tmpV.copy(panAnchor).sub(q));
    } else {
      const off = tmpV.copy(camera.position).sub(orbitTarget);
      const r = off.length();
      let az = Math.atan2(off.y, off.x);
      let po = Math.acos(Math.min(1, Math.max(-1, off.z / r)));
      az -= dx * 0.005;
      po -= dy * 0.005;
      po = Math.max(0.05, Math.min(1.45, po));
      off.set(r * Math.sin(po) * Math.cos(az), r * Math.sin(po) * Math.sin(az), r * Math.cos(po));
      camera.position.copy(orbitTarget).add(off);
      camera.up.set(0, 0, 1);
      camera.lookAt(orbitTarget);
    }
  });

  window.addEventListener("mouseup", () => {
    dragMode = null;
  });

  window.addEventListener("wheel", (e) => {
    if (hudCtx.hud.contains(e.target as Node)) return;
    e.preventDefault();

    const factor = Math.exp(THREE.MathUtils.clamp(e.deltaY, -400, 400) * 0.0018);

    const groundZ = tileManager.groundZAt(
      camera.position.x + worldAnchor[0],
      camera.position.y + worldAnchor[1]
    ) ?? 0;

    const target = pickGround(e.clientX, e.clientY) ?? rayToPlane(e.clientX, e.clientY, groundZ);
    if (target) {
      const off = tmpV.copy(camera.position).sub(target).multiplyScalar(factor);
      const dist = off.length();
      if (dist > 20 && dist < 8_000_000) camera.position.copy(target).add(off);
    } else {
      const step = Math.max(50, camera.position.z) * (factor - 1);
      const fwd = tmpV.set(0, 0, -1).applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(fwd, -step);
    }

    if (hudCtx.ctrlFollowDem.checked) {
      const newAgl = camera.position.z - groundZ;
      const maxAgl = parseFloat(hudCtx.ctrlAglAlt.max);
      if (newAgl > maxAgl) {
        hudCtx.ctrlFollowDem.checked = false;
        hudCtx.ctrlFollowDem.dispatchEvent(new Event("change"));
      } else {
        hudCtx.setAglTarget(newAgl);
      }
    }
  }, { passive: false });

  window.addEventListener("dblclick", (e) => {
    if (hudCtx.hud.contains(e.target as Node)) return;
    const point = pickGround(e.clientX, e.clientY);
    if (point) flyTo(point);
  });

  function updateFlight(dt: number): number {
    const baseSpeed = hudCtx.getBaseSpeedKnots() * 0.514444;
    const speedMultiplier = activeKeys.has("ShiftLeft") || activeKeys.has("ShiftRight") ? 4 : 1;
    const altitudeFactor = Math.max(1.0, camera.position.z / 1500.0);
    const speed = baseSpeed * speedMultiplier * altitudeFactor;

    framePrevPos.copy(camera.position);

    if (updateFlyTo()) {
      velocity.set(0, 0, 0);
    } else if (hudCtx.ctrlPanorama.checked) {
      const omega = (parseInt(hudCtx.ctrlOrbitSpeed.value) * Math.PI) / 180;
      const yawQuat = tmpQuat.setFromAxisAngle(worldUp, omega * dt);
      camera.quaternion.premultiply(yawQuat);
      velocity.set(0, 0, 0);
    } else {
      const direction = new THREE.Vector3();
      if (activeKeys.has("KeyW")) direction.z -= 1;
      if (activeKeys.has("KeyS")) direction.z += 1;
      if (activeKeys.has("KeyA")) direction.x -= 1;
      if (activeKeys.has("KeyD")) direction.x += 1;

      direction.normalize();
      direction.applyQuaternion(camera.quaternion);

      let verticalInput = 0;
      if (activeKeys.has("KeyQ")) verticalInput -= 1;
      if (activeKeys.has("KeyE")) verticalInput += 1;
      if (verticalInput !== 0 && hudCtx.ctrlFollowDem.checked) {
        hudCtx.setAglTarget(parseFloat(hudCtx.ctrlAglAlt.value) + verticalInput * speed * dt);
      } else {
        direction.z += verticalInput;
      }

      const targetVelocity = tmpV.set(0, 0, 0);
      if (direction.lengthSq() > 0) {
        targetVelocity.copy(direction.normalize()).multiplyScalar(speed);
      }
      const tau = parseFloat(hudCtx.ctrlInertia.value);
      const blend = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      velocity.lerp(targetVelocity, blend);
      if (velocity.lengthSq() < 1e-4) velocity.set(0, 0, 0);

      camera.position.addScaledVector(velocity, dt);
    }

    if (hudCtx.ctrlFollowDem.checked) {
      const groundZ = tileManager.groundZAt(
        camera.position.x + worldAnchor[0],
        camera.position.y + worldAnchor[1]
      );
      if (groundZ !== null) {
        const targetZ = groundZ + parseFloat(hudCtx.ctrlAglAlt.value);
        camera.position.z += (targetZ - camera.position.z) * Math.min(1, dt / 0.2);
      }
    }

    const clearance = parseInt(hudCtx.ctrlClearance.value);
    if (clearance > 0) {
      const groundZ = tileManager.groundZAt(
        camera.position.x + worldAnchor[0],
        camera.position.y + worldAnchor[1]
      );
      if (groundZ !== null && camera.position.z < groundZ + clearance) {
        camera.position.z = groundZ + clearance;
        if (velocity.z < 0) velocity.z = 0;
      }
    }

    speedKnots = dt > 0 ? Math.round((camera.position.distanceTo(framePrevPos) / dt) * 1.94384) : 0;

    compassFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const bearingDeg = (Math.atan2(compassFwd.x, compassFwd.y) * 180) / Math.PI;
    hudCtx.updateCompass(bearingDeg);

    return speedKnots;
  }

  return {
    updateFlight,
    cancelFlyTo,
    flyTo,
  };
}
