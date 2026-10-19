export interface BebotsPreloadApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
}
