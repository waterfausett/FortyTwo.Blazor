using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;

namespace FortyTwo.Server.Services
{
    public class MatchService : IMatchService
    {
        private readonly UserId _userId;

        public MatchService(UserId user)
        {
            _userId = user;
        }

        public Task<Match> CreateAsync()
        {
            var match = new Match();

            match.Players.Add(new Player() { Id = _userId, TeamId = 1 });

            StaticMatches.Instance.Add(match);

            return Task.FromResult(match);
        }

        public Task<List<Match>> FetchForUserAsync()
        {
            var matches = StaticMatches.Instance
                .Where(x => 
                    x.Players.Any(p => p.Id == _userId))
                .ToList();

            // TODO: clean this mess up - just hard swapping for my userId for now
            //matches.ForEach(g => g.Players.Where(p => p.Id == "Id:Adam").ToList().ForEach(p => p.Id = (string)_userId));

            return Task.FromResult(matches);
        }
        public Task<List<Match>> FetchJoinableAsync()
        {
            var matches = StaticMatches.Instance
                .Where(x =>
                    x.Players.All(p => p.Id != _userId)
                    && x.Players.Count < 4)
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
                        new Match
                        {
                            Id = new Guid("ce8a4f47-d209-471c-b2c5-2574a67c8392"),
                            CurrentGame = new Game("Game 1")
                            {
                                Id = new Guid("2747a077-d51f-431f-bc97-4bcc14fe5b27"),
                                FirstActionBy = "Id:Adam",
                                CurrentPlayerId = "Id:Adam",
                                Hands = new List<Hand>
                                {
                                    new Hand
                                    {
                                        PlayerId = "Id:Adam",
                                        TeamId = 1,
                                    },
                                }
                            },
                            Players = new List<Player>
                            {
                                new Player
                                {
                                    Id = "Id:Adam",
                                    TeamId = 1,
                                },
                            },
                        }
                    };

                }

                return _matches;
            }
        }

        private static List<Domino> InitDominos()
        {
            var dominos = new List<Domino>();
            for (var i = 0; i < 7; ++i)
            {
                for (var j = i; j < 7; ++j)
                {
                    dominos.Add(new Domino(i, j));
                }
            }

            dominos.Shuffle();

            return dominos;
        }
    }
}
