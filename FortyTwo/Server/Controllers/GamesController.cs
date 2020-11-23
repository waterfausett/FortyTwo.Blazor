using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using AutoMapper;
using FortyTwo.Server.Services;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class GamesController : ControllerBase
    {
        private readonly ILogger<GamesController> _logger;
        private readonly IMapper _mapper;
        private readonly UserId _userId;
        private readonly IGameService _gameService;

        public GamesController(ILogger<GamesController> logger, IMapper mapper, UserId userId, IGameService gameService)
        {
            _logger = logger;
            _mapper = mapper;
            _userId = userId;
            _gameService = gameService;
        }

        [HttpGet]
        public async Task<IActionResult> Get()
        {
            return Ok(_mapper.Map<List<Shared.Models.DTO.Game>>(await _gameService.FetchGamesAsync()));
        }

        [HttpGet("{id}")]
        public async Task<IActionResult> Get(Guid id)
        {
            return Ok(_mapper.Map<Shared.Models.DTO.Game>(await _gameService.GetAsync(id)));
        }

        [HttpGet("players/{gameId}")]
        public async Task<IActionResult> GetPlayer(Guid gameId)
        {
            return Ok((await _gameService.GetAsync(gameId)).Players.First(x => x.Id == _userId));
        }

        [HttpPost("{id}/moves")]
        public async Task<IActionResult> PostMove(Guid gameId, Domino domino)
        {
            var game = await _gameService.GetAsync(gameId);

            // TODO: this should prolly be passed in w/ part of the request in the future
            // - at least the id
            var player = game.Players.First(x => x.Id == _userId);

            // TODO: validation (game rules)

            game.CurrentTrick.Dominos.Add(domino);
            player.Dominos.Remove(domino);

            // "computer moves" for now
            var teammate = game.Players.FirstOrDefault(x => x.Id != player.Id && x.TeamId == player.TeamId);
            var opponents = game.Players.Where(x => x.TeamId != player.TeamId).ToList();


            game.CurrentTrick.Dominos.Add(opponents.ElementAt(0).Dominos.First());
            opponents.ElementAt(0).Dominos.RemoveRange(0, 1);

            game.CurrentTrick.Dominos.Add(teammate.Dominos.First());
            teammate.Dominos.RemoveRange(0, 1);

            game.CurrentTrick.Dominos.Add(opponents.ElementAt(1).Dominos.First());
            opponents.ElementAt(1).Dominos.RemoveRange(0, 1);

            // trick is full - get ready for the next one

            var rng = new Random();
            var winner = rng.Next(4);

            game.Players[winner].Tricks.Add(game.CurrentTrick);
            game.CurrentTrick = new Trick();

            return Ok(_mapper.Map<Shared.Models.DTO.Game>(game));
        }
    }
}
