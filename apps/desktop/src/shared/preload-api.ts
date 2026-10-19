export interface BebotsBot {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly status: "active" | "archived";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BebotsPreloadApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
  readonly bots: {
    readonly list: (includeArchived?: boolean) => Promise<readonly BebotsBot[]>;
    readonly get: (id: string) => Promise<BebotsBot | null>;
    readonly create: (input: {
      readonly name: string;
      readonly description?: string;
      readonly persona?: string;
    }) => Promise<BebotsBot>;
    readonly update: (
      id: string,
      input: {
        readonly name?: string;
        readonly description?: string;
        readonly persona?: string;
      },
    ) => Promise<BebotsBot>;
    readonly archive: (id: string) => Promise<BebotsBot>;
  };
}
