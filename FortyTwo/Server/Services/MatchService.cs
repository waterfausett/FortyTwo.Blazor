using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using FortyTwo.Entity;
using FortyTwo.Shared.Extensions;
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

            match.Teams[Teams.TeamA].Add(new Player() { Id = _userId });

            match.CurrentGame.FirstActionBy = _userId;
            match.CurrentGame.CurrentPlayerId = _userId;

            match.CurrentGame.Hands.Add(new Hand() { PlayerId = _userId, Team = Teams.TeamA });

            StaticMatches.Instance.Add(match);

            var dbMatch = new Entity.Models.Match
            {
                Id = match.Id,
                CreatedOn = match.CreatedOn,
                UpdatedOn = match.UpdatedOn,
                CurrentGame = JsonSerializer.Serialize(match.CurrentGame),
                Games = JsonSerializer.Serialize(match.Games),
                Players = match.Players.OrderBy(x => x.Position).Select(x => new Entity.Models.MatchPlayer() { MatchId = match.Id, PlayerId = x.Id, Position = (int)x.Position }).ToList(),
            };

            _context.Matches.Add(dbMatch);
            await _context.SaveChangesAsync();

            return match;
        }

        public async Task<Match> AddPlayerAsync(Guid id, Player player)
        {
            var match = await _context.Matches.Include(x => x.Players).FirstAsync(x => x.Id == id);

            match.Players.Add(new Entity.Models.MatchPlayer
            {
                MatchId = match.Id,
                PlayerId = player.Id,
                Position = (int)player.Position,
            });

            var currentGame = JsonSerializer.Deserialize<Game>(match.CurrentGame);

            currentGame.Hands.Add(new Shared.Models.Hand() { PlayerId = _userId, Team = (int)player.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB });

            // if we have a full roster, setup the first game
            if (currentGame.Hands.Count == 4)
            {
                var dominos = _dominoService.InitDominos(DominoType.DoubleSix);

                // TODO: maybe make this even more random

                currentGame.Hands[0].Dominos = dominos.GetRange(0, 7);
                currentGame.Hands[1].Dominos = dominos.GetRange(7, 7);
                currentGame.Hands[2].Dominos = dominos.GetRange(14, 7);
                currentGame.Hands[3].Dominos = dominos.GetRange(21, 7);
            }

            await _context.SaveChangesAsync();

            return new Match(match.Id)
            {
                CreatedOn = match.CreatedOn,
                UpdatedOn = match.UpdatedOn,
                CurrentGame = currentGame,
                Games = JsonSerializer.Deserialize<Dictionary<Teams, List<Game>>>(match.Games),
                Teams = match.Players.GroupBy(x => x.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB).ToDictionary(x => x.Key, x => x.Select(p => new Player() { Id = p.PlayerId, Position = (Positions)p.Position }).ToList())
            };
        }

        public Task<List<Match>> FetchForUserAsync(bool completed)
        {
            var matches = !completed
                ? StaticMatches.Instance
                    .Where(x => 
                        (x.Players.Any(p => p.Id == _userId) || x.Players.Count < 4)
                        && !x.WinningTeam.HasValue)
                    .OrderByDescending(x => x.Players.Any(p => p.Id == _userId))
                    .ThenByDescending(x => x.Players.Count == 4)
                    .ThenByDescending(x => x.UpdatedOn)
                    .ToList()
                : StaticMatches.Instance
                    .Where(x =>
                        x.Players.Any(p => p.Id == _userId)
                        && x.WinningTeam.HasValue)
                    .OrderByDescending(x => x.UpdatedOn)
                    .ToList();

            // TODO: clean this mess up - just hard swapping for my userId for now
            //matches.ForEach(g => g.Players.Where(p => p.Id == "Id:Adam").ToList().ForEach(p => p.Id = (string)_userId));

            return Task.FromResult(matches);
        }

        public Task<Match> GetAsync(Guid id)
        {
            return Task.FromResult(StaticMatches.Instance
                .FirstOrDefault(x => x.Id == id));
        }
    }

    // TODO: temporary - will remove when we have persistance
    public class StaticMatches
    {
        private static List<Match> _matches;

        public static List<Match> Instance
        {
            get
            {
                if (_matches == null)
                {
                    var dominos = InitDominos();
                    _matches = new List<Match>
                    {
                        new Match(new Guid("ce8a4f47-d209-471c-b2c5-2574a67c8392"))
                        {
                            CurrentGame = new Game("Game 1")
                            {
                                Id = new Guid("2747a077-d51f-431f-bc97-4bcc14fe5b27"),
                                FirstActionBy = "Id:Jack",
                                CurrentPlayerId = "Id:Jack",
                                Hands = new List<Hand>
                                {
                                    new Hand
                                    {
                                        PlayerId = "Id:Jack",
                                        Team = Teams.TeamA,
                                    },
                                    new Hand
                                    {
                                        PlayerId = "Id:Jill",
                                        Team = Teams.TeamA,
                                    },
                                    new Hand
                                    {
                                        PlayerId = "Id:Emily",
                                        Team = Teams.TeamB,
                                    },
                                }
                            },
                            Teams = new Dictionary<Teams, List<Player>>()
                            {
                                {
                                    Teams.TeamA,
                                    new List<Player>
                                    {
                                        new Player
                                        {
                                            Id = "Id:Jack",
                                            Position = Positions.First
                                        },
                                        new Player
                                        {
                                            Id = "Id:Jill",
                                            Position = Positions.Third
                                        },
                                    }
                                },
                                {
                                    Teams.TeamB,
                                    new List<Player>
                                    {
                                        new Player
                                        {
                                            Id = "Id:Emily",
                                            Position = Positions.Second
                                        },
                                    }
                                }
                            }
                        }
                    };

                    //_matches.Clear();
                }


                return _matches;
            }
        }

        private static List<Domino> InitDominos()
        {
            var dominos = new List<Domino>();
            for (var i = 0; i <= 6; ++i)
            {
                for (var j = i; j <= 6; ++j)
                {
                    dominos.Add(new Domino(i, j));
                }
            }

            dominos.Shuffle();

            return dominos;
        }
    }
}
