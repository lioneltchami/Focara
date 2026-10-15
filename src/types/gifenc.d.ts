// Minimal types for gifenc (https://github.com/mattdesl/gifenc, MIT).
declare module 'gifenc' {
  export type Palette = number[][];
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
  export interface GIFStream {
    writeFrame(index: Uint8Array, width: number, height: number, options?: {
      palette?: Palette; delay?: number; repeat?: number; first?: boolean;
      transparent?: boolean; transparentIndex?: number; dispose?: number;
    }): void;
    writeHeader(): void;
    finish(): void;
    bytes(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GIFStream;
}
