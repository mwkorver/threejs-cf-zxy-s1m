import { describe, expect, it } from "vitest";
import { decodeTerrarium, decodeTerrariumPixel } from "./terrarium";

describe("terrarium decode", () => {
  it("decodes sea level", () => {
    expect(decodeTerrariumPixel(128, 0, 0)).toBe(0);
  });

  it("matches the reference formula", () => {
    // Mirrors tiler/tests/test_encoding.py — client and server must agree
    // bit-for-bit on the contract.
    expect(decodeTerrariumPixel(128, 100, 64)).toBe(100 + 64 / 256);
    expect(decodeTerrariumPixel(127, 170, 0)).toBe(-86); // Death Valley
  });

  it("decodes RGBA buffers", () => {
    const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 64, 255]);
    const out = decodeTerrarium(rgba, 2, 1);
    expect(Array.from(out)).toEqual([0, 100.25]);
  });
});
