using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using AutoMapper;
using FortyTwo.Shared.Models;
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

        public GamesController(ILogger<GamesController> logger, IMapper mapper)
        {
            _logger = logger;
            _mapper = mapper;
        }

        [HttpGet]
        public async Task<IActionResult> Get()
        {
            var _games = new List<GameContext>
            {
                new GameContext
                {
                    Id = Guid.NewGuid(),
                    Name = "Game 1",
                    Players = new List<Player>
                    {
                        new Player
                        {
                            Id = Guid.NewGuid(),
                            Name = "Luke",
                            TeamId = new Guid("a58f497f-73fe-4a8b-9af4-a409ca385c66"),
                            IsActive = true
                        },
                        new Player
                        {
                            Id = Guid.NewGuid(),
                            Name = "Adam",
                            TeamId = new Guid("bca0607d-013a-410d-bac2-90ce4fd78bfa"),
                            IsActive = true
                        },
                        new Player
                        {
                            Id = Guid.NewGuid(),
                            Name = "Sam",
                            TeamId = new Guid("a58f497f-73fe-4a8b-9af4-a409ca385c66"),
                            IsActive = true
                        },
                        new Player
                        {
                            Id = Guid.NewGuid(),
                            Name = "Emily",
                            TeamId = new Guid("bca0607d-013a-410d-bac2-90ce4fd78bfa"),
                            IsActive = true
                        },
                    },
                }
            };

            return Ok(_mapper.Map<List<Shared.Models.DTO.Game>>(_games));
        }
    }
}
