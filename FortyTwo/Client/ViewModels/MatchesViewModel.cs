﻿using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.DTO;

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
        Task<string> CreateMatchAsync();
        string GetPlayerName(string playerId);
        Task<string> JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team);
    }

    public class MatchesViewModel : IMatchesViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;

        public MatchesViewModel(HttpClient http, IClientStore store)
        {
            _http = http;
            _store = store;
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

                if (matchFilter.HasValue) _matchFilter = matchFilter.Value;
            }
            finally
            {
                IsLoading = false;
            }
        }

        public async Task<string> CreateMatchAsync()
        {
            IsCreating = true;

            try
            {
                var response = await _http.PostAsync("api/matches", null);
                if (!response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadAsStringAsync() ?? response.ReasonPhrase;
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.Add(match);

                return string.Empty;
            }
            finally
            {
                IsCreating = false;
            }
        }

        public async Task<string> JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team)
        {
            var response = await _http.PostAsJsonAsync($"api/matches/{matchId}/players", new AddPlayerRequest { Team = team });
            if (!response.IsSuccessStatusCode)
            {
                return await response.Content.ReadAsStringAsync() ?? response.ReasonPhrase;
            }

            var match = await response.Content.ReadFromJsonAsync<Match>();

            _store.Matches.RemoveAll(x => x.Id == matchId);
            _store.Matches.Add(match);

            return string.Empty;
        }

        public string GetPlayerName(string playerId)
            => _store.Users.FirstOrDefault(x => x.Id == playerId)?.DisplayName ?? $"Unknown Player ({playerId})";
    }
}
