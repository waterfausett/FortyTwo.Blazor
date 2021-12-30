using System.Collections.Generic;
using FortyTwo.Shared.Models;
using Game = FortyTwo.Shared.Models.DTO.Game;
using Match = FortyTwo.Shared.Models.DTO.Match;

namespace FortyTwo.Client.Store
{
    public interface IClientStore
    {
        public List<Domino> Dominos { get; set; }
        public List<Game> Games { get; set; }
        public List<Match> Matches { get; set; }
    }

    public class ClientStore : IClientStore
    {
        public List<Domino> Dominos { get; set; } = new List<Domino>();
        public List<Game> Games { get; set; } = new List<Game>();
        public List<Match> Matches { get; set; } = new List<Match>();
    }
}
