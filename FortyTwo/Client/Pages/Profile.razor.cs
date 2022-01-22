using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Shared.DTO;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;

namespace FortyTwo.Client.Pages
{
    public partial class Profile
    {
        [Inject] public IUserService UserService { get; set; }
        [Inject] public SweetAlertService Swal { get; set; }
        [Inject] public IJSRuntime JSRuntime { get; set; }

        private bool IsLoading = true;
        private bool IsSaving;
        private User User;
        private ProfileModel ProfileModel = new ProfileModel();

        protected override async Task OnInitializedAsync()
        {
            await LoadDataAsync();
            await base.OnInitializedAsync();
        }

        private async Task LoadDataAsync()
        {
            IsLoading = true;

            try
            {
                User = await UserService.FetchProfileAsync();
                ProfileModel.DisplayName = User?.DisplayName;
            }
            finally
            {
                IsLoading = false;
            }
        }

        private async Task HandleValidSubmit()
        {
            IsSaving = true;
            try
            {
                if (string.IsNullOrWhiteSpace(ProfileModel?.DisplayName)) return;

                if (await UserService.UpdateDisplayName(ProfileModel.DisplayName))
                {
                    _ = Swal.FireAsync(new SweetAlertOptions
                    {
                        Toast = true,
                        Timer = 1750,
                        TimerProgressBar = true,
                        ShowCloseButton = false,
                        ShowConfirmButton = false,
                        Position = SweetAlertPosition.BottomRight,
                        Icon = SweetAlertIcon.Success,
                        Title = "Profile updated 🎈",
                        Width = "18rem"
                    });
                }
            }
            finally
            {
                IsSaving = false;
            }
        }
    }

    public class ProfileModel
    {
        [Required]
        [StringLength(20, ErrorMessage = "Display name is too long")]
        public string DisplayName { get; set; }
    }
}
