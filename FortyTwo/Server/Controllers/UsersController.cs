using FortyTwo.Server.Services;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models.Security;
using Microsoft.AspNetCore.Mvc;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class UsersController : ControllerBase
    {
        private readonly IAuth0ApiClient _apiClient;
        private readonly UserId _userId;

        public UsersController(IAuth0ApiClient apiClient, UserId userId)
        {
            _apiClient = apiClient;
            _userId = userId;
        }

        [HttpGet("profile")]
        public async Task<IActionResult> Profile()
        {
            var user = await _apiClient.GetUserAsync(_userId);

            return Ok(user);
        }

        [HttpGet]
        public async Task<IActionResult> Get()
        {
            var users = await _apiClient.GetUsersAsync();

            return Ok(users);
        }

        [HttpPost("search")]
        public async Task<IActionResult> Search(List<string> userIds)
        {
            var users = await _apiClient.GetUsersAsync(userIds);

            return Ok(users);
        }

        [HttpPatch]
        public async Task<IActionResult> Patch([Required, FromBody] UserPatch patch)
        {
            await _apiClient.UpdateUserAsync(_userId, patch);

            return Ok();
        }
    }
}
