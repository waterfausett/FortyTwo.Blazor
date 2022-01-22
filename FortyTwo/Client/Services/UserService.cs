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
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public class UserService : IUserService
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;
        private readonly SweetAlertService _swal;

        public UserService(HttpClient http, IClientStore store, SweetAlertService swal)
        {
            _http = http;
            _store = store;
            _swal = swal;
        }

        public async Task SyncUsersAsync(List<string> userIds)
        {
            var unknownUserIds = userIds
                .Except(_store.Users.Select(x => x.Id))
                .ToList();

            var users = await FetchUsersAsync(unknownUserIds);

            _store.Users.AddRange(users);
        }

        public async Task<User> FetchProfileAsync()
        {
            try
            {
                var user = await _http.GetFromJsonAsync<User>("api/users/profile");

                return user;
            }
            catch (Exception ex)
            {
                _ = _swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = "Failed to fetch profile",
                    //Html = $"<b>{exceptionDetails.Title}</b>: {exceptionDetails.Detail.Truncate(250)}",
                    Toast = true,
                    ShowConfirmButton = false,
                    Position = SweetAlertPosition.BottomRight,
                    Timer = 1750,
                    TimerProgressBar = true,
                    ShowCloseButton = false,
                });
            }

            return null;
        }

        public async Task<List<User>> FetchUsersAsync(List<string> userIds)
        {
            if (!userIds.Any()) return new List<User>();

            var usersResponse = await _http.PostAsJsonAsync("api/users/search", userIds);
            if (!usersResponse.IsSuccessStatusCode)
            {
                var exceptionDetails = await usersResponse.Content.ReadFromJsonAsync<ExceptionDetails>();
                if (exceptionDetails != null)
                {
                    Console.Error.WriteLine($"<b>{exceptionDetails.Title}</b>: {exceptionDetails.Detail.Truncate(250)}");

                    _ = _swal.FireAsync(new SweetAlertOptions
                    {
                        Icon = SweetAlertIcon.Error,
                        Title = "Failed to sync users",
                        //Html = $"<b>{exceptionDetails.Title}</b>: {exceptionDetails.Detail.Truncate(250)}",
                        Toast = true,
                        ShowConfirmButton = false,
                        Position = SweetAlertPosition.BottomRight,
                        Timer = 1750,
                        TimerProgressBar = true,
                        ShowCloseButton = false,
                    });
                }
            }

            return await usersResponse.Content.ReadFromJsonAsync<List<User>>();
        }

        public async Task<bool> UpdateDisplayName(string displayName)
        {
            var content = new StringContent(JsonSerializer.Serialize(new UserPatch { DisplayName = displayName }), Encoding.UTF8, "application/json");

            var response = await _http.PatchAsync("api/users", content);

            if (!response.IsSuccessStatusCode)
            {
                var exceptionDetails = await response.Content.ReadFromJsonAsync<ExceptionDetails>();
                if (exceptionDetails != null)
                {
                    Console.Error.WriteLine($"<b>{exceptionDetails.Title}</b>: {exceptionDetails.Detail.Truncate(250)}");

                    _ = _swal.FireAsync(new SweetAlertOptions
                    {
                        Icon = SweetAlertIcon.Error,
                        Title = "Failed update Display Name 😢",
                        //Html = $"<b>{exceptionDetails.Title}</b>: {exceptionDetails.Detail.Truncate(250)}",
                        Toast = true,
                        ShowConfirmButton = false,
                        Position = SweetAlertPosition.BottomRight,
                        Timer = 1750,
                        TimerProgressBar = true,
                        ShowCloseButton = false,
                    });
                }
            }

            return response.IsSuccessStatusCode;
        }

        public string GetUserName(string userId)
            => _store.Users.FirstOrDefault(x => x.Id == userId)?.DisplayName ?? $"Unknown Player ({userId})";
    }
}
