declare module "foliate-js/overlayer.js" {
  type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  type Draw = (rects: Rect[], options?: Record<string, unknown>) => SVGElement;
  export class Overlayer {
    add(key: string, range: Range, draw: Draw, options?: Record<string, unknown>): void;
    remove(key: string): void;
    static highlight: Draw;
    static outline: Draw;
  }
}
