let csrfToken = '';
export const setCsrf = (token: string) => { csrfToken = token; };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', '连接暂时中断，请检查网络。已经提交的操作可能仍在进行，请先刷新确认。');
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') window.dispatchEvent(new Event('lp:unauthorized'));
    throw new ApiError(response.status, data.error?.code ?? 'request_failed', data.error?.message ?? '请求失败，请稍后重试。');
  }
  return data as T;
}
