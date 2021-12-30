using System.Text.Json.Serialization;

namespace FortyTwo.Shared.DTO
{
    public class User
    {
        [JsonPropertyName("user_id")]
        public string Id { get; set; }
        public string Email { get; set; }
        [JsonPropertyName("given_name")]
        public string FirstName { get; set; }

        [JsonPropertyName("family_name")]
        public string LastName { get; set; }
        public string Nickname { get; set; }
        public string Picture { get; set; }

        public string DisplayName
            => Nickname
                ?? ($"{FirstName} {(!string.IsNullOrWhiteSpace(LastName) ? $"{LastName?.Substring(0, 1)}." : "")}")
                ?? Email
                ?? $"Unknown User ({Id})";
    }
}
