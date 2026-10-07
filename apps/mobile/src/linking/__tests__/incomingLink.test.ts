import { matchRoute, noteIncomingLink, setSignedIn, takePendingLink } from '../incomingLink';

describe('matchRoute', () => {
  it('finds the match in each form a link takes', () => {
    expect(matchRoute('fortytwo://match/abc-123')).toBe('/match/abc-123');
    expect(matchRoute('https://fortytwo.example.dev/match/abc-123?from=share')).toBe('/match/abc-123');
    expect(matchRoute('/match/abc-123')).toBe('/match/abc-123');
  });

  it("ignores links that aren't to a match", () => {
    expect(matchRoute('fortytwo://profile')).toBeNull();
    expect(matchRoute('https://fortytwo.example.dev/')).toBeNull();
    expect(matchRoute('/rematch/abc')).toBeNull();
  });
});

describe('pending links', () => {
  afterEach(() => {
    setSignedIn(false);
    takePendingLink();
  });

  it('keeps a match link that arrives while signed out, once', () => {
    setSignedIn(false);
    noteIncomingLink('fortytwo://match/abc');
    expect(takePendingLink()).toBe('/match/abc');
    expect(takePendingLink()).toBeNull();
  });

  it('leaves a link that arrives while signed in to the router', () => {
    setSignedIn(true);
    noteIncomingLink('fortytwo://match/abc');
    expect(takePendingLink()).toBeNull();
  });
});
