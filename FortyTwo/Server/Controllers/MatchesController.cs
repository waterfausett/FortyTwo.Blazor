﻿using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;
using AutoMapper;
using FortyTwo.Server.Hubs;
using FortyTwo.Server.Services;
using FortyTwo.Shared.DTO;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class MatchesController : ControllerBase
    {
        private readonly ILogger<MatchesController> _logger;
        private readonly IMapper _mapper;
        private readonly IMatchService _matchService;
        private readonly IHubContext<GameHub> _gameHubContext;

        public MatchesController(ILogger<MatchesController> logger, IMapper mapper, IMatchService matchService, IHubContext<GameHub> gameHubContext)
        {
            _logger = logger;
            _mapper = mapper;
            _matchService = matchService;
            _gameHubContext = gameHubContext;
        }

        [HttpPost]
        public async Task<IActionResult> Post()
        {
            var match = await _matchService.CreateAsync();

            var matchDTO = _mapper.Map<Shared.DTO.Match>(match);

            await _gameHubContext.Clients.Group("matchmaking").SendAsync("OnMatchCreated", matchDTO);

            return Created($"/match/{match.Id}", matchDTO);
        }

        [HttpGet]
        public async Task<IActionResult> Get([FromQuery] MatchFilter filter)
        {
            var matches = await _matchService.FetchForUserAsync(filter);

            return Ok(_mapper.Map<List<Shared.DTO.Match>>(matches));
        }

        [HttpGet("{id}")]
        public async Task<IActionResult> Get([Required] Guid id)
        {
            var match = await _matchService.GetAsync(id);

            if (match == null)
            {
                return NotFound("Match not found!");
            }

            return Ok(_mapper.Map<Shared.DTO.Match>(match));
        }

        [HttpDelete("{id}")]
        public async Task<IActionResult> Delete(Guid id)
        {
            await _matchService.DeleteAsync(id);

            return Ok();
        }

        /*
        [HttpPost("{id}/automoves")]
        public async Task<IActionResult> PostAutoMove([Required] Guid id, [FromBody] Domino domino)
        {
            var match = await _matchService.GetAsync(id);
            var game = match.CurrentGame;

            // TODO: this should prolly be passed in w/ part of the request in the future
            // - at least the id
            var player = match.Players.First(x => x.Id == _userId);

            // TODO: validation (game rules)

            game.CurrentTrick.Dominos[0] = domino;
            game.Hands.First(x => x.PlayerId == _userId).Dominos.Remove(domino);

            // "computer moves" for now
            var teammate = match.Players.FirstOrDefault(x => x.Id != player.Id && x.Team == player.Team);
            var opponents = match.Players.Where(x => x.Team != player.Team).ToList();

            game.CurrentTrick.Dominos[1] = game.Hands.First(x => x.PlayerId == opponents[0].Id).Dominos.First();
            game.Hands.First(x => x.PlayerId == opponents[0].Id).Dominos.RemoveRange(0, 1);

            game.CurrentTrick.Dominos[2] = game.Hands.First(x => x.PlayerId == teammate.Id).Dominos.First();
            game.Hands.First(x => x.PlayerId == teammate.Id).Dominos.RemoveRange(0, 1);

            game.CurrentTrick.Dominos[3] = game.Hands.First(x => x.PlayerId == opponents[1].Id).Dominos.First();
            game.Hands.First(x => x.PlayerId == opponents[1].Id).Dominos.RemoveRange(0, 1);

            // trick is full - get ready for the next one

            // TODO: implement rules for winning the trick

            var rng = new Random();
            var winner = rng.Next(4);
            game.CurrentTrick.Team = match.Players[winner].Team;

            game.Tricks.Add(game.CurrentTrick);
            game.CurrentTrick = new Trick();

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            //return Ok(_mapper.Map<Shared.Models.DTO.Game>(match));
            return Ok();
        }
        */
    }
}
