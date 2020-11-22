namespace FortyTwo.Client.Components.Models
{
    public enum ContextualClass
    {
        Light,
        Info,
        Warning,
        Success,
        Danger
    }

    public static class ContextualClassExtensions
    {
        public static string ToLower(this ContextualClass contextualClass)
            => contextualClass.ToString().ToLower();
    }
}
