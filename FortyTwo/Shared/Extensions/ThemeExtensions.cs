namespace FortyTwo.Shared.Extensions
{
    public static class ThemeExtensions
    {
        public static string ToPreferenceValue(this Theme? theme)
        {
            return theme switch
            {
                Theme.Dark => "dark-theme",
                Theme.Light => "light-theme",
                _ => null
            };
        }
    }

}
