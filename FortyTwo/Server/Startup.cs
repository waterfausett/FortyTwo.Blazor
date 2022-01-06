using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using System.Text.Json;
using AutoMapper;
using FortyTwo.Entity;
using FortyTwo.Server.AutoMapper;
using FortyTwo.Server.Config;
using FortyTwo.Server.Hubs;
using FortyTwo.Server.Middleware;
using FortyTwo.Server.Security;
using FortyTwo.Server.Services;
using FortyTwo.Server.Services.Security;
using FortyTwo.Shared.Models.Security;
using FortyTwo.Shared.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Authorization;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.Rewrite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.IdentityModel.Tokens;

namespace FortyTwo.Server
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            JwtSecurityTokenHandler.DefaultInboundClaimTypeMap.Clear();

            services.Configure<Auth0ApiClientConfiguration>(Configuration.GetSection("Auth0:ApiClient"));

            services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
            }).AddJwtBearer(options =>
            {
                options.Authority = Configuration["Auth0:Authority"];
                options.Audience = Configuration["Auth0:ApiAudience"];
            });

            services.AddAuthorization(options =>
            {
                options.AddPolicy(Policies.RequireAuthentication, policy => policy
                    .RequireAuthenticatedUser()
                );
            });
            
            services.AddHttpClient();

            services.AddSignalR();

            services
                .AddControllersWithViews(options =>
                {
                    options.Filters.Add(new AuthorizeFilter(Policies.RequireAuthentication));
                })
                .AddJsonOptions(options =>
                {
                    options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
                });

            services.AddRazorPages();

            services.AddResponseCompression(opts =>
            {
                opts.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
                    new[] { "application/octet-stream" });
            });

            services.AddSingleton(new MapperConfiguration(mc =>
            {
                mc.AddProfile(new MappingProfile());
                mc.AllowNullCollections = true;
            }).CreateMapper());

            services.AddHttpContextAccessor();

            services.AddScoped<UserId, HttpContextUserId>();

            services.AddScoped<IMatchService, MatchService>();
            services.AddScoped<IDominoService, DominoService>();

            services.AddSingleton<IAuth0AccessTokenProvider, Auth0AccessTokenProvider>();
            services.AddSingleton<IAuth0ApiClient, Auth0ApiClient>();

            services.AddScoped<IMatchValidationService, MatchValidationService>();

            services.AddScoped<DatabaseContext>();
        }

        // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseRewriter(new RewriteOptions()
                .AddRewrite(@"^appsettings\.json$", "appsettings", false)
            );

            app.UseResponseCompression();

            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
                app.UseWebAssemblyDebugging();
            }
            else
            {
                app.UseExceptionHandler("/Error");
                // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
                app.UseHsts();
            }

            app.UseGlobalErrorHandler(env.IsDevelopment());

            app.UseHttpsRedirection();
            app.UseBlazorFrameworkFiles();
            app.UseStaticFiles();

            app.UseRouting();

            app.UseAuthentication();
            app.UseAuthorization();

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapRazorPages();
                endpoints.MapControllers();
                endpoints.MapHub<GameHub>("/gamehub");
                endpoints.MapFallbackToFile("index.html");
            });
        }
    }
}
