using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.ViewModels
{
    public interface IGamesViewModel
    {
        public bool IsLoading { get; set; }

        public Game[] Games { get; }

        Task FetchGamesAsync();
    }

    public class GamesViewModel : IGamesViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;

        public GamesViewModel(HttpClient http, IClientStore store)
        {
            _http = http;
            _store = store;
        }

        public bool IsLoading { get; set; }

        public Game[] Games
        {
            get => _store.Games?.ToArray();
        }

        public async Task FetchGamesAsync()
        {
            IsLoading = true;

            try
            {
                var response = await _http.GetAsync("api/games");
                response.EnsureSuccessStatusCode();

                var responseContent = await response.Content.ReadAsStringAsync();

                _store.Games = JsonSerializer.Deserialize<List<Game>>(responseContent, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            }
            finally
            {
                IsLoading = false;
            }
        }
    }
}
