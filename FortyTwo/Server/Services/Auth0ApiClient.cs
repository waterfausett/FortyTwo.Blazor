using FortyTwo.Shared.DTO;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace FortyTwo.Server.Services
{
    internal class Auth0ApiClient : IAuth0ApiClient
    {
        private readonly IAuth0AccessTokenProvider _accessTokenProvider;
        private readonly HttpClient _httpClient;
        private readonly ILogger _logger;

        public Auth0ApiClient(IConfiguration configuration, IAuth0AccessTokenProvider accessTokenProvider, IHttpClientFactory httpClientFactory, ILogger<Auth0ApiClient> logger)
        {
            _accessTokenProvider = accessTokenProvider;
            _httpClient = httpClientFactory.CreateClient();
            _httpClient.BaseAddress = new Uri(configuration["Auth0_ApiClient_PublicOrigin"]);
            _logger = logger;
        }

        public async Task<User> GetUserAsync(string userId)
        {
            string url = $"api/v2/users/{userId}";

            var user = await FetchAsync<User>(url);

            return user;
        }

        public async Task<List<User>> GetUsersAsync()
        {
            const string url = "api/v2/users?fields=identities,app_metadata,last_ip&include_fields=false";

            var users = await FetchAsync<List<User>>(url);

            return users;
        }

        public async Task<List<User>> GetUsersAsync(List<string> userIds)
        {
            var url = $"api/v2/users?fields=identities,app_metadata,last_ip&include_fields=false&q=user_id:(\"{string.Join("\",\"", userIds)}\")";

            var users = await FetchAsync<List<User>>(url);

            return users;
        }

        public async Task UpdateUserAsync(string userId, UserPatch patch)
        {
            var url = $"api/v2/users/{userId}";

            await PatchAsync(url, new { user_metadata = patch });
        }

        private async Task PatchAsync(string url, object payload)
        {
            _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            var serializerOptions = new JsonSerializerOptions
            {
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            };
            var json = JsonSerializer.Serialize(payload, serializerOptions);
            using var request = new HttpRequestMessage(HttpMethod.Patch, url)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };

            var accessToken = await _accessTokenProvider.FetchAsync();
            request.Headers.Add("Authorization", $"{accessToken.TokenType} {accessToken.Token}");

            try
            {
                using var response = await _httpClient.SendAsync(request);
                response.EnsureSuccessStatusCode();
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error executing PATCH via Auth0 Api: {ex}");
                throw;
            }
        }

        private async Task<T> FetchAsync<T>(string url) where T : new()
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);

            var accessToken = await _accessTokenProvider.FetchAsync();
            request.Headers.Add("Authorization", $"{accessToken.TokenType} {accessToken.Token}");

            try
            {
                using var response = await _httpClient.SendAsync(request);
                response.EnsureSuccessStatusCode();
                var json = await response.Content.ReadAsStringAsync();
                return JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error fetching data from Auth0 Api: {ex}");
                throw;
            }
        }
    }
}
