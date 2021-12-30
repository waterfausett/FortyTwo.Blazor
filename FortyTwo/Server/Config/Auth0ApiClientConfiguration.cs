namespace FortyTwo.Server.Config
{
    internal class Auth0ApiClientConfiguration
    {
        public string ClientId { get; set; }
        public string ClientSecret { get; set; }
        public string Audience { get; set; }
        public string PublicOrigin { get; set; }
    }
}
