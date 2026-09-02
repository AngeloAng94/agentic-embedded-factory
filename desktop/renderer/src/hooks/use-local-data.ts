import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Project, type ProjectFile, type Message, type Run } from "../lib/api";

/**
 * Hook: fetch data with auto-refresh. Returns { data, refresh, loading, error }.
 */
function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetcher();
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  return { data, loading, error, refresh: load };
}

// ─── Project hooks ────────────────────────────────────────
export function useProjects() {
  return useFetch(() => api.getProjects());
}

export function useProject(projectId: string | null) {
  return useFetch(
    () => (projectId ? api.getProject(projectId) : Promise.resolve(undefined as unknown as Project)),
    [projectId]
  );
}

export function useFiles(projectId: string | null) {
  return useFetch(
    () => (projectId ? api.getFiles(projectId) : Promise.resolve([] as ProjectFile[])),
    [projectId]
  );
}

export function useMessages(projectId: string | null) {
  return useFetch(
    () => (projectId ? api.getMessages(projectId) : Promise.resolve([] as Message[])),
    [projectId]
  );
}

export function useRuns(projectId: string | null) {
  return useFetch(
    () => (projectId ? api.getRuns(projectId) : Promise.resolve([] as Run[])),
    [projectId]
  );
}

export { api };
