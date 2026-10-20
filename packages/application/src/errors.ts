export class ValidationError extends Error {
  readonly _tag = "ValidationError";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  readonly _tag = "NotFoundError";
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class RepositoryError extends Error {
  readonly _tag = "RepositoryError";
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RepositoryError";
    this.cause = cause;
  }
}

export class WorkspaceError extends Error {
  readonly _tag = "WorkspaceError";
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WorkspaceError";
    this.cause = cause;
  }
}

/** A service was constructed without a collaborator it needs at runtime. */
export class ServiceError extends Error {
  readonly _tag = "ServiceError";
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}
