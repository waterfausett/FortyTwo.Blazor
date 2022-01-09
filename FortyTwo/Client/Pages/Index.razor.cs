using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Authorization;
using System;
using System.Linq;
using System.Threading.Tasks;

namespace FortyTwo.Client.Pages
{
    public partial class Index
    {
        [Inject]
        public SweetAlertService Swal { get; set; }

        [Inject]
        public IMatchesViewModel Model { get; set; }

        [CascadingParameter]
        private Task<AuthenticationState> authenticationStateTask { get; set; }

        private System.Security.Claims.ClaimsPrincipal _user;

        protected override async Task OnInitializedAsync()
        {
            var authState = await authenticationStateTask;
            _user = authState.User;

            if (Model.Matches == null || !Model.Matches.Any())
            {
                await Model.FetchMatchesAsync();
            }
        }

        private async Task CreateMatchAsync()
        {
            var error = await Model.CreateMatchAsync();

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }

        private async Task DeleteMatchAsync(Guid id)
        {
            var error = await Model.DeleteMatchAsync(id);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }

        private async Task JoinMatchAsync(Guid matchId, Teams team)
        {
            var error = await Model.JoinMatchAsync(matchId, team);

            if (error != null)
            {
                await Swal.FireAsync(new SweetAlertOptions
                {
                    Icon = SweetAlertIcon.Error,
                    Title = error.Title,
                    Html = error.Detail.Truncate(250),
                    ConfirmButtonText = "Ok",
                });
            }
        }
    }
}
