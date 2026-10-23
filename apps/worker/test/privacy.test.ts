import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import app, { type Env } from '../src/index';
import { privacyPolicyHtml } from '../src/privacy';
import { accountDeletionHtml } from '../src/accountDeletion';
import { DELETED_NAME } from '../src/users/deleteAccount';

describe('privacyPolicyHtml', () => {
  it('sends questions to the contact email when there is one', () => {
    const html = privacyPolicyHtml(' privacy@example.com ');
    expect(html).toContain('<a href="mailto:privacy@example.com">privacy@example.com</a>');
    expect(html).not.toContain('/issues');
  });

  it('points at GitHub issues without one', () => {
    expect(privacyPolicyHtml(undefined)).toContain('https://github.com/waterfausett/FortyTwo.Blazor/issues');
    expect(privacyPolicyHtml('  ')).not.toContain('mailto:');
  });

  it('escapes the contact email', () => {
    expect(privacyPolicyHtml('a"<b>@example.com')).toContain('a&#34;&#60;b&#62;@example.com');
  });
});

describe('GET /privacy', () => {
  const testEnv = env as unknown as Env;

  it('is a public HTML page served by the Worker', async () => {
    const res = await SELF.fetch('https://example.com/privacy');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<h1>Forty-Two privacy policy</h1>');
  });

  it('uses CONTACT_EMAIL', async () => {
    const res = await app.fetch(new Request('https://example.com/privacy'), { ...testEnv, CONTACT_EMAIL: 'me@example.com' });
    expect(await res.text()).toContain('mailto:me@example.com');
  });
});

describe('GET /account-deletion', () => {
  const testEnv = env as unknown as Env;

  it('is a public HTML page served by the Worker, linked from the privacy policy', async () => {
    const res = await SELF.fetch('https://example.com/account-deletion');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<h1>Deleting your Forty-Two account</h1>');
    expect(html).toContain(`shown as "${DELETED_NAME}"`);
    expect(privacyPolicyHtml(undefined)).toContain('<a href="/account-deletion">');
  });

  it('sends requests to CONTACT_EMAIL', async () => {
    const res = await app.fetch(new Request('https://example.com/account-deletion'), { ...testEnv, CONTACT_EMAIL: 'me@example.com' });
    expect(accountDeletionHtml('me@example.com')).toContain('mailto:me@example.com');
    expect(await res.text()).toContain('mailto:me@example.com');
  });
});
