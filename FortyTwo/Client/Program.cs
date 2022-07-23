using System;
using System.Net.Http;
using System.Threading.Tasks;
using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Services;
using FortyTwo.Client.Store;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.WebAssembly.Authentication;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FortyTwo.Client
{
    public class Program
    {
        public static async Task Main(string[] args)
        {
            var builder = WebAssemblyHostBuilder.CreateDefault(args);
            builder.RootComponents.Add<App>("app");

            builder.Services.AddOidcAuthentication(options =>
            {
                builder.Configuration.Bind("Auth0", options.ProviderOptions);
                options.ProviderOptions.ResponseType = "code";
                options.ProviderOptions.DefaultScopes.Add("email");
                options.ProviderOptions.DefaultScopes.Add(builder.Configuration["Auth0_ApiAudience"]);
            });

            builder.Services.AddApiAuthorization();

            builder.Services.AddHttpClient("API", client => client.BaseAddress = new Uri(builder.HostEnvironment.BaseAddress))
                .AddHttpMessageHandler(sp => sp.GetRequiredService<AuthorizationMessageHandler>()
                    .ConfigureHandler(
                        authorizedUrls: new[] { builder.HostEnvironment.BaseAddress }
                    )
                );

            builder.Services.AddTransient(sp => sp.GetRequiredService<IHttpClientFactory>().CreateClient("API"));

            builder.Services.AddOptions();
            builder.Services.AddAuthorizationCore(options =>
            {
                options.DefaultPolicy = new AuthorizationPolicyBuilder()
                    .RequireAuthenticatedUser()
                    .Build();
            });

            builder.Services.AddSweetAlert2();

            builder.Services.AddSingleton<IClientStore, ClientStore>();
            builder.Services.AddScoped<IUserService, UserService>();

            builder.Services.AddSingleton<HubConnection>(s =>
            {
                var navManager = s.GetService<NavigationManager>();
                return new HubConnectionBuilder()
                    .WithUrl(navManager.ToAbsoluteUri("/gamehub"))
                    .Build();
            });

            builder.Services.AddScoped<IApiClient, ApiClient>();

            await builder.Build().RunAsync();
        }
    }
}
