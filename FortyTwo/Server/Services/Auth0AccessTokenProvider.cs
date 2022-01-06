using FortyTwo.Server.Services.Security;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace FortyTwo.Server.Services
{
    internal interface IAuth0AccessTokenProvider
    {
        Task<AccessToken> FetchAsync();
    }

    internal class Auth0AccessTokenProvider : IAuth0AccessTokenProvider
    {
        private readonly IConfiguration _configuration;
        private readonly HttpClient _httpClient;

        private readonly IMemoryCache _cache;

        public Auth0AccessTokenProvider(
            IConfiguration configuration,
            IHttpClientFactory httpClientFactory,
            IMemoryCache memoryCache)
        {
            _configuration = configuration;
            _httpClient = httpClientFactory.CreateClient();
            _httpClient.BaseAddress = new Uri(_configuration["Auth0_ApiClient_PublicOrigin"]);
            _cache = memoryCache;
        }

        public async Task<AccessToken> FetchAsync()
        {
            const string cacheKey = "auth0AccessToken";
            if (_cache.TryGetValue(cacheKey, out AccessToken cachedToken) && cachedToken.ExpiresOn > DateTimeOffset.UtcNow.AddSeconds(-30))
            {
                return cachedToken;
            }

            const string url = "oauth/token";
            var content = new Dictionary<string, string>
            {
                {"grant_type", "client_credentials"},
                {"client_id", _configuration["Auth0_ApiClient_ClientId"]},
                {"client_secret", _configuration["Auth0_ApiClient_ClientSecret"]},
                {"audience", _configuration["Auth0_ApiClient_Audience"]}
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new FormUrlEncodedContent(content) };
            var response = await _httpClient.SendAsync(request);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();
            var accessToken = JsonSerializer.Deserialize<AccessToken>(json);

            _cache.Set(cacheKey, accessToken);

            return accessToken;
        }
    }
}
