using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Store;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
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
                var matches = await _http.GetFromJsonAsync<List<Match>>($"api/matches?filter={matchFilter}");

                _store.Matches.Clear();
                matches.ForEach(match => _store.Matches.AddOrUpdate(match.Id, match, (_, __) => match));

                await _userService.SyncUsersAsync(matches.SelectMany(x => x.Players)
                    .Select(x => x.Id)
                    .ToList());
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task FetchMatchAsync(Guid matchId)
        {
            try
            {
                var match = await _http.GetFromJsonAsync<Match>($"api/matches/{matchId}");

                _store.Matches.AddOrUpdate(matchId, match, (_, __) => match);

                await _userService.SyncUsersAsync(match.Players.Select(x => x.Id).ToList());
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task<LoggedInPlayer> FetchMatchPlayerAsync(Guid matchId)
        {
            try
            {
                var user = await _http.GetFromJsonAsync<LoggedInPlayer>($"api/matches/{matchId}/players");

                if (user?.Dominos != null)
                {
                    // TODO: this doesn't actually do anything b/c .Order isn't nullable so everything stays set at 0 🤪
                    user.Dominos = user.Dominos
                        .Select((x, index) => new { Domino = x, Index = index + 1 })
                        .OrderBy(x => x.Domino?.Order ?? x.Index)
                        .Select(x => x.Domino)
                        .ToList();
                }

                return user;
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }

            return null;
        }

        public async Task CreateMatchAsync()
        {
            try
            {
                var response = await _http.PostAsync("api/matches", null);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(response);
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.AddOrUpdate(match.Id, match, (_, __) => match);
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
                    await HandleException(response);
                }

                _store.Matches.Remove(matchId, out _);
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
                    await HandleException(response);
                }

                var match = await response.Content.ReadFromJsonAsync<Match>();

                _store.Matches.AddOrUpdate(matchId, match, (_, __) => match);
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
            }
        }

        public async Task<bool> UpdateMatchPlayerAsync(Guid matchId, bool ready)
        {
            try
            {
                var content = new StringContent(JsonSerializer.Serialize(new PlayerPatchRequest { Ready = ready }), Encoding.UTF8, "application/json");
                using var response = await _http.PatchAsync($"api/matches/{matchId}/players", content);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(response);
                    return false;
                }
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
                return false;
            }

            return true;
        }

        public async Task<bool> BidAsync(Guid matchId, Bid bid)
        {
            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{matchId}/games/current/bids", bid);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(response);
                    return false;
                }
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
                return false;
            }

            return true;
        }

        public async Task<bool> SelectTrumpAsync(Guid matchId, Suit suit)
        {
            try
            {
                var content = new StringContent(JsonSerializer.Serialize(suit), Encoding.UTF8, "application/json");
                var response = await _http.PatchAsync($"api/matches/{matchId}/games/current", content);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(response);
                    return false;
                }
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
                return false;
            }

            return true;
        }

        public async Task<bool> MakeMoveAsync(Guid matchId, Domino domino)
        {
            try
            {
                var response = await _http.PostAsJsonAsync($"api/matches/{matchId}/games/current/moves", domino);
                if (!response.IsSuccessStatusCode)
                {
                    await HandleException(response);
                    return false;
                }
            }
            catch (Exception ex)
            {
                await HandleException(new ExceptionDetails { Title = ex.Message });
                return false;
            }

            return true;
        }

        private async Task HandleException(HttpResponseMessage response)
        {
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                await _swal.FireAsync(new SweetAlertOptions
                {
                    Toast = true,
                    Timer = 1750,
                    TimerProgressBar = true,
                    Position = SweetAlertPosition.BottomRight,
                    ShowConfirmButton = false,
                    Icon = SweetAlertIcon.Error,
                    Title = "Unauthorized",
                    Target = ".main"
                });

                return;
            }

            var exception = await response.Content.ReadFromJsonAsync<ExceptionDetails>();

            await HandleException(exception);
        }

        private async Task HandleException(ExceptionDetails exception)
        {
            if (exception == null) return;

            await _swal.FireAsync(new SweetAlertOptions
            {
                Icon = SweetAlertIcon.Error,
                Title = !string.IsNullOrEmpty(exception.Title) ? exception.Title : "Something went wrong",
                Html = exception.Detail.Truncate(250),
                ConfirmButtonText = "Ok",
                Target = ".main"
            });
        }

        public void Dispose()
        {
            _http?.Dispose();
        }
    }
}
