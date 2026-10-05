// A D1 binding that fails every call, standing in for a lobby index that's down (say, once the
// day's D1 write quota has run out) - for tests that a saved match change still goes through.
export function failingDb(): D1Database {
  const fail = () => {
    throw new Error('D1 is down');
  };
  return { prepare: fail, batch: async () => fail(), exec: async () => fail() } as unknown as D1Database;
}
