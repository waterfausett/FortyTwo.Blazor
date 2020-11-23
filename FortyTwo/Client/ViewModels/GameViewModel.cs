using System;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.ViewModels
{
    public interface IGameViewModel
    {
        public bool IsLoading { get; }
        public Guid GameId { get; set; }
        public Game Game { get; }
        public FortyTwo.Shared.Models.Player Player { get; set; }
        Task FetchGameAsync();
        Task FetchPlayerAsync();
    }

    public class GameViewModel : IGameViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;

        public GameViewModel(HttpClient http, IClientStore store)
        {
            _http = http;
            _store = store;
        }

        private bool _fetchingGame;
        private bool _fetchingPlayer;
        public bool IsLoading => _fetchingGame || _fetchingPlayer;

        public Guid GameId { get; set; }
        public Game Game
        {
            get => _store.Games?.FirstOrDefault(x => x.Id == GameId);
        }

        public FortyTwo.Shared.Models.Player Player { get; set; }

        public async Task FetchGameAsync()
        {
            _fetchingGame = true;

            try
            {
                var response = await _http.GetAsync($"api/games/{GameId}");
                response.EnsureSuccessStatusCode();

                var responseContent = await response.Content.ReadAsStringAsync();

                _store.Games.RemoveAll(x => x.Id == GameId);
                _store.Games.Add(JsonSerializer.Deserialize<Game>(responseContent, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
            }
            finally
            {
                _fetchingGame = false;
            }
        }

        public async Task FetchPlayerAsync()
        {
            _fetchingPlayer = true;

            try
            {
                var response = await _http.GetAsync($"api/games/players/{GameId}");
                response.EnsureSuccessStatusCode();

                var responseContent = await response.Content.ReadAsStringAsync();

                Player = JsonSerializer.Deserialize<FortyTwo.Shared.Models.Player>(responseContent, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            }
            finally
            {
                _fetchingPlayer = false;
            }
        }
    }
}
