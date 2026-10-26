import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function usePolling<T>(path: string, interval = 4000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await api<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(value); setError(''); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '刷新失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [path]);
  useEffect(() => {
    setData(undefined); setLoading(true); void refresh();
    const timer = setInterval(() => { if (!document.hidden && !request.current?.signal.aborted) void refresh(); }, interval);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); request.current?.abort(); };
  }, [refresh, interval]);
  return { data, error, loading, refresh };
}

export function useRoute() {
  const read = () => {
    const hash = window.location.hash;
    let id = ''; try { if (hash.startsWith('#/services/')) id = decodeURIComponent(hash.slice(11)); } catch { /* malformed URL falls back to list */ }
    return { id, view: hash.startsWith('#/assets') ? 'assets' : hash.startsWith('#/runtimes') ? 'runtimes' : hash.startsWith('#/activity') ? 'activity' : 'services' };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => { const change = () => setRoute(read()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  return { ...route, navigate: (id?: string) => { window.location.hash = id ? `/services/${id}` : '/services'; }, go: (view: string) => { window.location.hash = `/${view}`; } };
}
