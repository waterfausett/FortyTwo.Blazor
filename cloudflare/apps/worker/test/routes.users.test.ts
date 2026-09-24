// Focused unit tests for toUserResponse's two fallback chains (Correction E) - the real C#
// `User` DTO's computed Picture/DisplayName properties, ported here as pure functions since
// auth0Management.ts stays a faithful raw Auth0 client with no computed logic.
import { describe, it, expect } from 'vitest';
import { toUserResponse } from '../src/routes/users';
import type { Auth0User } from '../src/auth0Management';

describe('toUserResponse', () => {
  describe('picture', () => {
    it('prefers a non-blank user_metadata.picture over the raw top-level picture', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png', user_metadata: { picture: 'meta.png' } };
      expect(toUserResponse(u).picture).toBe('meta.png');
    });

    it('falls back to the raw picture when user_metadata.picture is blank/whitespace', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png', user_metadata: { picture: '   ' } };
      expect(toUserResponse(u).picture).toBe('raw.png');
    });

    it('falls back to the raw picture when user_metadata is absent entirely', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png' };
      expect(toUserResponse(u).picture).toBe('raw.png');
    });
  });

  describe('displayName', () => {
    it('prefers user_metadata.displayName over everything else', () => {
      const u: Auth0User = {
        user_id: 'u1',
        user_metadata: { displayName: 'Meta Name' },
        nickname: 'nick',
        name: 'Name',
        email: 'e@example.com',
      };
      expect(toUserResponse(u).displayName).toBe('Meta Name');
    });

    it('falls back to nickname when user_metadata.displayName is absent', () => {
      const u: Auth0User = { user_id: 'u1', nickname: 'nick', name: 'Name', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('nick');
    });

    it('falls back to name when nickname is also absent', () => {
      const u: Auth0User = { user_id: 'u1', name: 'Name', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('Name');
    });

    it('falls back to email when name is also absent', () => {
      const u: Auth0User = { user_id: 'u1', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('e@example.com');
    });

    it('falls back to the literal "Unknown User ({id})" when everything else is absent', () => {
      const u: Auth0User = { user_id: 'u1' };
      expect(toUserResponse(u).displayName).toBe('Unknown User (u1)');
    });
  });
});
