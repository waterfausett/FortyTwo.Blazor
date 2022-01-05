using System;

namespace FortyTwo.Server.Exceptions
{
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
