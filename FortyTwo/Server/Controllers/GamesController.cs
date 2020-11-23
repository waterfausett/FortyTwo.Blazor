using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using AutoMapper;
using FortyTwo.Server.Services;
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
    }
}
