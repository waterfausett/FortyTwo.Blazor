using System;

namespace FortyTwo.Shared.Extensions
{
    public static class StringExtensions
    {
        /// <summary>
        /// If the string exceeds the maximum length, truncate all characters that occur after the maximum length index.
        /// </summary>
        /// <param name="value"></param>
        /// <param name="maximumLength"></param>
        /// <returns></returns>
        public static string Truncate(this string value, int maximumLength)
        {
            if (maximumLength < 0)
            {
                throw new ArgumentException($"{nameof(maximumLength)} must be a non-negative number.");
            }

            if (value == null || value.Length <= maximumLength)
            {
                return value;
            }

            return $"{value.Substring(0, maximumLength - 3)}...";
        }
    }
}
