using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using FortyTwo.Client.ViewModels;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.SignalR.Client;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace FortyTwo.Client.Pages
{
    public partial class Index
    {
        [Inject] public SweetAlertService Swal { get; set; }
        [Inject] public HubConnection HubConnection { get; set; }
        [Inject] public IClientStore Store { get; set; }
        [Inject] public IApiClient ApiClient { get; set; }

        [CascadingParameter] private Task<AuthenticationState> authenticationStateTask { get; set; }
        private System.Security.Claims.ClaimsPrincipal _user;

        public bool IsLoading { get; set; }
        public bool IsCreating { get; set; }
        public List<FortyTwo.Shared.DTO.Match> Matches
        {
            get => Store.Matches?.OrderByDescending(x => x.CreatedOn).ToList();
        }

        private MatchFilter _matchFilter;

        protected override async Task OnInitializedAsync()
        {
            var authState = await authenticationStateTask;
            _user = authState.User;

            if (Matches == null || !Matches.Any())
            {
                await FetchMatchesAsync();
            }

            HubConnection.On<FortyTwo.Shared.DTO.Match>("OnMatchChanged", (match) =>
            {
                Store.Matches.RemoveAll(x => x.Id == match.Id);
                Store.Matches.Add(match);

                StateHasChanged();
            });
        }

        public async Task FetchMatchesAsync(MatchFilter? matchFilter = null)
        {
            if (matchFilter.HasValue && _matchFilter == matchFilter) return;

            IsLoading = true;

            try
            {
                await ApiClient.FetchMatchesAsync(matchFilter);

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
