import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import app, { type Env } from '../src/index';
import { ANDROID_PACKAGE, assetLinks } from '../src/appLinks';

describe('assetLinks', () => {
  it('vouches for the app with each fingerprint, normalized', () => {
    expect(assetLinks(' ab:cd , EF:01 ')).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ['AB:CD', 'EF:01'] },
      },
    ]);
  });

  it('has nothing to say without fingerprints', () => {
    expect(assetLinks(undefined)).toBeNull();
    expect(assetLinks(' , ')).toBeNull();
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  const testEnv = env as unknown as Env;

  it("is served by the Worker, not the web app, from wrangler.toml's fingerprints", async () => {
    const res = await SELF.fetch('https://example.com/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { target: { sha256_cert_fingerprints: string[] } }[];
    expect(body[0].target.sha256_cert_fingerprints).toEqual(assetLinks(testEnv.ANDROID_APP_FINGERPRINTS)![0].target.sha256_cert_fingerprints);
  });

  it('serves each fingerprint it is given', async () => {
    const res = await app.fetch(new Request('https://example.com/.well-known/assetlinks.json'), { ...testEnv, ANDROID_APP_FINGERPRINTS: 'AB:CD' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { sha256_cert_fingerprints: string[] } }[];
    expect(body[0].target.sha256_cert_fingerprints).toEqual(['AB:CD']);
  });

  it('is a 404 when none are set', async () => {
    const res = await app.fetch(new Request('https://example.com/.well-known/assetlinks.json'), { ...testEnv, ANDROID_APP_FINGERPRINTS: undefined });
    expect(res.status).toBe(404);
  });
});
