using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.DTO;
using Game = FortyTwo.Shared.Models.DTO.Game;
using Player = FortyTwo.Shared.Models.DTO.Player;

namespace FortyTwo.Client.ViewModels
{
    public interface IGameViewModel
    {
        public bool IsLoading { get; }
        public bool Bidding { get; set; }
        public List<Bid> BiddingOptions { get; }
        public bool MakingMove { get; set; }
        public Guid MatchId { get; set; }
        public Game Game { get; }
        public LoggedInPlayer Player { get; set; }
        Task FetchGameAsync();
        void UpdateGame(Game game);
        Task FetchPlayerAsync();
        Task<string> BidAsync(Bid bid);
        Task<string> MakeMoveAsync(Domino domino);
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
        public bool Bidding { get; set; }
        public bool MakingMove { get; set; }

        public Guid MatchId { get; set; }
        public Game Game
        {
            get => _store.Games?.FirstOrDefault(x => x.Id == MatchId);
        }

        public LoggedInPlayer Player { get; set; }

        public List<Bid> BiddingOptions
        {
            get
            {
                var biddingOptions = Enum.GetValues(typeof(Bid)).OfType<Bid>().ToList();
                if (Player.Dominos.Count(x => x.IsDouble) < 4)
                {
                    biddingOptions.Remove(Bid.Plunge);
                }

                biddingOptions.RemoveAll(x => x > Bid.EightyFour && (!Game.Bid.HasValue || (int)x > ((int)Game.Bid + (int)Bid.FourtyTwo)));

                return biddingOptions;
            }
        }

        public async Task FetchGameAsync()
        {
            _fetchingGame = true;

            try
            {
                var game = await _http.GetFromJsonAsync<Game>($"api/matches/{MatchId}");

                _store.Games.RemoveAll(x => x.Id == MatchId);
                _store.Games.Add(game);
            }
            finally
            {
                _fetchingGame = false;
            }
        }

        public void UpdateGame(Game game)
        {
            _store.Games.RemoveAll(x => x.Id == MatchId);
            _store.Games.Add(game);

            Player.Bid ??= game.Players.First(x => x.Id == Player.Id).Bid;
        }

        public async Task FetchPlayerAsync()
        {
            _fetchingPlayer = true;

            try
            {
                Player = await _http.GetFromJsonAsync<LoggedInPlayer>($"api/matches/{MatchId}/player");
            }
            finally
            {
                _fetchingPlayer = false;
            }
        }

        public async Task<string> BidAsync(Bid bid)
        {
            Bidding = true;

            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/bids", bid);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadAsStringAsync() ?? response.ReasonPhrase;
                }
                /*
                var game = await response.Content.ReadFromJsonAsync<Game>();
                _store.Games.RemoveAll(x => x.Id == MatchId);
                _store.Games.Add(game);
                */

                Player.Bid = bid;

                return string.Empty;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            finally
            {
                Bidding = false;
            }
        }

        public async Task<string> MakeMoveAsync(Domino domino)
        {
            MakingMove = true;

            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/moves", domino);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadAsStringAsync() ?? response.ReasonPhrase;
                }

                var game = await response.Content.ReadFromJsonAsync<Game>();
                _store.Games.RemoveAll(x => x.Id == MatchId);
                _store.Games.Add(game);

                Player.Dominos.Remove(domino);

                return string.Empty;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            finally
            {
                MakingMove = false;
            }
        }
    }
}
