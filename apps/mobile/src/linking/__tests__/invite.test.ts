import { inviteLink } from '../invite';

jest.mock('expo-linking', () => ({ createURL: (path: string) => `fortytwo://${path}` }));

describe('inviteLink', () => {
  it("links to the match on the Worker, which the app or the web app opens", () => {
    expect(inviteLink('abc-123', 'https://fortytwo.example.dev')).toBe('https://fortytwo.example.dev/match/abc-123');
  });

  it("falls back to the app's own scheme without an https Worker", () => {
    expect(inviteLink('abc-123', 'http://10.0.2.2:8787')).toBe('fortytwo://match/abc-123');
  });
});
