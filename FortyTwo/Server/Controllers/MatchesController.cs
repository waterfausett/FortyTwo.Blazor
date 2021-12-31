using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Threading.Tasks;
using AutoMapper;
using FortyTwo.Server.Hubs;
using FortyTwo.Server.Services;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models.Security;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using PluralizeService.Core;

namespace FortyTwo.Server.Controllers
{
    //[AllowAnonymous]
    [Route("api/[controller]")]
    [ApiController]
    public class MatchesController : ControllerBase
    {
        private readonly ILogger<MatchesController> _logger;
        private readonly IMapper _mapper;
        private readonly UserId _userId;
        private readonly IMatchService _matchService;
        private readonly IHubContext<GameHub> _gameHubContext;

        public MatchesController(ILogger<MatchesController> logger, IMapper mapper, UserId userId, IMatchService matchService, IHubContext<GameHub> gameHubContext)
        {
            _logger = logger;
            _mapper = mapper;
            _userId = userId;
            _matchService = matchService;
            _gameHubContext = gameHubContext;
        }

        [HttpGet]
        public async Task<IActionResult> Get()
        {
            var matches = await _matchService.FetchForUserAsync();
            return Ok(_mapper.Map<List<Shared.DTO.Match>>(matches));
        }

        [HttpGet("joinable")]
        public async Task<IActionResult> GetJoinable()
        {
            var matches = await _matchService.FetchJoinableAsync();
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

        [HttpPost]
        public async Task<IActionResult> Post()
        {
            var match = await _matchService.CreateAsync();

            return Created($"/match/{match.Id}", _mapper.Map<Shared.DTO.Match>(match));
        }

        [HttpGet("{id}/player")]
        public async Task<IActionResult> GetPlayer([Required] Guid id)
        {
            var match = await _matchService.GetAsync(id);

            var player = new LoggedInPlayer(match.Players.First(x => x.Id == _userId))
            {
                IsActive = match.CurrentGame.CurrentPlayerId == _userId,
                Dominos = match.CurrentGame.Hands.First(x => x.PlayerId == _userId).Dominos,
                Bid = match.CurrentGame.Hands.First(x => x.PlayerId == _userId).Bid
            };

            return Ok(player);
        }

        [HttpPost("{id}/bids")]
        public async Task<IActionResult> PostBid([Required] Guid id, [FromBody] Bid bid)
        {
            var match = await _matchService.GetAsync(id);
            var game = match.CurrentGame;

            if (match == null)
            {
                return NotFound("Match not found!");
            }

            if (match.WinningTeamId != null)
            {
                return BadRequest("<h2>This game is over.</h2>");
            }

            if (game == null)
            {
                return NotFound("<h2>No active game found.</h2>");
            }

            if (game.CurrentPlayerId != _userId)
            {
                return BadRequest("<h2>It's not your turn!</h2>");
            }

            if (game.Hands.First(x => x.PlayerId != _userId).Bid.HasValue)
            {
                return BadRequest("<h2>You have already submitted a bid!</h2>");
            }

            if (bid != Bid.Pass && game.Bid.HasValue && game.Bid >= bid)
            {
                return BadRequest($"<h2>Insufficient bid!</h2><p>A new bid must be hight than the current bid of <code>{game.Bid.Value.ToPrettyString()}</code></p>");
            }

            game.Hands.First(x => x.PlayerId == _userId).Bid = bid;

            if (bid != Bid.Pass)
            {
                game.Bid = bid;
                game.BiddingPlayerId = _userId;
            }

            game.SelectNextPlayer();

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            //return Ok(gameDTO);
            return Ok();
        }

        [HttpPost("{id}/moves")]
        public async Task<IActionResult> PostMove([Required] Guid id, [FromBody] Domino domino)
        {
            var match = await _matchService.GetAsync(id);
            var game = match.CurrentGame;

            if (match == null)
            {
                return NotFound("Match not found!");
            }

            if (match.WinningTeamId != null)
            {
                return BadRequest("<h2>This game is over.</h2>");
            }

            if (game == null)
            {
                return NotFound("<h2>No active game found.</h2>");
            }

            if (game.CurrentPlayerId != _userId)
            {
                return BadRequest("<h2>It's not your turn!</h2>");
            }

            // Hack: testing validation
            game.Trump = Suit.Threes;

            // TODO: figure out how we'll handle supporting low hands
            //  - possibly another enum entry for Low (-1)
            if (!game.Trump.HasValue)
            {
                return BadRequest("<h2>Invalid move!</h2><p>We're still bidding&hellip;</p>");
            }

            var player = match.Players.First(x => x.Id == _userId);

            if (!game.Hands.First(x => x.PlayerId == _userId).Dominos.Contains(domino))
            {
                return BadRequest("<h2>Invalid domino!</h2>");
            }

            // TODO: validation (game rules)

            if (game.CurrentTrick.Suit.HasValue
                && !domino.IsOfSuit(game.CurrentTrick.Suit.Value, game.Trump)
                && game.Hands.First(x => x.PlayerId == _userId).Dominos.Any(x => x.IsOfSuit(game.CurrentTrick.Suit.Value, game.Trump)))
            {
                return BadRequest($"<h2>You must follow suit!</h2><p>If you have a <code>{PluralizationProvider.Singularize(game.CurrentTrick.Suit.ToString())}</code>, you must play it.</p>");
            }

            game.Hands.First(x => x.PlayerId == _userId).Dominos.Remove(domino);

            // TODO: play the domino
            game.CurrentTrick ??= new Trick();
            game.CurrentTrick.AddDomino(domino, game.Trump.Value);

            var currnetlyWinningDomino = game.CurrentTrick.Dominos.Where(x => x != null)
                .OrderByDescending(x => x.GetSuitValue(game.CurrentTrick.Suit.Value, game.Trump.Value))
                .First();

            if (currnetlyWinningDomino.Equals(domino))
            {
                game.CurrentTrick.PlayerId = _userId;
                game.CurrentTrick.TeamId = match.Players.First(x => x.Id == _userId).TeamId;
            }

            // TODO: trick is full - get ready for the next one
            
            if (game.CurrentTrick.IsFull())
            {
                game.Tricks.Add(game.CurrentTrick);
                game.CurrentTrick = new Trick();
            }

            game.SelectNextPlayer();

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);
            
            //return Ok(_mapper.Map<Shared.Models.DTO.Game>(match));
            return Ok();
        }

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
            var teammate = match.Players.FirstOrDefault(x => x.Id != player.Id && x.TeamId == player.TeamId);
            var opponents = match.Players.Where(x => x.TeamId != player.TeamId).ToList();

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
            game.CurrentTrick.TeamId = match.Players[winner].TeamId;

            game.Tricks.Add(game.CurrentTrick);
            game.CurrentTrick = new Trick();

            var gameDTO = _mapper.Map<Shared.DTO.Game>(match.CurrentGame);

            await _gameHubContext.Clients.Group(id.ToString()).SendAsync("OnGameChanged", gameDTO);

            //return Ok(_mapper.Map<Shared.Models.DTO.Game>(match));
            return Ok();
        }
    }
}
