using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Store;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public class ApiClient : IApiClient, IDisposable
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;
        private readonly IUserService _userService;
        private readonly SweetAlertService _swal;

        public ApiClient(HttpClient http, IClientStore store, IUserService userService, SweetAlertService swal)
        {
            _http = http;
            _store = store;
            _userService = userService;
            _swal = swal;
        }

        public async Task FetchMatchesAsync(MatchFilter? matchFilter = null)
        {
            try
            {
                var matches = await _http.GetFromJsonAsync<List<Match>>($"api/matches?completed={matchFilter == MatchFilter.Completed}");

                _store.Matches = matches;

                await _userService.SyncUsersAsync(matches.SelectMany(x => x.Players)
                    .Select(x => x.Id)
                    .ToList());
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task CreateMatchAsync()
        {
            try
            {
                var response = await _http.PostAsync("api/matches", null);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(await response.Content.ReadFromJsonAsync<ExceptionDetails>());
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.Add(match);
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task DeleteMatchAsync(Guid matchId)
        {
            try
            {
                var response = await _http.DeleteAsync($"api/matches/{matchId}");
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(await response.Content.ReadFromJsonAsync<ExceptionDetails>());
                }

                _store.Matches.RemoveAll(match => match.Id == matchId);
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team)
        {
            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{matchId}/players", new AddPlayerRequest { Team = team });
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(await response.Content.ReadFromJsonAsync<ExceptionDetails>());
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.RemoveAll(x => x.Id == matchId);
                _store.Matches.Add(match);
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        private async Task HandleException(ExceptionDetails exception)
        {
            if (exception == null) return;

            await _swal.FireAsync(new SweetAlertOptions
            {
                Icon = SweetAlertIcon.Error,
                Title = exception.Title,
                Html = exception.Detail.Truncate(250),
                ConfirmButtonText = "Ok",
            });
        }

        public void Dispose()
        {
            _http?.Dispose();
        }
    }
}
