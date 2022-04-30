using AutoMapper;
using FortyTwo.Server.Hubs;
using FortyTwo.Server.Services;
using FortyTwo.Shared.DTO;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using System;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;

namespace FortyTwo.Server.Controllers
{
    [Route("api/matches/{id}/players")]
    [ApiController]
    public class MatchPlayersController : ControllerBase
    {
        private readonly ILogger<MatchPlayersController> _logger;
        private readonly IMapper _mapper;
        private readonly IMatchService _matchService;
        private readonly IHubContext<GameHub> _gameHubContext;

        public MatchPlayersController(ILogger<MatchPlayersController> logger, IMapper mapper, IMatchService matchService, IHubContext<GameHub> gameHubContext)
        {
            _logger = logger;
            _mapper = mapper;
            _matchService = matchService;
            _gameHubContext = gameHubContext;
        }


        [HttpPost("players")]
        public async Task<IActionResult> AddPlayer([Required] Guid id, [Required, FromBody] AddPlayerRequest request)
        {
            var match = await _matchService.AddPlayerAsync(id, request.Team);

            var matchDTO = _mapper.Map<Shared.DTO.Match>(match);
            await _gameHubContext.Clients.Group("matches-list").SendAsync("OnMatchChanged", matchDTO);

            return Ok(matchDTO);
        }

        [HttpGet("player")] // TODO: change this to /players (and maybe change the path?)
        public async Task<IActionResult> GetPlayer([Required] Guid id)
        {
            var player = await _matchService.GetPlayerForMatch(id);

            return Ok(player);
        }

        [HttpPatch("players")]
        public async Task<IActionResult> PatchPlayer([Required] Guid id, [Required, FromBody] PlayerPatchRequest request)
        {
            var match = await _matchService.PatchPlayerAsync(id, request);

            if (match != null)
            {
                var matchDTO = _mapper.Map<Shared.DTO.Match>(match);
                await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnMatchChanged", matchDTO);
            }

            return Ok();
        }
    }
}
