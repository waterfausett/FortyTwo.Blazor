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
        private readonly IMatchValidationService _matchValidationService;
        private readonly IDominoService _dominoService;

        public MatchService(DatabaseContext context, UserId user, IMatchValidationService matchValidationService, IDominoService dominoService)
        {
            _context = context;
            _userId = user;
            _matchValidationService = matchValidationService;
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

        public async Task<Match> AddPlayerAsync(Guid id, Teams team)
        {
            var match = await _context.Matches.Include(x => x.Players).FirstAsync(x => x.Id == id);

            _matchValidationService
                .IsActive(match)
                .IsNotFull(match)
                .IsNotMatchPlayer(match, _userId);

            var teams = match.Players
                .GroupBy(x => (int)x.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB)
                .ToDictionary(k => k.Key, v => v.ToList());

            teams.TryGetValue(team, out var teammates);

            var teammatePosition = teammates?.FirstOrDefault()?.Position;

            var position = teammatePosition != null
                ? (Positions)(((int)teammatePosition + 2) % 4)
                : (int)teams[(team == Teams.TeamA ? Teams.TeamB : Teams.TeamA)].First().Position % 2 == 0
                    ? Positions.Second
                    : Positions.First;

            match.Players.Add(new MatchPlayer
            {
                MatchId = match.Id,
                PlayerId = _userId,
                Position = position,
            });


            // TODO: maybe split this last part out?

            match.CurrentGame.Hands.Add(new Hand() { PlayerId = _userId, Team = (int)position % 2 == 0 ? Teams.TeamA : Teams.TeamB });

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

        public async Task<Shared.DTO.LoggedInPlayer> GetPlayerForMatch(Guid id)
        {
            var match = await _context.Matches
                .Include(x => x.Players)
                .Where(x => x.Id == id)
                .FirstOrDefaultAsync();

            _matchValidationService
                .IsActive(match).IsActive(match.CurrentGame)
                .IsMatchPlayer(match, _userId);

            var matchPlayer = match.Players.First(x => x.PlayerId == _userId);

            return new Shared.DTO.LoggedInPlayer()
            {
                Id = matchPlayer.PlayerId,
                Team = (int)matchPlayer.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB,
                IsActive = match.CurrentGame.CurrentPlayerId == _userId,
                Dominos = match.CurrentGame.Hands.FirstOrDefault(x => x.PlayerId == _userId)?.Dominos,
                Bid = match.CurrentGame.Hands.FirstOrDefault(x => x.PlayerId == _userId)?.Bid
            };
        }

        public async Task<Match> BidAsync(Guid id, Bid bid)
        {
            var match = await _context.Matches
                .Include(x => x.Players)
                .Where(x => x.Id == id)
                .FirstOrDefaultAsync();

            _matchValidationService
                .IsActive(match).IsActive(match.CurrentGame)
                .IsActiveTurn(match.CurrentGame, _userId)
                .ValidateBid(match.CurrentGame, _userId, bid);

            match.CurrentGame.Hands.First(x => x.PlayerId == _userId).Bid = bid;

            if (bid != Bid.Pass)
            {
                match.CurrentGame.Bid = bid;
                match.CurrentGame.BiddingPlayerId = _userId;
            }

            // TODO: might be able to say, "if the person bidding is the one that shuffled, then we're done"

            if (match.CurrentGame.Hands.Any(x => !x.Bid.HasValue))
            {
                match.SelectNextPlayer();
            }
            else
            {
                match.CurrentGame.CurrentPlayerId = match.CurrentGame.BiddingPlayerId;
            }

            await _context.SaveChangesAsync();

            return match;
        }

        public async Task<Match> SetTrumpForCurrentGameAsync(Guid id, Suit suit)
        {
            var match = await _context.Matches.Include(x => x.Players).Where(x => x.Id == id).FirstOrDefaultAsync();

            _matchValidationService
                .IsActive(match)
                .IsActive(match.CurrentGame)
                .IsActiveTurn(match.CurrentGame, _userId)
                .BiddingComplete(match.CurrentGame)
                .IsActiveBidder(match.CurrentGame, _userId);

            match.CurrentGame.Trump ??= suit;

            await _context.SaveChangesAsync();

            return match;
        }

        public async Task<Match> PlayDominoAsync(Guid id, Domino domino)
        {
            var match = await _context.Matches
                .Include(x => x.Players)
                .Where(x => x.Id == id)
                .FirstOrDefaultAsync();

            _matchValidationService
                .IsActive(match)
                .IsActive(match.CurrentGame)
                .IsActiveTurn(match.CurrentGame, _userId)
                .IsReadyToPlay(match.CurrentGame)
                .HasDomino(match.CurrentGame, _userId, domino)
                .IsValidDomino(match.CurrentGame, _userId, domino);

            // TODO: figure out how we'll handle supporting low hands
            //  - possibly another enum entry for Low (-1)

            var player = match.Players.First(x => x.PlayerId == _userId);

            match.CurrentGame.Hands.First(x => x.PlayerId == _userId).Dominos.Remove(domino);

            // TODO: play the domino
            match.CurrentGame.CurrentTrick ??= new Trick();
            match.CurrentGame.CurrentTrick.AddDomino(domino, match.CurrentGame.Trump.Value);

            var currnetlyWinningDomino = match.CurrentGame.CurrentTrick.Dominos.Where(x => x != null)
                .OrderByDescending(x => x.GetSuitValue(match.CurrentGame.CurrentTrick.Suit.Value, match.CurrentGame.Trump.Value))
                .First();

            if (currnetlyWinningDomino.Equals(domino))
            {
                match.CurrentGame.CurrentTrick.PlayerId = _userId;
                match.CurrentGame.CurrentTrick.Team = (int)player.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB;
            }

            // TODO: trick is full - get ready for the next one

            if (match.CurrentGame.CurrentTrick.IsFull())
            {
                match.CurrentGame.Tricks.Add(match.CurrentGame.CurrentTrick);
                match.CurrentGame.CurrentPlayerId = match.CurrentGame.CurrentTrick.PlayerId;
                match.CurrentGame.CurrentTrick = new Trick();
            }
            else
            {
                match.SelectNextPlayer();
            }

            await _context.SaveChangesAsync();

            return match;
        }
    }
}
