using FortyTwo.Server.Config;
using FortyTwo.Shared.DTO;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace FortyTwo.Server.Services
{
    public interface IAuth0ApiClient
    {
        Task<List<User>> GetUsersAsync();
    }

    internal class Auth0ApiClient : IAuth0ApiClient
    {
        private readonly IAuth0AccessTokenProvider _accessTokenProvider;
        private readonly HttpClient _httpClient;
        private readonly ILogger _logger;

        public Auth0ApiClient(IOptionsMonitor<Auth0ApiClientConfiguration> apiClientConfig, IAuth0AccessTokenProvider accessTokenProvider, IHttpClientFactory httpClientFactory, ILogger<Auth0ApiClient> logger)
        {
            _accessTokenProvider = accessTokenProvider;
            _httpClient = httpClientFactory.CreateClient();
            _httpClient.BaseAddress = new Uri(apiClientConfig.CurrentValue.PublicOrigin);
            _logger = logger;
        }

        public async Task<List<User>> GetUsersAsync()
        {
            const string url = "api/v2/users?fields=identities%2Capp_metadata%2Clast_ip&include_fields=false";

            var users = await FetchAsync<List<User>>(url);

            users.Add(new User
            {
                Id = "Id:Jack",
                FirstName = "Jack"
            });
            users.Add(new User
            {
                Id = "Id:Adam",
                FirstName = "Adam"
            });
            users.Add(new User
            {
                Id = "Id:Jill",
                FirstName = "Jill"
            });
            users.Add(new User
            {
                Id = "Id:Emily",
                FirstName = "Emily"
            });

            return users;
        }

        private async Task<T> FetchAsync<T>(string url) where T : new()
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);

            var accessToken = await _accessTokenProvider.FetchAsync();
            request.Headers.Add("Authorization", $"{accessToken.TokenType} {accessToken.Token}");

            try
            {
                var response = await _httpClient.SendAsync(request);
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
