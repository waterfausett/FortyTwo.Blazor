using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Extensions;

using FortyTwo.Shared.Models;

namespace FortyTwo.Server.Services
{
    public interface IGameService
    {
        Task<List<GameContext>> FetchGamesAsync();
        Task<GameContext> GetAsync(Guid id);
    }

    public class GameService : IGameService
    {
        private readonly List<Domino> _dominos;

        public GameService()
        {
            _dominos = InitDominos();
        }

        private List<Domino> InitDominos()
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

        public async Task<List<GameContext>> FetchGamesAsync()
        {
            return new List<GameContext>
            {
                new GameContext
                {
                    Id = Guid.NewGuid(),
                    Name = "Game 1",
                    Players = new List<Player>
                    {
                        new Player
                        {
                            Id = "Id:Luke",
                            Name = "Luke",
                            TeamId = new Guid("a58f497f-73fe-4a8b-9af4-a409ca385c66"),
                            IsActive = true,
                            Dominos = _dominos.GetRange(0, 7)
                        },
                        new Player
                        {
                            Id = "Id:Adam",
                            Name = "Adam",
                            TeamId = new Guid("bca0607d-013a-410d-bac2-90ce4fd78bfa"),
                            Dominos = _dominos.GetRange(7, 7)
                        },
                        new Player
                        {
                            Id = "Id:Sam",
                            Name = "Sam",
                            TeamId = new Guid("a58f497f-73fe-4a8b-9af4-a409ca385c66"),
                            Dominos = _dominos.GetRange(14, 7)
                        },
                        new Player
                        {
                            Id = "Id:Emily",
                            Name = "Emily",
                            TeamId = new Guid("bca0607d-013a-410d-bac2-90ce4fd78bfa"),
                            Dominos = _dominos.GetRange(21, 7)
                        },
                    },
                }
            };
        }

        public async Task<GameContext> GetAsync(Guid id)
        {
            return (await FetchGamesAsync())[0];
        }
    }
}
