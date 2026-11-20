declare module "roughjs/bundled/rough.esm.js" {
  interface RoughPath {
    d: string;
    stroke: string;
    strokeWidth: number;
    fill?: string;
  }

  interface Drawable {
    shape: string;
    sets: unknown[];
    options: unknown;
  }

  interface RoughGenerator {
    path(d: string, options?: Record<string, unknown>): Drawable;
    circle(x: number, y: number, diameter: number, options?: Record<string, unknown>): Drawable;
    toPaths(drawable: Drawable): RoughPath[];
  }

  interface RoughModule {
    generator(): RoughGenerator;
  }

  const rough: RoughModule;
  export default rough;
}
