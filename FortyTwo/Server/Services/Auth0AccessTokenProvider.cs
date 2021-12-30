using FortyTwo.Server.Config;
using FortyTwo.Server.Services.Security;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
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
        private readonly IOptionsMonitor<Auth0ApiClientConfiguration> _apiClientConfig;
        private readonly HttpClient _httpClient;

        private readonly IMemoryCache _cache;

        public Auth0AccessTokenProvider(
            IOptionsMonitor<Auth0ApiClientConfiguration> apiClientConfig,
            IHttpClientFactory httpClientFactory,
            IMemoryCache memoryCache)
        {
            _apiClientConfig = apiClientConfig;
            _httpClient = httpClientFactory.CreateClient();
            _httpClient.BaseAddress = new Uri(_apiClientConfig.CurrentValue.PublicOrigin);
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
                {"client_id", _apiClientConfig.CurrentValue.ClientId},
                {"client_secret", _apiClientConfig.CurrentValue.ClientSecret},
                {"audience", _apiClientConfig.CurrentValue.Audience}
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
