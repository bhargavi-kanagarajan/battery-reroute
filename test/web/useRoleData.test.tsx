import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiError, createApiClient, type RoleContext } from '../../src/web/apiClient';
import { useRoleData } from '../../src/web/useRoleData';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const a: RoleContext = { role: 'Owner', identityId: 'OWN-001' };
const b: RoleContext = { role: 'Owner', identityId: 'OWN-002' };

describe('useRoleData', () => {
  it('shows loading, then the data', async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useRoleData(a, () => d.promise));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await act(async () => d.resolve('one'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('one');
    expect(result.current.dataContext).toEqual(a);
    expect(result.current.error).toBeUndefined();
  });

  it('keeps the last good data on error and clears the error after a successful refresh', async () => {
    let n = 0;
    const load = vi.fn(async () => {
      n++;
      if (n === 2) throw new ApiError('Loading batteries', 'INTERNAL', 'Internal server error', { status: 500 });
      return `v${n}`;
    });
    const { result } = renderHook(() => useRoleData(a, load));
    await waitFor(() => expect(result.current.data).toBe('v1'));

    await act(() => result.current.refresh());
    expect(result.current.data).toBe('v1');
    expect(result.current.error?.message).toBe('Loading batteries failed: Internal server error');
    expect(result.current.loading).toBe(false);

    await act(() => result.current.refresh());
    expect(result.current.data).toBe('v3');
    expect(result.current.error).toBeUndefined();
  });

  it('discards a stale response from a superseded selection', async () => {
    const pending = new Map<string, Deferred<string>>();
    const load = (ctx: RoleContext) => {
      const d = deferred<string>();
      pending.set(ctx.identityId, d);
      return d.promise;
    };
    const { result, rerender } = renderHook(({ ctx }) => useRoleData(ctx, load), { initialProps: { ctx: a } });
    rerender({ ctx: b });
    await act(async () => pending.get('OWN-002')!.resolve('for-b'));
    await act(async () => pending.get('OWN-001')!.resolve('for-a'));
    expect(result.current.data).toBe('for-b');
    expect(result.current.dataContext).toEqual(b);
  });

  it('aborts the previous request when the selection changes', async () => {
    const signals: AbortSignal[] = [];
    const load = (_ctx: RoleContext, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    };
    const { rerender } = renderHook(({ ctx }) => useRoleData(ctx, load), { initialProps: { ctx: a } });
    rerender({ ctx: b });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('does not reload on re-render with an equal selection, but reloads when key changes', async () => {
    const load = vi.fn(async () => 'x');
    const { rerender } = renderHook(({ ctx, k }) => useRoleData(ctx, load, { key: k }), {
      initialProps: { ctx: { ...a }, k: '1' },
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender({ ctx: { ...a }, k: '1' });
    rerender({ ctx: { ...a }, k: '2' });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('does not load without a selection', () => {
    const load = vi.fn(async () => 'x');
    const { result } = renderHook(() => useRoleData(null, load));
    expect(load).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('setData applies a command result without a round trip', async () => {
    const { result } = renderHook(() => useRoleData(a, async () => [1]));
    await waitFor(() => expect(result.current.data).toEqual([1]));
    act(() => result.current.setData((prev) => [...(prev ?? []), 2]));
    expect(result.current.data).toEqual([1, 2]);
  });

  it('works end to end with the ApiClient and a mocked fetch (refresh after command)', async () => {
    let consent = 'not_granted';
    const client = createApiClient({
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          consent = 'granted';
          return new Response(JSON.stringify({ battery: null, consentStatus: consent }), { status: 200 });
        }
        return new Response(JSON.stringify({ batteries: [{ batteryId: 'BR-1', consentStatus: consent }], returnedBatteries: [] }), {
          status: 200,
        });
      },
    });
    const { result } = renderHook(() =>
      useRoleData(a, (ctx, signal) => client.listBatteries({ ...ctx, role: 'Owner' }, signal), { operation: 'Loading batteries' }),
    );
    await waitFor(() => expect(result.current.data?.batteries[0]?.consentStatus).toBe('not_granted'));
    await act(async () => {
      await client.setConsent(a, 'BR-1', 'grant');
      await result.current.refresh();
    });
    expect(result.current.data?.batteries[0]?.consentStatus).toBe('granted');
  });
});
