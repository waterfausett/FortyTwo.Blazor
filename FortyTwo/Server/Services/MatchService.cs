﻿using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;

namespace FortyTwo.Server.Services
{
    public class MatchService : IMatchService
    {
        private readonly UserId _user;

        public MatchService(UserId user)
        {
            _user = user;
        }

        public Task<Match> CreateAsync()
        {
            var match = new Match()
            {
                Players = new Player[4],
            };

            match.Players[0] = new Player() { Id = _user.GetUserId(), TeamId = 1 };

            StaticMatches.Instance.Add(match);

            return Task.FromResult(match);
        }

        public async Task<List<Match>> FetchAsync()
        {
            var matches = StaticMatches.Instance;

            // TODO: clean this mess up - just hard swapping for my userId for now
            //matches.ForEach(g => g.Players.Where(p => p.Id == "Id:Adam").ToList().ForEach(p => p.Id = (string)_userId));

            return matches;
        }

        public async Task<Match> GetAsync(Guid id)
        {
            return (await FetchAsync())[0];
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
                            Id = Guid.NewGuid(),
                            CurrentGame = new Game
                            {
                                Id = Guid.NewGuid(),
                                FirstActionBy = "Id:Adam",
                                CurrentPlayerId = "Id:Adam",
                                Hands = new List<Hand>
                                {
                                    new Hand
                                    {
                                        PlayerId = "Id:Jack",
                                        TeamId = 1,
                                        Dominos = dominos.GetRange(0, 7)
                                    },
                                    new Hand
                                    {
                                        PlayerId = "Id:Adam",
                                        TeamId = 2,
                                        Dominos = dominos.GetRange(7, 7),
                                    },
                                    new Hand
                                    {
                                        PlayerId = "Id:Jill",
                                        TeamId = 1,
                                        Dominos = dominos.GetRange(14, 7)
                                    },
                                    new Hand
                                    {
                                        PlayerId = "Id:Emily",
                                        TeamId = 2,
                                        Dominos = dominos.GetRange(21, 7)
                                    }
                                }
                            },
                            Players = new Player[4]
                            {
                                new Player
                                {
                                    Id = "Id:Jack",
                                    TeamId = 1,
                                },
                                new Player
                                {
                                    Id = "Id:Adam",
                                    TeamId = 2,
                                },
                                new Player
                                {
                                    Id = "Id:Jill",
                                    TeamId = 1,
                                },
                                new Player
                                {
                                    Id = "Id:Emily",
                                    TeamId = 2,
                                }
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
