using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.DTO;
using Game = FortyTwo.Shared.DTO.Game;
using Match = FortyTwo.Shared.DTO.Match;

namespace FortyTwo.Client.ViewModels
{
    public interface IMatchViewModel
    {
        void Initialize(Guid matchId);
        public bool IsLoading { get; }
        public bool Bidding { get; set; }
        public List<Bid> BiddingOptions { get; }
        public bool MakingMove { get; set; }
        public Match Match { get; }
        public Game CurrentGame { get; }
        public LoggedInPlayer Player { get; set; }
        Task FetchMatchAsync();
        Task UpdateGame(Game game);
        Task FetchPlayerAsync();
        Task<string> BidAsync(Bid bid);
        Task<string> SelectTrumpAsync(Suit suit);
        Task<string> MakeMoveAsync(Domino domino);
    }

    public class MatchViewModel : IMatchViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;

        public MatchViewModel(HttpClient http, IClientStore store)
        {
            _http = http;
            _store = store;
        }

        public void Initialize(Guid matchId)
        {
            MatchId = matchId;
        }

        private bool _fetchingGame;
        private bool _fetchingPlayer;
        public bool IsLoading => _fetchingGame || _fetchingPlayer;
        public bool Bidding { get; set; }
        public bool MakingMove { get; set; }

        public Guid MatchId { get; set; }
        public Match Match
        {
            get => _store.Matches?.FirstOrDefault(x => x.Id == MatchId);
        }

        public Game CurrentGame
        {
            get => Match?.CurrentGame;
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

                if (CurrentGame.Bid.HasValue)
                {
                    biddingOptions.RemoveAll(x => (x != Bid.Pass && x != Bid.Plunge) && x <= CurrentGame.Bid.Value);
                }

                biddingOptions.RemoveAll(x => x > Bid.EightyFour && (!CurrentGame.Bid.HasValue || (int)x > ((int)CurrentGame.Bid + (int)Bid.FourtyTwo)));

                return biddingOptions;
            }
        }

        public async Task FetchMatchAsync()
        {
            _fetchingGame = true;
            
            try
            {
                var match = await _http.GetFromJsonAsync<Match>($"api/matches/{MatchId}");

                _store.Matches.RemoveAll(x => x.Id == MatchId);
                _store.Matches.Add(match);

                await UpdateGame(match.CurrentGame);
            }
            finally
            {
                _fetchingGame = false;
            }
        }

        public async Task UpdateGame(Game game)
        {
            // TODO: maybe add a tracking flag to track if we know we're waiting on an update

            Match.CurrentGame = game;

            Player.Bid ??= game.Hands.First(x => x.PlayerId == Player.Id).Bid;
            Player.IsActive = game.CurrentPlayerId == Player.Id;
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

        public async Task<string> SelectTrumpAsync(Suit suit)
        {
            Bidding = true;

            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/selectTrump", suit);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadAsStringAsync() ?? response.ReasonPhrase;
                }

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
