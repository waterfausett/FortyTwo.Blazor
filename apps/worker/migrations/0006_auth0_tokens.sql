-- The Auth0 Management API token (auth0Management.ts), shared by every Worker isolate so a new
-- isolate reuses it instead of spending one of the tenant's monthly M2M tokens. One row per
-- audience; expires_on is epoch ms.
CREATE TABLE auth0_tokens (
  audience TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  token_type TEXT NOT NULL,
  expires_on INTEGER NOT NULL
);
