import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Context, Next } from 'hono';
import type { Env } from '../index';

export interface AuthedUser {
  sub: string;
}

type AuthContext = Context<{ Bindings: Env; Variables: { user: AuthedUser } }>;

// Cached per Worker isolate so we don't rebuild the remote JWKS resolver (and
// its internal key cache) on every request. AUTH0_DOMAIN is a static
// per-deployment binding — it doesn't vary across requests within an
// isolate — so a single cached resolver is sufficient. createRemoteJWKSet
// already memoizes fetched keys internally; this just avoids reconstructing
// the resolver object itself on every call.
let cachedRemoteResolver: JWTVerifyGetKey | undefined;

function getRemoteJwks(domain: string): JWTVerifyGetKey {
  if (!cachedRemoteResolver) {
    cachedRemoteResolver = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
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

    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, resolver, {
        audience: c.env.AUTH0_AUDIENCE,
        issuer: `https://${c.env.AUTH0_DOMAIN}/`,
      });
      sub = payload.sub;
    } catch {
      return c.json({ title: 'Unauthorized' }, 401);
    }

    if (!sub) {
      return c.json({ title: 'Unauthorized' }, 401);
    }

    // Outside the try/catch: a downstream route handler's own errors (e.g.
    // validation, DB failures) must propagate as-is, not be swallowed and
    // misreported as an auth failure.
    c.set('user', { sub });
    await next();
  };
}
