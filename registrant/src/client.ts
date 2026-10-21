import {
  REGISTRAR_ROUTES,
  type ApiError,
  type BootstrapSuccess,
  type StatusSuccess,
} from '@vector-sigma/shared';

/**
 * HTTP caller for the registrar API. Injected fetch keeps the whole
 * surface unit-testable with a mocked registrar — no network needed.
 */
export class RegistrarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly balenaUuid: string,
    private readonly registrarKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.registrarKey}`,
    };
  }

  /** POST /v1/bootstrap — returns bundle on 200. */
  async bootstrap(): Promise<BootstrapSuccess> {
    const res = await this.fetchImpl(
      `${this.baseUrl}${REGISTRAR_ROUTES.bootstrap}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ balena_uuid: this.balenaUuid }),
      },
    );
    return this.parse<BootstrapSuccess>(res);
  }

  /** GET /v1/status via querystring (registrar tolerates it). */
  async status(): Promise<StatusSuccess> {
    const url = `${this.baseUrl}${REGISTRAR_ROUTES.status}?balena_uuid=${encodeURIComponent(this.balenaUuid)}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.parse<StatusSuccess>(res);
  }

  /**
   * POST /v1/a2a-key — report the agent's PUBLIC Ed25519 key, the guard's status.json and the
   * applied bundle version (signed A2A identity: docs/a2a-signed-identity.md).
   */
  async reportA2aKey(report: {
    ed25519: string;
    guard_status?: Record<string, unknown> | null;
    bundle_version?: number | null;
  }): Promise<{ status: string; fingerprint: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}${REGISTRAR_ROUTES.a2aKey}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ balena_uuid: this.balenaUuid, ...report }),
    });
    return this.parse<{ status: string; fingerprint: string }>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.ok) {
      return (await res.json()) as T;
    }
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      body = null;
    }
    throw new RegistrarHttpError(res.status, res.headers.get('retry-after'), body);
  }
}

export class RegistrarHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter: string | null,
    public readonly body: ApiError | null,
  ) {
    super(`registrar returned ${status}`);
    this.name = 'RegistrarHttpError';
  }
}