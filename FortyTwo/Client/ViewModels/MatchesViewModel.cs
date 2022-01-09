using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using FortyTwo.Shared.DTO;
using Microsoft.AspNetCore.SignalR.Client;

namespace FortyTwo.Client.ViewModels
{
    public enum MatchFilter
    {
        Active,
        Completed
    }

    public interface IMatchesViewModel
    {
        public bool IsLoading { get; set; }
        public bool IsCreating { get; set; }
        public List<Match> Matches { get; }
        Task FetchMatchesAsync(MatchFilter? matchFilter = null);
        Task<ExceptionDetails> CreateMatchAsync();
        Task<ExceptionDetails> DeleteMatchAsync(Guid matchId);
        string GetPlayerName(string playerId);
        Task<ExceptionDetails> JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team);
    }

    public class MatchesViewModel : IMatchesViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;
        private readonly IUserService _userService;

        public MatchesViewModel(HttpClient http, IClientStore store, IUserService userService)
        {
            _http = http;
            _store = store;
            _userService = userService;
        }

        public bool IsLoading { get; set; }
        public bool IsCreating { get; set; }

        private MatchFilter _matchFilter;

        public List<Match> Matches
        {
            get => _store.Matches?.OrderByDescending(x => x.CreatedOn).ToList();
        }

        public async Task FetchMatchesAsync(MatchFilter? matchFilter = null)
        {
            if (matchFilter.HasValue && _matchFilter == matchFilter) return;

            IsLoading = true;

            try
            {
                var matches = await _http.GetFromJsonAsync<List<Match>>($"api/matches?completed={matchFilter == MatchFilter.Completed}");

                _store.Matches = matches;

                await _userService.SyncUsersAsync(matches.SelectMany(x => x.Players)
                    .Select(x => x.Id)
                    .ToList());

                if (matchFilter.HasValue) _matchFilter = matchFilter.Value;
            }
            finally
            {
                IsLoading = false;
            }
        }

        public async Task<ExceptionDetails> CreateMatchAsync()
        {
            IsCreating = true;

            try
            {
                var response = await _http.PostAsync("api/matches", null);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.Add(match);

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
            finally
            {
                IsCreating = false;
            }
        }

        public async Task<ExceptionDetails> DeleteMatchAsync(Guid matchId)
        {
            try
            {
                var response = await _http.DeleteAsync($"api/matches/{matchId}");
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                _store.Matches.RemoveAll(match => match.Id == matchId);

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
        }

        public async Task<ExceptionDetails> JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team)
        {
            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{matchId}/players", new AddPlayerRequest { Team = team });
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.RemoveAll(x => x.Id == matchId);
                _store.Matches.Add(match);

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
        }

        public string GetPlayerName(string playerId)
            => _store.Users.FirstOrDefault(x => x.Id == playerId)?.DisplayName ?? $"Unknown Player ({playerId})";
    }
}
