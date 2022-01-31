using FortyTwo.Shared.DTO;
using System.ComponentModel.DataAnnotations;

namespace FortyTwo.Client.ViewModels
{
    public class ProfileModel
    {
        public static ProfileModel FromUser(User user)
            => new()
            {
                DisplayName = user?.DisplayName,
                UseDarkTheme = user?.UserMetadata.UseDarkTheme ?? false,
            };

        [Required]
        [StringLength(20, ErrorMessage = "Display name is too long")]
        public string DisplayName { get; set; }
        [Required]
        public bool UseDarkTheme { get; set; }
    }
}
