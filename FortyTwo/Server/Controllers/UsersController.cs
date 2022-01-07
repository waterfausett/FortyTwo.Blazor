using FortyTwo.Server.Services;
using Microsoft.AspNetCore.Mvc;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class UsersController : ControllerBase
    {
        private readonly IAuth0ApiClient _apiClient;

        public UsersController(IAuth0ApiClient apiClient)
        {
            _apiClient = apiClient;
        }

        [HttpGet]
        public async Task<IActionResult> Get()
        {
            var users = await _apiClient.GetUsersAsync();

            return Ok(users);
        }

        [HttpPost]
        public async Task<IActionResult> Get(List<string> userIds)
        {
            var users = await _apiClient.GetUsersAsync(userIds);

            return Ok(users);

        }
    }
}
