import { useMemo } from 'react';
import { createApiClient } from '@fortytwo/client';
import { config } from '@/config';
import { useGetToken } from '@/auth/useGetToken';

export type Api = ReturnType<typeof createApiClient>;

export function useApi(): Api {
  const getToken = useGetToken();
  return useMemo(() => createApiClient(getToken, config.apiOrigin), [getToken]);
}
