import { ApiError, createApiClient, filenameFromDisposition, type FetchLike } from '../../src/web/apiClient';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const owner = { role: 'Owner' as const, identityId: 'OWN-001' };
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe('apiClient', () => {
  it('sends X-Role and X-Identity on role-scoped reads and parses JSON', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ batteries: [], returnedBatteries: [] }));
    const client = createApiClient({ fetch });
    const res = await client.listBatteries(owner);
    expect(res).toEqual({ batteries: [], returnedBatteries: [] });
    expect(calls[0]!.url).toBe('/api/batteries');
    expect(calls[0]!.init.method).toBe('GET');
    expect(headersOf(calls[0]!)['X-Role']).toBe('Owner');
    expect(headersOf(calls[0]!)['X-Identity']).toBe('OWN-001');
  });

  it('does not send role headers for /api/stakeholders', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ roles: [], stakeholders: {} }));
    await createApiClient({ fetch }).getStakeholders();
    expect(headersOf(calls[0]!)['X-Role']).toBeUndefined();
    expect(headersOf(calls[0]!)['X-Identity']).toBeUndefined();
  });

  it('POSTs commands with a JSON body to the encoded battery path', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ battery: null, consentStatus: 'granted' }));
    const res = await createApiClient({ fetch, baseUrl: 'http://127.0.0.1:3000' }).setConsent(owner, 'BR/1', 'grant');
    expect(res.consentStatus).toBe('granted');
    expect(calls[0]!.url).toBe('http://127.0.0.1:3000/api/batteries/BR%2F1/consent');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ action: 'grant' });
  });

  it('builds the Scope 3 query string', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ report: {} }));
    await createApiClient({ fetch }).getScope3Report(
      { role: 'ESG_Officer', identityId: 'ESG-001' },
      { start: '2025-01-01', end: '2025-12-31', manufacturer: 'Volt, Inc.' },
    );
    const url = new URL(calls[0]!.url, 'http://x');
    expect(url.pathname).toBe('/api/scope3');
    expect(url.searchParams.get('start')).toBe('2025-01-01');
    expect(url.searchParams.get('end')).toBe('2025-12-31');
    expect(url.searchParams.get('manufacturer')).toBe('Volt, Inc.');
  });

  it('returns CSV text and the attachment filename', async () => {
    const csv = 'battery_id,disposition\r\nBR-1,"a,b"\r\n';
    const { fetch } = mockFetch(
      () =>
        new Response(csv, {
          status: 200,
          headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="scope3-2025-01-01-2025-12-31.csv"' },
        }),
    );
    const res = await createApiClient({ fetch }).downloadScope3Csv(
      { role: 'ESG_Officer', identityId: 'ESG-001' },
      { start: '2025-01-01', end: '2025-12-31' },
    );
    expect(res).toEqual({ filename: 'scope3-2025-01-01-2025-12-31.csv', csv });
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
  });

  it('maps server error bodies to ApiError with code, status, fields, and the operation name', async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid repair', fields: [{ field: 'actionTaken', message: 'Required' }] } },
        422,
      ),
    );
    const err = await createApiClient({ fetch })
      .logRepair({ role: 'Service_Partner', identityId: 'SP-001' }, 'BR-1', {
        date: '2025-01-01',
        faultCode: '',
        actionTaken: '',
        modulesReplaced: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('VALIDATION_ERROR');
    expect(apiErr.status).toBe(422);
    expect(apiErr.fieldMessage('actionTaken')).toBe('Required');
    expect(apiErr.message).toBe('Logging repair failed: Invalid repair');
  });

  it('maps a non-JSON error response to HTTP_ERROR and invalid success JSON to BAD_RESPONSE', async () => {
    const bad = createApiClient({ fetch: async () => new Response('<html>', { status: 502 }) });
    await expect(bad.listBatteries(owner)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 502 });
    const garbled = createApiClient({ fetch: async () => new Response('not json', { status: 200 }) });
    await expect(garbled.listBatteries(owner)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('maps a rejected fetch to NETWORK', async () => {
    const client = createApiClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(client.handOver({ role: 'Fleet_Operator', identityId: 'FLT-001' }, 'BR-1')).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'Hand over failed: Could not reach the server',
    });
  });

  describe('timeout and abort', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('times out after 10 seconds with a TIMEOUT error even if fetch never settles', async () => {
      let signal: AbortSignal | undefined;
      const client = createApiClient({
        fetch: (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
      });
      const pending = client.listBatteries(owner).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = (await pending) as ApiError;
      expect(err.code).toBe('TIMEOUT');
      expect(err.message).toMatch(/^Loading batteries failed: .*10 seconds/);
      expect(signal?.aborted).toBe(true);
    });

    it('reports ABORTED when the caller aborts', async () => {
      const client = createApiClient({ fetch: () => new Promise<Response>(() => undefined) });
      const controller = new AbortController();
      const pending = client.listBatteries(owner, controller.signal).catch((e: unknown) => e);
      controller.abort();
      expect(await pending).toMatchObject({ code: 'ABORTED' });
    });
  });
});
