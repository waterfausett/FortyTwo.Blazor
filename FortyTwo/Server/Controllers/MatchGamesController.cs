using AutoMapper;
using FortyTwo.Server.Hubs;
using FortyTwo.Server.Services;
using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using System;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;

namespace FortyTwo.Server.Controllers
{
    [Route("api/matches/{id}/games")]
    [ApiController]
    public class MatchGamesController : ControllerBase
    {
        private readonly ILogger<MatchGamesController> _logger;
        private readonly IMapper _mapper;
        private readonly IMatchService _matchService;
        private readonly IHubContext<GameHub> _gameHubContext;

        public MatchGamesController(ILogger<MatchGamesController> logger, IMapper mapper, IMatchService matchService, IHubContext<GameHub> gameHubContext)
        {
            _logger = logger;
            _mapper = mapper;
            _matchService = matchService;
            _gameHubContext = gameHubContext;
        }

        [HttpPatch("current")]
        public async Task<IActionResult> Patch([Required] Guid id, [Required, FromBody] Suit suit)
        {
            var match = await _matchService.SetTrumpForCurrentGameAsync(id, suit);

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            return Ok();
        }

        [HttpPost("current/bids")]
        public async Task<IActionResult> PostBid([Required] Guid id, [Required, FromBody] Bid bid)
        {
            var match = await _matchService.BidAsync(id, bid);

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            return Ok();
        }

        [HttpPost("current/moves")]
        public async Task<IActionResult> PostMove([Required] Guid id, [Required, FromBody] Domino domino)
        {
            var match = await _matchService.PlayDominoAsync(id, domino);

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            if (match.CurrentGame.WinningTeam.HasValue)
            {
                var matchDTO = _mapper.Map<Shared.DTO.Match>(match);
                await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnMatchChanged", matchDTO);
            }

            return Ok();
        }
    }
}
