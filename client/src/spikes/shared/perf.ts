/**
 * Frame-timing harness shared by the engine spikes (plan §10.2).
 *
 * Uniform metric across all three engines: end-to-end frame interval via rAF
 * (same method everywhere) -> mean FPS plus p95/max interval, which is the
 * frame-pacing jank that matters for a smooth low pass. Secondary: CPU cost
 * per frame (engine's update+submit), measured best-effort per engine (timed
 * render call for three/luma; deck.gl's own metrics), so it's indicative of
 * headroom for prefetch + physics rather than a strict apples-to-apples.
 *
 * A run is warm-up (discarded) then a fixed timed window that latches stats.
 */

export interface BenchStats {
  frames: number;
  fps: number;
  jankP95: number; // p95 frame interval, ms
  jankMax: number;
  cpuP50: number;
  cpuP95: number;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export class Bench {
  private cpu: number[] = [];
  private intervals: number[] = [];
  private start = -1;
  private latched: BenchStats | null = null;

  constructor(
    readonly engine: string,
    private hud: HTMLElement,
    private warmupMs = 1500,
    private windowMs = 12000,
  ) {}

  /** Once per frame: CPU ms (best-effort), rAF interval ms, timestamp. */
  sample(cpuMs: number, intervalMs: number, now: number): void {
    if (this.start < 0) this.start = now;
    const elapsed = now - this.start;
    if (elapsed >= this.warmupMs && !this.latched) {
      this.cpu.push(cpuMs);
      this.intervals.push(intervalMs);
    }
    if (!this.latched && elapsed >= this.warmupMs + this.windowMs) {
      this.latched = this.compute();
      console.log(`[bench:${this.engine}]`, JSON.stringify(this.latched));
    }
    this.render(elapsed);
  }

  private compute(): BenchStats {
    const cpu = [...this.cpu].sort((a, b) => a - b);
    const iv = [...this.intervals].sort((a, b) => a - b);
    const mean = this.intervals.reduce((s, v) => s + v, 0) / (this.intervals.length || 1);
    return {
      frames: this.intervals.length,
      fps: 1000 / mean,
      jankP95: pct(iv, 0.95),
      jankMax: iv[iv.length - 1] ?? 0,
      cpuP50: pct(cpu, 0.5),
      cpuP95: pct(cpu, 0.95),
    };
  }

  get result(): BenchStats | null {
    return this.latched;
  }

  private render(elapsed: number): void {
    const s = this.latched ?? this.compute();
    const phase = this.latched
      ? "done"
      : elapsed < this.warmupMs
        ? "warmup"
        : `timing ${Math.round((this.warmupMs + this.windowMs - elapsed) / 1000)}s`;
    this.hud.textContent =
      `${this.engine}  ·  ${phase}\n` +
      `fps ${s.fps.toFixed(0)}   frame p95 ${s.jankP95.toFixed(1)}ms  max ${s.jankMax.toFixed(1)}ms\n` +
      `cpu/frame  p50 ${s.cpuP50.toFixed(2)}ms  p95 ${s.cpuP95.toFixed(2)}ms   ·  ${s.frames} frames`;
  }
}

export function mountHud(): HTMLElement {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:absolute;top:10px;left:12px;z-index:10;margin:0;white-space:pre;" +
    "font:12px ui-monospace,Menlo,monospace;color:#cfe0f0;background:rgba(13,19,26,.72);" +
    "padding:8px 11px;border-radius:6px;line-height:1.5";
  document.body.appendChild(el);
  return el;
}
