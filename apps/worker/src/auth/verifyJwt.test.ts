import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import { requireAuth, type AuthedUser } from './verifyJwt';
import type { Env } from '../index';

const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'test-key-1';

const testEnv = { AUTH0_DOMAIN, AUTH0_AUDIENCE } as unknown as Env;

let privateKey: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: { user: AuthedUser } }>();
  app.use('/api/*', requireAuth(jwks));
  app.get('/api/whoami', (c) => c.json({ sub: c.get('user').sub }));
  return app;
}

async function signToken(overrides: {
  sub?: string;
  audience?: string;
  issuer?: string;
  expirationTime?: number | string;
} = {}) {
  const {
    sub = 'auth0|abc123',
    audience = AUTH0_AUDIENCE,
    issuer = ISSUER,
    expirationTime = '1h',
  } = overrides;

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}

describe('requireAuth', () => {
  it('calls next() and sets user.sub for a valid token', async () => {
    const app = buildApp();
    const token = await signToken({ sub: 'auth0|abc123' });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'auth0|abc123' });
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const app = buildApp();

    const res = await app.request('/api/whoami', {}, testEnv);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ title: 'Unauthorized' });
  });

  it('returns 401 for an expired token', async () => {
    const app = buildApp();
    const expiredEpochSeconds = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken({ expirationTime: expiredEpochSeconds });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ title: 'Unauthorized' });
  });

  it('returns 401 for a token with the wrong audience', async () => {
    const app = buildApp();
    const token = await signToken({ audience: 'https://wrong-audience.local' });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ title: 'Unauthorized' });
  });

  it('returns 401 for a token with a tampered signature', async () => {
    const app = buildApp();
    const token = await signToken();
    const [header, payload, signature] = token.split('.');
    const tamperedSignature = signature.slice(0, -4) + (signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${tamperedToken}` } },
      testEnv,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ title: 'Unauthorized' });
  });

  it('does not swallow a downstream route handler error as 401', async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: AuthedUser } }>();
    app.use('/api/*', requireAuth(jwks));
    app.get('/api/boom', () => {
      throw new Error('downstream failure unrelated to auth');
    });
    const token = await signToken();

    const res = await app.request(
      '/api/boom',
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );

    // The error must propagate (Hono's default error handler -> 500),
    // not be caught by requireAuth's try/catch and misreported as 401.
    expect(res.status).not.toBe(401);
    const body = await res.text();
    expect(body).not.toContain('Unauthorized');
  });
});
