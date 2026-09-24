import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Context, Next } from 'hono';
import type { Env } from '../index';

export interface AuthedUser {
  sub: string;
}

type AuthContext = Context<{ Bindings: Env; Variables: { user: AuthedUser } }>;

// Cached per Worker isolate so we don't rebuild the remote JWKS resolver (and
// its internal key cache) on every request. createRemoteJWKSet already
// memoizes fetched keys internally; this just avoids reconstructing the
// resolver object itself when the domain hasn't changed.
let cachedRemoteResolver: JWTVerifyGetKey | undefined;
let cachedRemoteDomain: string | undefined;

function getRemoteJwks(domain: string): JWTVerifyGetKey {
  if (!cachedRemoteResolver || cachedRemoteDomain !== domain) {
    cachedRemoteResolver = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
    cachedRemoteDomain = domain;
  }
  return cachedRemoteResolver;
}

export function requireAuth(jwksResolver?: JWTVerifyGetKey) {
  return async (c: AuthContext, next: Next): Promise<Response | void> => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ title: 'Unauthorized' }, 401);
    }
    const token = authHeader.slice('Bearer '.length).trim();

    const resolver = jwksResolver ?? getRemoteJwks(c.env.AUTH0_DOMAIN);

    try {
      const { payload } = await jwtVerify(token, resolver, {
        audience: c.env.AUTH0_AUDIENCE,
        issuer: `https://${c.env.AUTH0_DOMAIN}/`,
      });

      if (!payload.sub) {
        return c.json({ title: 'Unauthorized' }, 401);
      }

      c.set('user', { sub: payload.sub });
      await next();
    } catch {
      return c.json({ title: 'Unauthorized' }, 401);
    }
  };
}
