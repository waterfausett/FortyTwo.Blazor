using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

namespace FortyTwo.Server.Controllers
{
    [AllowAnonymous]
    [Route("appsettings")]
    [ApiController]
    public class AppSettingsController : ControllerBase
    {
        private readonly IConfiguration _configuration;

        public AppSettingsController(IConfiguration configuration)
        {
            _configuration = configuration;
        }

        [HttpGet]
        public IActionResult Get()
        {
            var appSettings = new
            {
                Auth0 = new
                {
                    ClientId = _configuration["Auth0:ClientId"],
                    Authority = _configuration["Auth0:Authority"],
                    ApiAudience = _configuration["Auth0:ApiAudience"]
                }
            };

            return Ok(appSettings);
        }
    }
}
