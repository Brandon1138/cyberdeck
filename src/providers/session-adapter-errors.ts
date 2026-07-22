export class SessionResumeUnavailableError extends Error {
  readonly code = "SESSION_RESUME_UNAVAILABLE";

  constructor(provider: string) {
    super(`${provider} conversation resume is not yet verified for Cyberdeck sessions`);
    this.name = "SessionResumeUnavailableError";
  }
}

export class UnsupportedProviderEffortError extends Error {
  readonly code = "PROVIDER_EFFORT_UNSUPPORTED";

  constructor(provider: string) {
    super(`${provider} does not expose a verified reasoning-effort option`);
    this.name = "UnsupportedProviderEffortError";
  }
}
