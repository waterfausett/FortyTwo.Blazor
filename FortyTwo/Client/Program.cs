using System;
using System.Net.Http;
using System.Threading.Tasks;
using CurrieTechnologies.Razor.SweetAlert2;
using FortyTwo.Client.Store;
using FortyTwo.Client.ViewModels;
using Microsoft.AspNetCore.Components.WebAssembly.Authentication;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
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
                options.ProviderOptions.DefaultScopes.Add(builder.Configuration["Auth0:ApiAudience"]);
            });

            builder.Services.AddApiAuthorization();

            builder.Services.AddHttpClient("API", client => client.BaseAddress = new Uri(builder.HostEnvironment.BaseAddress))
                .AddHttpMessageHandler(sp => sp.GetRequiredService<AuthorizationMessageHandler>()
                    .ConfigureHandler(
                        authorizedUrls: new[] { builder.HostEnvironment.BaseAddress })
                );

            builder.Services.AddTransient(sp => sp.GetRequiredService<IHttpClientFactory>().CreateClient("API"));

            builder.Services.AddOptions();
            builder.Services.AddAuthorizationCore();

            builder.Services.AddSweetAlert2();

            builder.Services.AddTransient<IDominoModel, DominoViewModel>();

            builder.Services.AddSingleton<IClientStore, ClientStore>();

            await builder.Build().RunAsync();
        }
    }
}
