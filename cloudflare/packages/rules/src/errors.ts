// Port of C# `CustomValidationException` (FortyTwo/Server/Exceptions).
// Every MatchValidationService guard throws this — never returns an error value.
export class ValidationError extends Error {
  constructor(
    public title: string,
    public detail?: string
  ) {
    super(title);
    this.name = 'ValidationError';
  }
}
