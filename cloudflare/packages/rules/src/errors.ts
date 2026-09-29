// A rule a player's action broke. Every guard in validation.ts throws this; the Worker sends its
// title and detail to the client as a 400.
export class ValidationError extends Error {
  constructor(
    public title: string,
    public detail?: string
  ) {
    super(title);
    this.name = 'ValidationError';
  }
}
