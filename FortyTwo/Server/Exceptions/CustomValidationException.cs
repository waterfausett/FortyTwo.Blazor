using System;

namespace FortyTwo.Server.Exceptions
{
    // TODO: this prolly isn't a good name :D
    public class CustomValidationException : Exception
    {
        public string Details { get; set; }

        public CustomValidationException(string message, string details = null)
            : base(message)
        {
            Details = details;
        }
    }
}
