export class FleetError extends Error {
  constructor(message, code = "fleet_error", options = {}) {
    super(message, options);
    this.name = "FleetError";
    this.code = code;
  }
}

export function usageError(message) {
  return new FleetError(message, "usage_error");
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
