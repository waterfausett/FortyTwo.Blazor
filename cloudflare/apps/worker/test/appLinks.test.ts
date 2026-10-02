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
  it('serves the statement as JSON once fingerprints are set', async () => {
    const res = await app.request('/.well-known/assetlinks.json', {}, {
      ...(env as unknown as Env),
      ANDROID_APP_FINGERPRINTS: 'AB:CD',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { target: { sha256_cert_fingerprints: string[] } }[];
    expect(body[0].target.sha256_cert_fingerprints).toEqual(['AB:CD']);
  });

  it("is a 404, not the web app's page, when none are set", async () => {
    const res = await SELF.fetch('https://example.com/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
  });
});
