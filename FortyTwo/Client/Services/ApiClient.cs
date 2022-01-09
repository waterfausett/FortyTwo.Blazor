using FortyTwo.Client.Store;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.DTO;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public interface IApiClient
    {

    }

    public class ApiClient : IApiClient, IDisposable
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;
        private readonly IUserService _userService;

        public ApiClient(HttpClient http, IClientStore store, IUserService userService)
        {
            _http = http;
            _store = store;
            _userService = userService;
        }

        public async Task<ExceptionDetails> FetchMatchesAsync(MatchFilter? matchFilter = null)
        {
            try
            {
                var matches = await _http.GetFromJsonAsync<List<Match>>($"api/matches?completed={matchFilter == MatchFilter.Completed}");

                _store.Matches = matches;

                await _userService.SyncUsersAsync(matches.SelectMany(x => x.Players)
                    .Select(x => x.Id)
                    .ToList());

                return null;
            }
            catch (Exception ex)
            {
                return new ExceptionDetails { Title = ex.Message };
            }
        }

        public async Task<ExceptionDetails> CreateMatchAsync()
        {
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

        public void Dispose()
        {
            _http?.Dispose();
        }
    }
}
