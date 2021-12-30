using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.DTO
{
    public class Match
    {
        public Guid Id { get; set; }
        public List<Models.Player> Players { get; set; }
        public Game CurrentGame { get; set; } = new Game();
        public Dictionary<int, List<Game>> Games { get; set; } = new Dictionary<int, List<Game>>();
        public Dictionary<int, int> Scores { get; set; }
        public int? WinningTeamId { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }
    }
}
