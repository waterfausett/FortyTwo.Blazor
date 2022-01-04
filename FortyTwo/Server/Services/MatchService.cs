using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using FortyTwo.Entity;
using FortyTwo.Entity.Models;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using FortyTwo.Shared.Services;
using Microsoft.EntityFrameworkCore;

namespace FortyTwo.Server.Services
{
    public class MatchService : IMatchService
    {
        private readonly DatabaseContext _context;
        private readonly UserId _userId;
        private readonly IDominoService _dominoService;

        public MatchService(DatabaseContext context, UserId user, IDominoService dominoService)
        {
            _context = context;
            _userId = user;
            _dominoService = dominoService;
        }

        public async Task<Match> CreateAsync()
        {
            var match = new Match();

            match.Players.Add(new MatchPlayer() { MatchId = match.Id, PlayerId = _userId, Position = Positions.First });

            match.CurrentGame.FirstActionBy = _userId;
            match.CurrentGame.CurrentPlayerId = _userId;

            match.CurrentGame.Hands.Add(new Hand() { PlayerId = _userId, Team = Teams.TeamA });

            _context.Matches.Add(match);

            await _context.SaveChangesAsync();

            return match;
        }

        public async Task<Match> AddPlayerAsync(Guid id, Player player)
        {
            var match = await _context.Matches.Include(x => x.Players).FirstAsync(x => x.Id == id);

            match.Players.Add(new MatchPlayer
            {
                MatchId = match.Id,
                PlayerId = player.Id,
                Position = player.Position,
            });


            match.CurrentGame.Hands.Add(new Hand() { PlayerId = _userId, Team = (int)player.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB });

            // if we have a full roster, setup the first game
            if (match.CurrentGame.Hands.Count == 4)
            {
                var dominos = _dominoService.InitDominos(DominoType.DoubleSix);

                // TODO: maybe make this even more random

                match.CurrentGame.Hands[0].Dominos = dominos.GetRange(0, 7);
                match.CurrentGame.Hands[1].Dominos = dominos.GetRange(7, 7);
                match.CurrentGame.Hands[2].Dominos = dominos.GetRange(14, 7);
                match.CurrentGame.Hands[3].Dominos = dominos.GetRange(21, 7);
            }

            await _context.SaveChangesAsync();

            return match;
        }

        public async Task<List<Match>> FetchForUserAsync(bool completed)
        {
            var matches = !completed
                ? await _context.Matches.Include(x => x.Players)
                    .Where(x => 
                        (x.Players.Any(p => p.PlayerId == _userId) || x.Players.Count < 4)
                        && !x.WinningTeam.HasValue)
                    .OrderByDescending(x => x.Players.Any(p => p.PlayerId == _userId))
                    .ThenByDescending(x => x.Players.Count == 4)
                    .ThenByDescending(x => x.UpdatedOn)
                    .ToListAsync()
                : await _context.Matches.Include(x => x.Players)
                    .Where(x =>
                        x.Players.Any(p => p.PlayerId == _userId)
                        && x.WinningTeam.HasValue)
                    .OrderByDescending(x => x.UpdatedOn)
                    .ToListAsync();

            return matches;
        }

        public Task<Match> GetAsync(Guid id)
        {
            return _context.Matches.Include(x => x.Players).Where(x => x.Id == id).FirstOrDefaultAsync();
        }
    }
}
