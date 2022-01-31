using System.Text.Json.Serialization;

namespace FortyTwo.Shared.DTO
{
    public class User
    {
        [JsonPropertyName("user_id")]
        public string Id { get; set; }
        public string Email { get; set; }
        public string Name { get; set; }
        [JsonPropertyName("given_name")]
        public string FirstName { get; set; }

        [JsonPropertyName("family_name")]
        public string LastName { get; set; }
        public string Nickname { get; set; }
        public string Picture { get; set; }

        [JsonPropertyName("user_metadata")]
        public UserMetadata UserMetadata { get; set; }

        public string DisplayName
            => UserMetadata?.DisplayName
                ?? Nickname
                ?? Name
                ?? Email
                ?? $"Unknown User ({Id})";
    }

    public class UserMetadata
    {
        public string DisplayName { get; set; }
        public bool? UseDarkTheme { get; set; }
    }
}
