using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.DTO;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
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
                User.UserMetadata.UseDarkTheme ??= await JSRuntime.InvokeAsync<bool>("getSystemPrefersDarkTheme");
                ProfileModel = ProfileModel.FromUser(User);
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
                if (await UserService.UpdateProfileAsync(ProfileModel))
                {
                    await JSRuntime.InvokeVoidAsync("setThemePreferences", ProfileModel.UseDarkTheme == true ? "dark-theme" : "light-theme");

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
}
