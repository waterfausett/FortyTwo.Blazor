using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.DTO
{
    public class Match
    {
        public Guid Id { get; set; }
        public Dictionary<Models.Teams, List<Models.Player>> Teams { get; set; }
        public IReadOnlyList<Models.Player> Players => Teams.SelectMany(x => x.Value).ToList();
        public Game CurrentGame { get; set; } = new Game();
        public Dictionary<Models.Teams, List<Game>> Games { get; set; } = new Dictionary<Models.Teams, List<Game>>();
        public Dictionary<Models.Teams, int> Scores { get; set; }
        public Models.Teams? WinningTeam { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }
    }
}
