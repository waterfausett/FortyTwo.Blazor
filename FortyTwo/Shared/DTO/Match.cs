using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.DTO
{
    public class Match
    {
        public Guid Id { get; set; }
        public List<Models.Player> Players { get; set; }
        public Game CurrentGame { get; set; } = new Game();
        public Dictionary<Models.Teams, List<Game>> Games { get; set; } = new Dictionary<Models.Teams, List<Game>>();
        public Dictionary<Models.Teams, int> Scores { get; set; }
        public Models.Teams? WinningTeam { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }
    }
}
