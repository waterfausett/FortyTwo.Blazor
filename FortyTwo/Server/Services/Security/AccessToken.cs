using System;
using System.Text.Json.Serialization;

namespace FortyTwo.Server.Services.Security
{
    internal class AccessToken
    {
        public AccessToken(string token, double expiresInSeconds, string tokenType, string scope)
        {
            Token = token;
            ExpiresInSeconds = expiresInSeconds;
            ExpiresOn = DateTimeOffset.UtcNow.AddSeconds(ExpiresInSeconds);
            TokenType = tokenType;
            Scope = scope;
        }

        [JsonPropertyName("access_token")]
        public string Token { get; }
        [JsonPropertyName("expires_in")]
        public double ExpiresInSeconds { get; }
        public DateTimeOffset ExpiresOn { get; }
        [JsonPropertyName("token_type")]
        public string TokenType { get; }
        [JsonPropertyName("scope")]
        public string Scope { get; }
    }
}
