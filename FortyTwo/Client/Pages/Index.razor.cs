using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
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

        [CascadingParameter] private Task<AuthenticationState> authenticationStateTask { get; set; }
        private System.Security.Claims.ClaimsPrincipal _user;

        public bool IsLoading { get; set; }
        public bool IsCreating { get; set; }
        public List<FortyTwo.Shared.DTO.Match> Matches
        {
            get => Store.Matches?.OrderByDescending(x => x.CreatedOn).ToList();
        }

        private FortyTwo.Shared.DTO.MatchFilter _matchFilter = FortyTwo.Shared.DTO.MatchFilter.Active;

        protected override async Task OnInitializedAsync()
        {
            var authState = await authenticationStateTask;
            _user = authState.User;

            // TODO: maybe should page this one day?
            await FetchMatchesAsync();

            await RegisterSignalRAsync();
        }

        private async Task RegisterSignalRAsync()
        {
            await HubConnection.SendAsync("JoinGroupAsync", "matches-list");
        }

        public async ValueTask DisposeAsync()
        {
            await HubConnection?.SendAsync("LeaveGroupAsync", "matches-list");
        }

        public async Task FetchMatchesAsync(FortyTwo.Shared.DTO.MatchFilter? matchFilter = null)
        {
            if (matchFilter.HasValue && _matchFilter == matchFilter) return;

            IsLoading = true;

            try
            {
                await ApiClient.FetchMatchesAsync(matchFilter ?? _matchFilter);

                if (matchFilter.HasValue) _matchFilter = matchFilter.Value;
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
