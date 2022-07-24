using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Extensions;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.JSInterop;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace FortyTwo.Client.Pages
{
    public partial class Index : IAsyncDisposable
    {
        [Inject] public SweetAlertService Swal { get; set; }
        [Inject] public HubConnection HubConnection { get; set; }
        [Inject] public IClientStore Store { get; set; }
        [Inject] public IApiClient ApiClient { get; set; }
        [Inject] public IUserService UserService { get; set; }
        [Inject] public IJSRuntime JSRuntime { get; set; }

        [CascadingParameter] private Task<AuthenticationState> authenticationStateTask { get; set; }
        private System.Security.Claims.ClaimsPrincipal _user;

        public bool IsLoading { get; set; }
        public bool IsCreating { get; set; }
        public List<FortyTwo.Shared.DTO.Match> Matches
        {
            get => Store.Matches?.Values
                .Where(x => _matchFilter switch
                {
                    FortyTwo.Shared.DTO.MatchFilter.Joinable => x.Players.Count < 4,
                    _ => true
                })
                .OrderByDescending(x => x.CreatedOn).ToList();
        }

        private FortyTwo.Shared.DTO.MatchFilter _matchFilter = FortyTwo.Shared.DTO.MatchFilter.Active;

        protected bool DarkThemeEnabled { get; set; }

        protected override async Task OnInitializedAsync()
        {
            var authState = await authenticationStateTask;
            _user = authState.User;

            // TODO: maybe should page this one day?
            await FetchMatchesAsync();

            DarkThemeEnabled = await JSRuntime.InvokeAsync<bool>("getUserPrefersDarkTheme");

            await RegisterSignalRAsync();
        }

        private async Task RegisterSignalRAsync()
        {
            await HubConnection.SendAsync("JoinGroupAsync", "matches-list");

            HubConnection.On<FortyTwo.Shared.DTO.Match>("OnMatchCreated", async (match) =>
            {
                await UserService.SyncUsersAsync(match.Players.Select(x => x.Id).ToList());

                Store.Matches.AddOrUpdate(match.Id, match, (_, __) => match);

                StateHasChanged();
            });
        }

        public async ValueTask DisposeAsync()
        {
            await HubConnection?.SendAsync("LeaveGroupAsync", "matches-list");
            await HubConnection?.SendAsync("LeaveGroupAsync", "matchmaking");
        }

        public async Task FetchMatchesAsync(FortyTwo.Shared.DTO.MatchFilter? matchFilter = null)
        {
            if (matchFilter.HasValue && _matchFilter == matchFilter) return;

            _matchFilter = matchFilter ?? _matchFilter;
            IsLoading = true;

            try
            {
                await HubConnection.SendAsync((_matchFilter == FortyTwo.Shared.DTO.MatchFilter.Joinable) ? "JoinGroupAsync" : "LeaveGroupAsync", "matchmaking");

                await ApiClient.FetchMatchesAsync(matchFilter ?? _matchFilter);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private async Task CreateMatchAsync()
        {
            IsCreating = true;

            try
            {
                await ApiClient.CreateMatchAsync();
            }
            finally
            {
                IsCreating = false;
            }
        }

        private Task DeleteMatchAsync(Guid id)
        {
            return ApiClient.DeleteMatchAsync(id);
        }

        private Task JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team)
        {
            return ApiClient.JoinMatchAsync(matchId, team);
        }
    }
}
