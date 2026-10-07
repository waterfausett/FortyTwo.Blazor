import { useMemo } from 'react';
import { createApiClient } from '@fortytwo/client';
import { config } from '@/config';
import { useGetToken } from '@/auth/useGetToken';
import { DEV_BYPASS, devApi } from '@/dev/devBypass';

export type Api = ReturnType<typeof createApiClient>;

export function useApi(): Api {
  const getToken = useGetToken();
  // The dev bypass answers from canned data instead (src/dev/devBypass.ts).
  return useMemo(() => (DEV_BYPASS ? devApi : createApiClient(getToken, config.apiOrigin)), [getToken]);
}
