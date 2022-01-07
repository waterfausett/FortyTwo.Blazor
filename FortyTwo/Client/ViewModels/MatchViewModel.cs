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
using System.Text.Json;
using System.Text;

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
        Task<ExceptionDetails> BidAsync(Bid bid);
        Task<ExceptionDetails> UpdatePlayerAsync(bool ready);
        Task<ExceptionDetails> SelectTrumpAsync(Suit suit);
        Task<ExceptionDetails> MakeMoveAsync(Domino domino);
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

                // HACK: always remove this option until it's fully supported in the rest of the app
                biddingOptions.Remove(Bid.Plunge);

                if (CurrentGame.Bid.HasValue)
                {
                    biddingOptions.RemoveAll(x => (x != Bid.Pass && x != Bid.Plunge) && x <= CurrentGame.Bid.Value);
                }

                if (CurrentGame.Hands.Count(x => x.Bid == Bid.Pass) == 3)
                {
                    biddingOptions.Remove(Bid.Pass);
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

                var unknownUserIds = match.Players
                    .Select(x => x.Id)
                    .Except(_store.Users.Select(x => x.Id))
                    .ToList();

                if (unknownUserIds.Any())
                {
                    var usersResponse = await _http.PostAsJsonAsync("api/users", unknownUserIds);
                    _store.Users.AddRange(await usersResponse.Content.ReadFromJsonAsync<List<User>>());
                }

                await UpdateGame(match.CurrentGame);
            }
            finally
            {
                _fetchingGame = false;
            }
        }

        public Task UpdateGame(Game game)
        {
            // TODO: maybe add a tracking flag to track if we know we're waiting on an update

            Match.CurrentGame = game;

            Player.Bid ??= game.Hands.First(x => x.PlayerId == Player.Id).Bid;
            Player.IsActive = game.CurrentPlayerId == Player.Id;

            return Task.CompletedTask;
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

        public async Task<ExceptionDetails> BidAsync(Bid bid)
        {
            Bidding = true;

            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/bids", bid);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                Player.Bid = bid;

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
            finally
            {
                Bidding = false;
            }
        }

        public async Task<ExceptionDetails> UpdatePlayerAsync(bool ready)
        {
            try
            {
                var content = new StringContent(JsonSerializer.Serialize(new PlayerPatchRequest { Ready = ready }), Encoding.UTF8, "application/json");
                using var response = await _http.PatchAsync($"api/matches/{MatchId}/players", content);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                Player.Ready = ready;

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
        }

        public async Task<ExceptionDetails> SelectTrumpAsync(Suit suit)
        {
            Bidding = true;

            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/selectTrump", suit);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
            finally
            {
                Bidding = false;
            }
        }

        public async Task<ExceptionDetails> MakeMoveAsync(Domino domino)
        {
            MakingMove = true;

            var currentPlayerId = CurrentGame.CurrentPlayerId;
            try
            {
                CurrentGame.CurrentPlayerId = null;

                Player.Dominos.Remove(domino);
                CurrentGame.CurrentTrick.AddDomino(domino, CurrentGame.Trump.Value);

                var response = await _http.PostAsJsonAsync($"api/matches/{MatchId}/moves", domino);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                return null;
            }
            catch (Exception ex)
            {
                CurrentGame.CurrentPlayerId = currentPlayerId;
                Player.Dominos.Add(domino);

                return new ExceptionDetails { Title = ex.Message };
            }
            finally
            {
                MakingMove = false;
            }
        }
    }
}
