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

// Verifies `token` against `env`'s Auth0 tenant (or `jwksResolver`, when supplied - used by
// tests to inject a local JWKS instead of hitting the real remote one) and returns the resulting
// `AuthedUser`. Does its own verification only - it doesn't catch/swallow anything, so a bad
// token surfaces as a thrown error and it's up to the caller (Hono middleware, or MatchDO's raw
// WebSocket upgrade handler, which has no Hono `Context` to pull a resolver from) to decide how
// to respond to that failure.
export async function verifyToken(
  token: string,
  env: Env,
  jwksResolver?: JWTVerifyGetKey
): Promise<AuthedUser> {
  const resolver = jwksResolver ?? getRemoteJwks(env.AUTH0_DOMAIN);

  const { payload } = await jwtVerify(token, resolver, {
    audience: env.AUTH0_AUDIENCE,
    issuer: `https://${env.AUTH0_DOMAIN}/`,
  });

  if (!payload.sub) {
    throw new Error('Token has no sub claim');
  }

  return { sub: payload.sub };
}

export function requireAuth(jwksResolver?: JWTVerifyGetKey) {
  return async (c: AuthContext, next: Next): Promise<Response | void> => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ title: 'Unauthorized' }, 401);
    }
    const token = authHeader.slice('Bearer '.length).trim();

    let user: AuthedUser;
    try {
      user = await verifyToken(token, c.env, jwksResolver);
    } catch {
      return c.json({ title: 'Unauthorized' }, 401);
    }

    // Outside the try/catch: a downstream route handler's own errors (e.g.
    // validation, DB failures) must propagate as-is, not be swallowed and
    // misreported as an auth failure.
    c.set('user', user);
    await next();
  };
}
